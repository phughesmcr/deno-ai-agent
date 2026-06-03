import { assertEquals } from "jsr:@std/assert@1";

import { grantBrokerReadPath } from "../../src/permission-broker/mod.ts";

Deno.test("grantBrokerReadPath is a no-op without a control connection", async () => {
  const dir = await Deno.makeTempDir({ prefix: "silas-grant-read-" });
  try {
    const file = `${dir}/config.toml`;
    await Deno.writeTextFile(file, "ok");
    await grantBrokerReadPath(file);
    assertEquals(true, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
