import { walk } from "@std/fs";
import * as path from "@std/path";
import { assertEquals } from "jsr:@std/assert@1";

async function collectTsFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of walk(dir, { exts: [".ts"], includeDirs: false })) {
    if (entry.isFile) files.push(entry.path);
  }
  return files;
}

Deno.test("src/core does not import from src/agent", async () => {
  const root = path.resolve("src/core");
  const offenders: string[] = [];
  const agentImport = /\bfrom\s+["']\.\.\/agent\//;

  await Promise.all((await collectTsFiles(root)).map(async (file) => {
    const text = await Deno.readTextFile(file);
    if (agentImport.test(text)) offenders.push(path.relative(Deno.cwd(), file));
  }));

  assertEquals(offenders, []);
});
