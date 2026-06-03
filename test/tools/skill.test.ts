import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import { createSkillManager } from "../../src/agent/skills/mod.ts";
import { createSkillTool } from "../../src/agent/tools/skill.ts";
import { runTool, runToolImplementationThrows } from "./helpers.ts";

async function withWorkspace(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "deno-ai-agent-skill-tool-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function writeSkill(root: string, dirName: string, content: string): Promise<void> {
  const dir = `${root}/skills/${dirName}`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/SKILL.md`, content);
}

Deno.test("skill tool description includes escaped available skills", async () => {
  await withWorkspace(async (root) => {
    await writeSkill(root, "docs", "---\nname: docs\ndescription: Build <docs> & examples\n---\nBody");
    const manager = await createSkillManager({ root });
    const skillTool = createSkillTool(manager) as { description: string; name: string };

    assertEquals(skillTool.name, "skill");
    assertStringIncludes(skillTool.description, "<available_skills>");
    assertStringIncludes(skillTool.description, 'name="docs"');
    assertStringIncludes(skillTool.description, "Build &lt;docs&gt; &amp; examples");
  });
});

Deno.test("skill tool activation returns wrapped body, base directory, and resource listing", async () => {
  await withWorkspace(async (root) => {
    await writeSkill(
      root,
      "docs",
      [
        "---",
        "name: docs",
        "description: Build docs",
        "---",
        "# Docs Skill",
        "",
        "Use `references/guide.md` when needed.",
      ].join("\n"),
    );
    await Deno.mkdir(`${root}/skills/docs/references`, { recursive: true });
    await Deno.mkdir(`${root}/skills/docs/scripts`, { recursive: true });
    await Deno.mkdir(`${root}/skills/docs/assets`, { recursive: true });
    await Deno.writeTextFile(`${root}/skills/docs/references/guide.md`, "SECRET REFERENCE CONTENT");
    await Deno.writeTextFile(`${root}/skills/docs/scripts/build.ts`, "console.log('secret script');");
    await Deno.writeTextFile(`${root}/skills/docs/assets/icon.png`, "fake image");

    const manager = await createSkillManager({ root });
    const output = await runTool(createSkillTool(manager), { skill: "docs" });

    assertStringIncludes(output, '<skill_content name="docs">');
    assertStringIncludes(output, `Base directory: ${root}/skills/docs`);
    assertStringIncludes(output, "Resolve relative paths from this base directory.");
    assertStringIncludes(output, "# Docs Skill");
    assertStringIncludes(output, "- assets/icon.png");
    assertStringIncludes(output, "- references/guide.md");
    assertStringIncludes(output, "- scripts/build.ts");
    assertEquals(output.includes("SECRET REFERENCE CONTENT"), false);
    assertEquals(output.includes("secret script"), false);
  });
});

Deno.test("skill tool lists sibling markdown files as resources", async () => {
  await withWorkspace(async (root) => {
    await writeSkill(root, "grill", "---\nname: grill\ndescription: Grill\n---\nBody");
    await Deno.writeTextFile(`${root}/skills/grill/CONTEXT-FORMAT.md`, "# Context");
    await Deno.writeTextFile(`${root}/skills/grill/ADR-FORMAT.md`, "# ADR");

    const manager = await createSkillManager({ root });
    const output = await runTool(createSkillTool(manager), { skill: "grill" });

    assertStringIncludes(output, "- ADR-FORMAT.md");
    assertStringIncludes(output, "- CONTEXT-FORMAT.md");
    assertEquals(output.includes("# Context"), false);
  });
});

Deno.test("skill tool reports available names for unknown skills", async () => {
  await withWorkspace(async (root) => {
    await writeSkill(root, "docs", "---\nname: docs\ndescription: Build docs\n---\nBody");
    const manager = await createSkillManager({ root });
    const error = await runToolImplementationThrows(createSkillTool(manager), { skill: "missing" });

    assertStringIncludes(error.message, "Unknown skill: missing");
    assertStringIncludes(error.message, "Available skills: docs");
  });
});

Deno.test("skill tool has stable empty-catalog behavior", async () => {
  await withWorkspace(async (root) => {
    const manager = await createSkillManager({ root });
    const skillTool = createSkillTool(manager) as { description: string };
    const error = await runToolImplementationThrows(skillTool, { skill: "anything" });

    assertStringIncludes(skillTool.description, "(none)");
    assertStringIncludes(error.message, "No skills are available.");
  });
});
