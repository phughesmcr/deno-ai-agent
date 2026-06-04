import { z } from "zod/v3";

const controlRegisterSchema = z.object({
  type: z.literal("register"),
  pid: z.number(),
});

const controlPromptSchema = z.object({
  type: z.literal("prompt"),
  requestId: z.string().min(1),
  brokerId: z.number(),
  permission: z.string().min(1),
  value: z.union([z.string(), z.null(), z.undefined()]).transform((value) => value ?? null),
});

const controlDecisionSchema = z.object({
  type: z.literal("decision"),
  requestId: z.string().min(1),
  result: z.enum(["allow", "deny"]),
  grant: z.enum(["once", "session"]).optional(),
});

const controlAbortSchema = z.object({
  type: z.literal("abort"),
  requestId: z.string().min(1).optional(),
});

const controlGrantSchema = z.object({
  type: z.literal("grant"),
  permission: z.string().min(1),
  value: z.union([z.string(), z.null(), z.undefined()]).transform((value) => value ?? null),
  scope: z.enum(["once", "session"]),
});

const controlMessageSchema = z.discriminatedUnion("type", [
  controlRegisterSchema,
  controlPromptSchema,
  controlDecisionSchema,
  controlAbortSchema,
  controlGrantSchema,
]);

/** Control channel: main registers with the broker daemon. */
export type ControlRegister = z.infer<typeof controlRegisterSchema>;

/** Control channel: daemon asks main to show a Telegram prompt. */
export type ControlPrompt = z.infer<typeof controlPromptSchema>;

/** Control channel: main returns the user's decision. */
export type ControlDecision = z.infer<typeof controlDecisionSchema>;

/** Control channel: cancel a pending prompt. */
export type ControlAbort = z.infer<typeof controlAbortSchema>;

/** Control channel: main pre-grants a permission in the broker session cache. */
export type ControlGrant = z.infer<typeof controlGrantSchema>;

/** All control messages. */
export type ControlMessage = z.infer<typeof controlMessageSchema>;

/** Parses a control JSONL line. */
export function parseControlMessage(line: string): ControlMessage {
  return controlMessageSchema.parse(JSON.parse(line.trim()));
}

/** Serializes a control message with trailing newline. */
export function formatControlMessage(message: ControlMessage): string {
  return `${JSON.stringify(controlMessageSchema.parse(message))}\n`;
}
