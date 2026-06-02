const p = "/tmp/silas-test-broker.sock";
try {
  await Deno.remove(p);
} catch { /* empty */ }
const l = Deno.listen({ transport: "unix", path: p });
const c = await Deno.connect({ transport: "unix", path: p });
console.log("ok");
l.close();
c.close();
await Deno.remove(p);
