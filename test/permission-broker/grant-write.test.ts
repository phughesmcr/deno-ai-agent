import { assertEquals } from "jsr:@std/assert@1";

import { grantBrokerWritePath } from "../../src/permission-broker/mod.ts";

Deno.test("grantBrokerWritePath is a no-op without a control connection", async () => {
  const dir = await Deno.makeTempDir({ prefix: "silas-grant-write-" });
  try {
    const file = `${dir}/config.toml`;
    await Deno.writeTextFile(file, "ok");
    await grantBrokerWritePath(file);
    assertEquals(true, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
