import { tool } from "@lmstudio/sdk";
import * as path from "@std/path";
import { z } from "zod/v3";

import type { Skill, SkillDiagnostic, SkillManager, SkillSummary } from "../skills/mod.ts";
import { approveToolOperation, type ToolContext } from "./context.ts";

const RESOURCE_DIRS = ["assets", "references", "scripts"] as const;

function toPosixPath(value: string): string {
  return value.split(path.SEPARATOR).join("/");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function formatCatalog(skills: SkillSummary[]): string {
  if (skills.length === 0) return "(none)";
  return skills
    .map((skill) => `<skill name="${escapeXml(skill.name)}">${escapeXml(skill.description)}</skill>`)
    .join("\n");
}

function formatDiagnostics(diagnostics: SkillDiagnostic[]): string {
  if (diagnostics.length === 0) return "";
  return diagnostics
    .map((item) => {
      const pathText = item.filePath ? ` (${item.filePath})` : "";
      return `- ${item.code}${pathText}: ${item.message}`;
    })
    .join("\n");
}

function createDescription(manager: SkillManager): string {
  return [
    "Activate an AgentSkill by name when the task would benefit from its specialized instructions.",
    "Call this tool with exactly the skill name. After activation, follow the returned instructions and resolve any relative paths from the returned base directory.",
    "`allowed-tools` metadata is informational only and does not approve shell or file actions.",
    "",
    "<available_skills>",
    formatCatalog(manager.list()),
    "</available_skills>",
  ].join("\n");
}

async function listResourceFiles(baseDir: string, relativeDir: string): Promise<string[]> {
  const absoluteDir = path.join(baseDir, relativeDir);
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(absoluteDir));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }

  const nested = await Promise.all(entries.map((entry) => {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory) return listResourceFiles(baseDir, relativePath);
    if (entry.isFile || entry.isSymlink) return [toPosixPath(relativePath)];
    return [];
  }));
  return nested.flat();
}

async function listResources(skill: Skill): Promise<string[]> {
  const resources = await Promise.all(RESOURCE_DIRS.map((dir) => listResourceFiles(skill.baseDir, dir)));
  return resources.flat().toSorted((a, b) => a.localeCompare(b));
}

function formatResourceListing(resources: string[]): string {
  if (resources.length === 0) return "(none)";
  return resources.map((resource) => `- ${resource}`).join("\n");
}

async function formatSkillActivation(skill: Skill, ctx?: ToolContext): Promise<string> {
  if (ctx) {
    await approveToolOperation(ctx, {
      operation: "skill",
      target: ctx.sandbox.displayPath(skill.filePath),
      risk: "low",
      summary: `activate skill ${skill.name}`,
    });
  }
  const resources = await listResources(skill);
  return [
    `<skill_content name="${escapeXml(skill.name)}">`,
    `Skill: ${skill.name}`,
    `Base directory: ${skill.baseDir}`,
    "Resolve relative paths from this base directory.",
    "",
    "Instructions:",
    skill.body,
    "",
    "Resources:",
    formatResourceListing(resources),
    "</skill_content>",
  ].join("\n");
}

function missingSkillMessage(manager: SkillManager, name: string): string {
  const names = manager.list().map((skill) => skill.name);
  const diagnostics = formatDiagnostics(manager.diagnostics());
  const diagnosticText = diagnostics ? `\n\nSkill diagnostics:\n${diagnostics}` : "";
  if (names.length === 0) return `No skills are available.${diagnosticText}`;
  return `Unknown skill: ${name}\nAvailable skills: ${names.join(", ")}${diagnosticText}`;
}

/** LM Studio tool that activates a discovered AgentSkill. */
export function createSkillTool(manager: SkillManager, ctx?: ToolContext): unknown {
  return tool({
    name: "skill",
    description: createDescription(manager),
    parameters: {
      skill: z.string().describe("Name of the AgentSkill to activate"),
    },
    implementation: ({ skill: name }) => {
      const skill = manager.get(name);
      if (!skill) throw new Error(missingSkillMessage(manager, name));
      return formatSkillActivation(skill, ctx);
    },
  });
}
