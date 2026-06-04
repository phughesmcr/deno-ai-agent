import { assertEquals } from "jsr:@std/assert@1";

import { stdioChildEnv } from "../../src/mcp/stdio-env.ts";

Deno.test("stdioChildEnv strips permission broker vars from child env", () => {
  const env = stdioChildEnv({
    DENO_PERMISSION_BROKER_PATH: "/tmp/silas-perm.sock",
    SILAS_PERMISSION_CONTROL_PATH: "/tmp/silas-perm-control.sock",
    FOO: "bar",
  });
  assertEquals(env["DENO_PERMISSION_BROKER_PATH"], undefined);
  assertEquals(env["SILAS_PERMISSION_CONTROL_PATH"], undefined);
  assertEquals(env["FOO"], "bar");
});
