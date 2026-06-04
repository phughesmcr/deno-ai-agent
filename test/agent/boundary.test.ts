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

Deno.test("src/agent does not import Telegram", async () => {
  const root = path.resolve("src/agent");
  const offenders: string[] = [];

  await Promise.all((await collectTsFiles(root)).map(async (file) => {
    const text = await Deno.readTextFile(file);
    if (text.includes('"grammy"') || text.includes('"grammy-questions"') || text.includes("/telegram/")) {
      offenders.push(path.relative(Deno.cwd(), file));
    }
  }));

  assertEquals(offenders, []);
});
