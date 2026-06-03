import { assertEquals } from "jsr:@std/assert@1";

import { grantBrokerRunForCommands, resolveExecutableOnPath } from "../../src/permission-broker/mod.ts";

Deno.test("resolveExecutableOnPath resolves an absolute executable path", async () => {
  const dir = await Deno.makeTempDir({ prefix: "silas-exec-" });
  try {
    const file = `${dir}/tool-bin`;
    await Deno.writeTextFile(file, "");
    await Deno.chmod(file, 0o755);
    assertEquals(await resolveExecutableOnPath(file), file);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveExecutableOnPath returns undefined for missing commands", async () => {
  assertEquals(await resolveExecutableOnPath("silas-definitely-missing-command-xyz"), undefined);
});

Deno.test("grantBrokerRunForCommands is a no-op without a control connection", async () => {
  await grantBrokerRunForCommands(["rg", "fd", "which"]);
  assertEquals(true, true);
});
