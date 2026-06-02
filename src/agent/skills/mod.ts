import * as path from "@std/path";
import { parse } from "@std/yaml";

const SKILL_FILE_NAME = "SKILL.md";
const SKILLS_DIR_NAME = "skills";
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const SKILL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Public metadata for a discovered AgentSkill. */
export interface SkillSummary {
  /** Model-facing skill name from frontmatter. */
  name: string;
  /** Model-facing skill description from frontmatter. */
  description: string;
  /** Optional license metadata from frontmatter. */
  license?: string;
  /** Optional compatibility metadata from frontmatter. */
  compatibility?: string;
  /** Optional free-form metadata from frontmatter. */
  metadata?: Record<string, unknown>;
  /** Optional allowed-tools metadata. Informational only. */
  allowedTools?: string[];
  /** Absolute path to this skill's `SKILL.md`. */
  filePath: string;
  /** Absolute base directory for resolving skill-relative resources. */
  baseDir: string;
}

/** Full discovered AgentSkill, including markdown body. */
export interface Skill extends SkillSummary {
  /** Markdown instructions after frontmatter. */
  body: string;
}

/** Diagnostic recorded for skipped or shadowed skills. */
export interface SkillDiagnostic {
  /** Stable diagnostic code. */
  code: string;
  /** Human-readable detail. */
  message: string;
  /** Path associated with the diagnostic, when known. */
  filePath?: string;
  /** Skill name associated with the diagnostic, when known. */
  skillName?: string;
}

/** Options for creating a workspace-root skill manager. */
export interface CreateSkillManagerOptions {
  /** Absolute or relative workspace root. */
  root: string;
}

type Frontmatter = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(frontmatter: Frontmatter, key: string): string | undefined {
  const value = frontmatter[key];
  return typeof value === "string" ? value.trim() : undefined;
}

function optionalStringField(frontmatter: Frontmatter, key: string): string | undefined {
  const value = frontmatter[key];
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : undefined;
}

function optionalStringList(frontmatter: Frontmatter, key: string): string[] | undefined {
  const value = frontmatter[key];
  if (value === undefined) return undefined;
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length === value.length ? strings : undefined;
}

function toSummary(skill: Skill): SkillSummary {
  const summary: SkillSummary = {
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    baseDir: skill.baseDir,
  };
  if (skill.license !== undefined) summary.license = skill.license;
  if (skill.compatibility !== undefined) summary.compatibility = skill.compatibility;
  if (skill.metadata !== undefined) summary.metadata = skill.metadata;
  if (skill.allowedTools !== undefined) summary.allowedTools = skill.allowedTools;
  return summary;
}

function diagnostic(code: string, message: string, filePath?: string, skillName?: string): SkillDiagnostic {
  const result: SkillDiagnostic = { code, message };
  if (filePath !== undefined) result.filePath = filePath;
  if (skillName !== undefined) result.skillName = skillName;
  return result;
}

function parseSkillFile(filePath: string, baseDir: string, text: string): Skill | SkillDiagnostic {
  const match = FRONTMATTER_PATTERN.exec(text);
  if (!match) {
    return diagnostic("missing_frontmatter", "SKILL.md must start with YAML frontmatter.", filePath);
  }

  const yamlText = match[1] ?? "";
  let parsed: unknown;
  try {
    parsed = parse(yamlText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return diagnostic("bad_yaml", `Could not parse skill frontmatter: ${message}`, filePath);
  }

  if (!isRecord(parsed)) {
    return diagnostic("bad_yaml", "Skill frontmatter must be a YAML object.", filePath);
  }

  const name = stringField(parsed, "name");
  if (!name) return diagnostic("missing_name", "Skill frontmatter must include a non-empty name.", filePath);
  if (!SKILL_NAME_PATTERN.test(name)) {
    return diagnostic(
      "invalid_name",
      "Skill name must contain only letters, numbers, underscores, and hyphens.",
      filePath,
      name,
    );
  }

  const description = stringField(parsed, "description");
  if (!description) {
    return diagnostic("missing_description", "Skill frontmatter must include a non-empty description.", filePath, name);
  }

  const metadata = parsed["metadata"];
  const skill: Skill = {
    name,
    description,
    filePath,
    baseDir,
    body: text.slice(match[0].length).replace(/\r\n/g, "\n").trim(),
  };

  const license = optionalStringField(parsed, "license");
  if (license !== undefined) skill.license = license;
  const compatibility = optionalStringField(parsed, "compatibility");
  if (compatibility !== undefined) skill.compatibility = compatibility;
  if (isRecord(metadata)) skill.metadata = metadata;
  const allowedTools = optionalStringList(parsed, "allowed-tools");
  if (allowedTools !== undefined) skill.allowedTools = allowedTools;

  return skill;
}

async function directSkillDirs(skillsDir: string): Promise<string[]> {
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(skillsDir));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory)
    .map((entry) => entry.name)
    .toSorted((a, b) => a.localeCompare(b));
}

/** Discovers AgentSkills under a workspace `skills/` directory. */
export class SkillManager {
  readonly #root: string;
  #skills = new Map<string, Skill>();
  #diagnostics: SkillDiagnostic[] = [];

  /** Creates a manager for a workspace root. Call `refresh()` before reading the catalog. */
  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  /** Workspace root used for discovery. */
  get root(): string {
    return this.#root;
  }

  /** Re-scans direct child skill directories under `${root}/skills`. */
  async refresh(): Promise<void> {
    const skills = new Map<string, Skill>();
    const diagnostics: SkillDiagnostic[] = [];
    const skillsDir = path.join(this.#root, SKILLS_DIR_NAME);
    const dirNames = await directSkillDirs(skillsDir);

    const parsed = await Promise.all(dirNames.map(async (dirName) => {
      const baseDir = path.join(skillsDir, dirName);
      const filePath = path.join(baseDir, SKILL_FILE_NAME);
      let text: string;
      try {
        text = await Deno.readTextFile(filePath);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return undefined;
        throw error;
      }
      return parseSkillFile(filePath, baseDir, text);
    }));

    for (const result of parsed) {
      if (result === undefined) continue;
      if ("code" in result) {
        diagnostics.push(result);
        continue;
      }
      if (skills.has(result.name)) {
        diagnostics.push(diagnostic(
          "duplicate_name",
          `Skill "${result.name}" is shadowed by an earlier sorted skill directory.`,
          result.filePath,
          result.name,
        ));
        continue;
      }
      skills.set(result.name, result);
    }

    this.#skills = skills;
    this.#diagnostics = diagnostics;
  }

  /** Returns model-visible skill summaries. */
  list(): SkillSummary[] {
    return [...this.#skills.values()].map(toSummary);
  }

  /** Returns a discovered skill by name. */
  get(name: string): Skill | undefined {
    return this.#skills.get(name);
  }

  /** Returns diagnostics from the most recent refresh. */
  diagnostics(): SkillDiagnostic[] {
    return [...this.#diagnostics];
  }
}

/** Creates and refreshes a workspace-root skill manager. */
export async function createSkillManager(options: CreateSkillManagerOptions): Promise<SkillManager> {
  const manager = new SkillManager(options.root);
  await manager.refresh();
  return manager;
}
