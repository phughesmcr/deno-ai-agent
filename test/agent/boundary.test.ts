import { assertEquals } from "jsr:@std/assert@1";
import * as path from "@std/path";

Deno.test("src/tools does not import Telegram-specific packages", async () => {
  const root = path.resolve("src/tools");
  const offenders: string[] = [];

  async function walk(dir: string): Promise<void> {
    for await (const entry of Deno.readDir(dir)) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
      const text = await Deno.readTextFile(absolutePath);
      if (text.includes('"grammy"') || text.includes('"grammy-questions"')) {
        offenders.push(path.relative(Deno.cwd(), absolutePath));
      }
    }
  }

  await walk(root);

  assertEquals(offenders, []);
});
