import { assertEquals } from "jsr:@std/assert@1/equals";
import { readBootstrapIfPresent } from "../src/agent/workspace.ts";

Deno.test("readBootstrapIfPresent returns null when file is missing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "deno-ai-agent-bootstrap-" });
  assertEquals(await readBootstrapIfPresent(dir), null);
});

Deno.test("readBootstrapIfPresent returns null for empty or whitespace-only file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "deno-ai-agent-bootstrap-" });
  await Deno.writeTextFile(`${dir}/BOOTSTRAP.md`, "");
  assertEquals(await readBootstrapIfPresent(dir), null);

  await Deno.writeTextFile(`${dir}/BOOTSTRAP.md`, "  \n\t  ");
  assertEquals(await readBootstrapIfPresent(dir), null);
});

Deno.test("readBootstrapIfPresent returns file contents when non-empty", async () => {
  const dir = await Deno.makeTempDir({ prefix: "deno-ai-agent-bootstrap-" });
  const content = "  Hey. I just came online.\n";
  await Deno.writeTextFile(`${dir}/BOOTSTRAP.md`, content);
  assertEquals(await readBootstrapIfPresent(dir), content);
});
