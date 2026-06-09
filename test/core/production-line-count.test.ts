import { assertEquals } from "jsr:@std/assert@1";
import { join } from "@std/path";

const MAX_PRODUCTION_LINES = 1_000;

async function productionFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      files.push(...await productionFiles(path));
      continue;
    }
    if (entry.isFile && path.endsWith(".ts")) files.push(path);
  }
  return files;
}

async function lineCount(path: string): Promise<number> {
  return (await Deno.readTextFile(path)).split("\n").length;
}

Deno.test("production TypeScript files stay under 1,000 lines", async () => {
  const tooLarge: string[] = [];
  for (const file of await productionFiles("src")) {
    const lines = await lineCount(file);
    if (lines > MAX_PRODUCTION_LINES) tooLarge.push(`${file}: ${lines}`);
  }

  assertEquals(tooLarge, []);
});
