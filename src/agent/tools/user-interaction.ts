import type { Question } from "./ask-user-question.ts";

/** User tapped Cancel on the question keyboard. */
export class UserQuestionDeclinedError extends Error {
  constructor() {
    super("User declined to answer the questions.");
    this.name = "UserQuestionDeclinedError";
  }
}

/** Turn aborted while waiting for an answer. */
export class UserQuestionAbortedError extends Error {
  constructor(message = "Question flow aborted") {
    super(message);
    this.name = "UserQuestionAbortedError";
  }
}

/** JSON Schema object for MCP form elicitation (flat object of primitives). */
export type McpRequestedSchema = Record<string, unknown>;

/** Cursor model tool: structured multiple-choice questions. */
export interface CursorQuestionsRequest {
  mode: "cursor_questions";
  questions: Question[];
  metadata?: { source?: string };
}

/** MCP server form elicitation. */
export interface McpFormRequest {
  mode: "mcp_form";
  message: string;
  requestedSchema: McpRequestedSchema;
  serverId: string;
  serverTitle?: string;
  maxAttempts?: number;
}

/** MCP server URL elicitation. */
export interface McpUrlRequest {
  mode: "mcp_url";
  message: string;
  url: string;
  elicitationId: string;
  serverId: string;
  serverTitle?: string;
}

/** User interaction request from model tool or MCP elicitation. */
export type UserInteractionRequest = CursorQuestionsRequest | McpFormRequest | McpUrlRequest;

/** MCP-compatible interaction result. */
export type UserInteractionResult =
  | { action: "accept"; content?: Record<string, unknown> }
  | { action: "decline" }
  | { action: "cancel" };

/** One step in an MCP form wizard. */
export type ElicitationFormStep =
  | {
    kind: "string_enum";
    fieldName: string;
    title: string;
    description?: string;
    required: boolean;
    options: { value: string; label: string }[];
    defaultValue?: string;
  }
  | {
    kind: "string_free";
    fieldName: string;
    title: string;
    description?: string;
    required: boolean;
    format?: string;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    defaultValue?: string;
  }
  | {
    kind: "boolean";
    fieldName: string;
    title: string;
    description?: string;
    required: boolean;
    defaultValue?: boolean;
  }
  | {
    kind: "number";
    fieldName: string;
    title: string;
    description?: string;
    required: boolean;
    integer: boolean;
    minimum?: number;
    maximum?: number;
    defaultValue?: number;
  }
  | {
    kind: "array_enum";
    fieldName: string;
    title: string;
    description?: string;
    required: boolean;
    options: { value: string; label: string }[];
    minItems?: number;
    maxItems?: number;
    defaultValue?: string[];
  };

/** Planned MCP form wizard. */
export interface ElicitationFormPlan {
  message: string;
  steps: ElicitationFormStep[];
  schema: McpRequestedSchema;
}
