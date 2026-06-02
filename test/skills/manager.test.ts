import { assertEquals } from "jsr:@std/assert@1";

import { createSkillManager } from "../../src/agent/skills/mod.ts";

async function withWorkspace(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "deno-ai-agent-skills-" });
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

Deno.test("SkillManager discovers valid minimal skills", async () => {
  await withWorkspace(async (root) => {
    await writeSkill(
      root,
      "writer",
      [
        "---",
        "name: writer",
        "description: Writes concise release notes",
        "---",
        "# Writer",
        "",
        "Prefer short bullets.",
      ].join("\n"),
    );

    const manager = await createSkillManager({ root });

    assertEquals(manager.diagnostics(), []);
    assertEquals(manager.list(), [
      {
        name: "writer",
        description: "Writes concise release notes",
        filePath: `${root}/skills/writer/SKILL.md`,
        baseDir: `${root}/skills/writer`,
      },
    ]);
    assertEquals(manager.get("writer")?.body, "# Writer\n\nPrefer short bullets.");
  });
});

Deno.test("SkillManager parses optional frontmatter fields", async () => {
  await withWorkspace(async (root) => {
    await writeSkill(
      root,
      "reviewer",
      [
        "---",
        "name: reviewer",
        "description: Reviews code",
        "license: MIT",
        "compatibility: deno",
        "allowed-tools:",
        "  - read",
        "  - bash",
        "metadata:",
        "  author: Pat",
        '  version: "1.0"',
        "---",
        "Review carefully.",
      ].join("\n"),
    );

    const manager = await createSkillManager({ root });
    const skill = manager.get("reviewer");

    assertEquals(skill?.license, "MIT");
    assertEquals(skill?.compatibility, "deno");
    assertEquals(skill?.allowedTools, ["read", "bash"]);
    assertEquals(skill?.metadata, { author: "Pat", version: "1.0" });
  });
});

Deno.test("SkillManager returns an empty catalog when skills directory is missing", async () => {
  await withWorkspace(async (root) => {
    const manager = await createSkillManager({ root });

    assertEquals(manager.list(), []);
    assertEquals(manager.diagnostics(), []);
  });
});

Deno.test("SkillManager records diagnostics for unusable skills", async () => {
  await withWorkspace(async (root) => {
    await writeSkill(root, "bad-yaml", "---\nname: [\n---\nBody");
    await writeSkill(root, "invalid-name", "---\nname: bad name\ndescription: Bad name\n---\nBody");
    await writeSkill(root, "missing-description", "---\nname: no_description\n---\nBody");
    await writeSkill(root, "missing-frontmatter", "# No frontmatter");
    await writeSkill(root, "missing-name", "---\ndescription: No name\n---\nBody");

    const manager = await createSkillManager({ root });

    assertEquals(manager.list(), []);
    assertEquals(manager.diagnostics().map((diagnostic) => diagnostic.code).toSorted(), [
      "bad_yaml",
      "invalid_name",
      "missing_description",
      "missing_frontmatter",
      "missing_name",
    ]);
  });
});

Deno.test("SkillManager keeps the first sorted duplicate skill name", async () => {
  await withWorkspace(async (root) => {
    await writeSkill(root, "a-first", "---\nname: duplicate\ndescription: First\n---\nFirst body");
    await writeSkill(root, "z-second", "---\nname: duplicate\ndescription: Second\n---\nSecond body");

    const manager = await createSkillManager({ root });

    assertEquals(manager.get("duplicate")?.description, "First");
    assertEquals(manager.get("duplicate")?.body, "First body");
    assertEquals(manager.diagnostics().map((diagnostic) => diagnostic.code), ["duplicate_name"]);
  });
});

Deno.test("SkillManager supports CRLF frontmatter boundaries", async () => {
  await withWorkspace(async (root) => {
    await writeSkill(root, "crlf", "---\r\nname: crlf\r\ndescription: Handles CRLF\r\n---\r\nBody");

    const manager = await createSkillManager({ root });

    assertEquals(manager.get("crlf")?.body, "Body");
  });
});
