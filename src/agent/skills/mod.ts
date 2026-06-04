import { extractYaml } from "@std/front-matter";
import * as path from "@std/path";
import { z } from "zod/v3";

const SKILL_FILE_NAME = "SKILL.md";
const SKILLS_DIR_NAME = "skills";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const skillFrontmatterSchema = z.object({
  "name": z.string().trim().min(1),
  "description": z.string().trim().min(1),
  "license": z.preprocess((value) => typeof value === "string" ? value : undefined, z.string().optional()),
  "compatibility": z.preprocess((value) => typeof value === "string" ? value : undefined, z.string().optional()),
  "metadata": z.preprocess((value) => isRecord(value) ? value : undefined, z.record(z.unknown()).optional()),
  "allowed-tools": z.preprocess((value) => {
    if (typeof value === "string") return [value];
    if (!Array.isArray(value)) return undefined;
    return value.every((item) => typeof item === "string") ? value : undefined;
  }, z.array(z.string()).optional()),
}).passthrough();

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
  if (!text.startsWith("---")) {
    return diagnostic("missing_frontmatter", "SKILL.md must start with YAML frontmatter.", filePath);
  }

  let extracted: { attrs: unknown; body: string };
  try {
    extracted = extractYaml(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return diagnostic("bad_yaml", `Could not parse skill frontmatter: ${message}`, filePath);
  }

  if (!isRecord(extracted.attrs)) {
    return diagnostic("bad_yaml", "Skill frontmatter must be a YAML object.", filePath);
  }

  const parsed = skillFrontmatterSchema.safeParse(extracted.attrs);
  const nameValue = extracted.attrs["name"];
  const name = typeof nameValue === "string" ? nameValue.trim() : undefined;
  if (!name) return diagnostic("missing_name", "Skill frontmatter must include a non-empty name.", filePath);
  if (!SKILL_NAME_PATTERN.test(name)) {
    return diagnostic(
      "invalid_name",
      "Skill name must contain only letters, numbers, underscores, and hyphens.",
      filePath,
      name,
    );
  }

  if (!parsed.success) {
    return diagnostic("missing_description", "Skill frontmatter must include a non-empty description.", filePath, name);
  }

  const attrs = parsed.data;
  const description = attrs.description;
  const skill: Skill = {
    name,
    description,
    filePath,
    baseDir,
    body: extracted.body.replace(/\r\n/g, "\n").trim(),
  };

  if (attrs.license !== undefined) skill.license = attrs.license;
  if (attrs.compatibility !== undefined) skill.compatibility = attrs.compatibility;
  if (attrs.metadata !== undefined) skill.metadata = attrs.metadata;
  if (attrs["allowed-tools"] !== undefined) skill.allowedTools = attrs["allowed-tools"];

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
