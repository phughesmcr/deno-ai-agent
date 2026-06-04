const encoder = new TextEncoder();

function send(message: unknown): void {
  Deno.stdout.writeSync(encoder.encode(`${JSON.stringify(message)}\n`));
}

send({
  jsonrpc: "2.0",
  method: "env",
  params: {
    controlPath: Deno.env.get("SILAS_PERMISSION_CONTROL_PATH") ?? null,
    path: Deno.env.get("PATH") ?? null,
  },
});
