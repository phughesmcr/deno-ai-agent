const encoder = new TextEncoder();

async function main(): Promise<void> {
  const socketPath = "/tmp/silas-test-broker.sock";
  try {
    await Deno.remove(socketPath);
  } catch { /* empty */ }
  const listener = Deno.listen({ transport: "unix", path: socketPath });
  const conn = await Deno.connect({ transport: "unix", path: socketPath });
  await Deno.stdout.write(encoder.encode("ok\n"));
  listener.close();
  conn.close();
  await Deno.remove(socketPath);
}

if (import.meta.main) {
  void main();
}
