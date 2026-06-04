import { assertEquals } from "jsr:@std/assert@1";
import { walk } from "@std/fs";
import * as path from "@std/path";

async function collectTsFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of walk(dir, { exts: [".ts"], includeDirs: false })) {
    if (entry.isFile) {
      files.push(entry.path);
    }
  }
  return files;
}

Deno.test("src/permission-broker does not use upward relative imports", async () => {
  const root = path.resolve("src/permission-broker");
  const offenders: string[] = [];
  const upwardImport = /\bfrom\s+["']\.\.\/|import\s*["']\.\.\//;

  await Promise.all((await collectTsFiles(root)).map(async (file) => {
    const text = await Deno.readTextFile(file);
    if (upwardImport.test(text)) offenders.push(path.relative(Deno.cwd(), file));
  }));

  assertEquals(offenders, []);
});
