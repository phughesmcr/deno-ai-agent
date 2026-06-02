/** Control channel: main registers with the broker daemon. */
export interface ControlRegister {
  type: "register";
  pid: number;
}

/** Control channel: daemon asks main to show a Telegram prompt. */
export interface ControlPrompt {
  type: "prompt";
  requestId: string;
  brokerId: number;
  permission: string;
  value: string | null;
}

/** Control channel: main returns the user's decision. */
export interface ControlDecision {
  type: "decision";
  requestId: string;
  result: "allow" | "deny";
  grant?: "once" | "session";
}

/** Control channel: cancel a pending prompt. */
export interface ControlAbort {
  type: "abort";
  requestId?: string;
}

/** All control messages. */
export type ControlMessage = ControlRegister | ControlPrompt | ControlDecision | ControlAbort;

/** Parses a control JSONL line. */
export function parseControlMessage(line: string): ControlMessage {
  const parsed: unknown = JSON.parse(line.trim());
  if (!parsed || typeof parsed !== "object") throw new Error("invalid control message");
  const record = parsed as Record<string, unknown>;
  const type = String(record["type"]);
  switch (type) {
    case "register":
      return { type: "register", pid: Number(record["pid"]) };
    case "prompt":
      return {
        type: "prompt",
        requestId: String(record["requestId"]),
        brokerId: Number(record["brokerId"]),
        permission: String(record["permission"]),
        value: record["value"] === null || record["value"] === undefined ? null : String(record["value"]),
      };
    case "decision":
      return {
        type: "decision",
        requestId: String(record["requestId"]),
        result: record["result"] === "allow" ? "allow" : "deny",
        grant: record["grant"] === "session" ? "session" : record["grant"] === "once" ? "once" : undefined,
      };
    case "abort":
      return {
        type: "abort",
        requestId: record["requestId"] === undefined ? undefined : String(record["requestId"]),
      };
    default:
      throw new Error(`unknown control message type: ${type}`);
  }
}

/** Serializes a control message with trailing newline. */
export function formatControlMessage(message: ControlMessage): string {
  return `${JSON.stringify(message)}\n`;
}
