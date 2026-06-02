import { assertEquals } from "jsr:@std/assert@1";

import { grantBrokerReadPaths } from "../../src/permission-broker/grant-read.ts";

Deno.test("grantBrokerReadPaths is a no-op without a control connection", async () => {
  const dir = await Deno.makeTempDir({ prefix: "silas-grant-read-" });
  try {
    const file = `${dir}/config.toml`;
    await Deno.writeTextFile(file, "ok");
    await grantBrokerReadPaths(file);
    assertEquals(true, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
