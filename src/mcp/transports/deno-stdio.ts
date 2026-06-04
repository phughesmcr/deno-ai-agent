import type { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types";

function serializeMessage(message: JSONRPCMessage): string {
  return JSON.stringify(message) + "\n";
}

function deserializeMessage(line: string): JSONRPCMessage {
  return JSON.parse(line) as JSONRPCMessage;
}

/** Newline-delimited JSON-RPC read buffer (matches MCP stdio framing). */
class ReadBuffer {
  private _buffer = "";

  append(chunk: Uint8Array): void {
    this._buffer += new TextDecoder().decode(chunk);
  }

  readMessage(): JSONRPCMessage | null {
    const index = this._buffer.indexOf("\n");
    if (index === -1) return null;
    const line = this._buffer.slice(0, index).replace(/\r$/, "");
    this._buffer = this._buffer.slice(index + 1);
    return deserializeMessage(line);
  }

  clear(): void {
    this._buffer = "";
  }
}

export interface DenoStdioServerParameters {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

const CLOSE_GRACE_MS = 250;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function statusWithin(proc: Deno.ChildProcess, ms: number): Promise<"exited" | "timeout"> {
  const result = await Promise.race([
    proc.status.then(() => "exited" as const),
    delay(ms).then(() => "timeout" as const),
  ]);
  return result;
}

/**
 * Deno-native MCP stdio transport (SDK StdioClientTransport is Node-only).
 */
export class DenoStdioClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private _process: Deno.ChildProcess | undefined;
  private readonly _readBuffer = new ReadBuffer();
  private readonly _params: DenoStdioServerParameters;

  constructor(params: DenoStdioServerParameters) {
    this._params = params;
  }

  start(): Promise<void> {
    if (this._process) throw new Error("DenoStdioClientTransport already started");
    this._process = new Deno.Command(this._params.command, {
      args: this._params.args,
      cwd: this._params.cwd,
      env: this._params.env,
      clearEnv: true,
      stdin: "piped",
      stdout: "piped",
      stderr: "inherit",
    }).spawn();

    const stdout = this._process.stdout;
    if (!stdout) throw new Error("stdio transport: no stdout");
    const reader = stdout.getReader();
    void this.readLoop(reader);
    return Promise.resolve();
  }

  private async readLoop(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          this._readBuffer.append(value);
          for (;;) {
            const msg = this._readBuffer.readMessage();
            if (!msg) break;
            this.onmessage?.(msg);
          }
        }
      }
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.onclose?.();
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this._process?.stdin;
    if (!stdin) throw new Error("Not connected");
    const writer = stdin.getWriter();
    try {
      await writer.write(new TextEncoder().encode(serializeMessage(message)));
    } finally {
      writer.releaseLock();
    }
  }

  async close(): Promise<void> {
    const proc = this._process;
    this._process = undefined;
    if (!proc) return;

    try {
      const stdin = proc.stdin;
      if (stdin) {
        await stdin.close();
      }
    } catch { /* ignore */ }

    try {
      proc.kill("SIGTERM");
    } catch { /* ignore */ }

    if (await statusWithin(proc, CLOSE_GRACE_MS) === "exited") {
      this._readBuffer.clear();
      return;
    }

    try {
      proc.kill("SIGKILL");
    } catch { /* ignore */ }

    await statusWithin(proc, CLOSE_GRACE_MS);
    this._readBuffer.clear();
  }
}
