const encoder = new TextEncoder();

function send(message: unknown): void {
  Deno.stdout.writeSync(encoder.encode(`${JSON.stringify(message)}\n`));
}

Deno.addSignalListener("SIGTERM", () => {
  setTimeout(() => Deno.exit(0), 1500);
});

send({ jsonrpc: "2.0", method: "started" });

async function main(): Promise<void> {
  await new Promise(() => {});
}

void main();
