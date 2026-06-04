import type { ChatMessageData, ToolCallRequest } from "@lmstudio/sdk";

import { persistedModelText } from "../../shared/reasoning.ts";
import { imageFileParts } from "./message-materialize.ts";
import type { SessionFileDetails } from "./session-store.ts";

const SKILL_CONTENT_PATTERN = /<skill_content name="([^"]+)">[\s\S]*?<\/skill_content>/g;
const DEFAULT_TOOL_RESULT_LIMIT = 2_000;

const SUMMARY_PROMPT = `Create an updated compaction checkpoint for the conversation.

Output only the checkpoint in this exact structure:

Goal
- ...

Constraints & Preferences
- ...

Progress
- Done: ...
- In Progress: ...
- Blocked: ...

Key Decisions
- ...

Next Steps
- ...

Critical Context
- ...

Preserve concrete user instructions, active plans, file paths, decisions, blockers, and details needed to continue work.`;

/**
 * Input used to generate a structured compaction checkpoint.
 * @internal
 */
export interface SummaryCompactionInput {
  /** Current system prompt to apply while asking the model for a summary. */
  systemPrompt: string;
  /** Previous checkpoint summary, when this compaction updates an earlier checkpoint. */
  previousSummary?: string;
  /** Raw message data to fold into the checkpoint. */
  messages: ChatMessageData[];
  /** Optional user-supplied manual compaction instructions. */
  instructions?: string;
  /** Cumulative file context to include in the checkpoint. */
  details: SessionFileDetails;
}

/** Function that generates a structured checkpoint summary. */
export type SummaryCompactor = (input: SummaryCompactionInput) => Promise<string>;

/** Prepared summary prompt plus final summary formatter. */
export interface PreparedSummaryCompaction {
  /** System prompt to apply for summary generation. */
  systemPrompt: string;
  /** User prompt containing transcript and compaction instructions. */
  prompt: string;
  /** Applies persistence policy and appends practical context sections. */
  finish(summaryText: string): string;
}

interface SkillContentBlock {
  content: string;
  order: number;
}

function textParts(message: ChatMessageData): string[] {
  return message.content.flatMap((part) => part.type === "text" ? [part.text] : []);
}

function toolResultParts(message: ChatMessageData): string[] {
  return message.content.flatMap((part) => part.type === "toolCallResult" ? [part.content] : []);
}

function toolCallRequests(message: ChatMessageData): ToolCallRequest[] {
  return message.content.flatMap((part) => part.type === "toolCallRequest" ? [part.toolCallRequest] : []);
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[tool result truncated at ${limit} chars]`;
}

function extractLatestSkillContent(messages: ChatMessageData[]): string[] {
  const latest = new Map<string, SkillContentBlock>();
  let order = 0;

  for (const message of messages) {
    for (const source of [...textParts(message), ...toolResultParts(message)]) {
      for (const match of source.matchAll(SKILL_CONTENT_PATTERN)) {
        const name = match[1];
        const content = match[0];
        if (!name || !content) continue;
        latest.set(name, { content, order });
        order += 1;
      }
    }
  }

  return [...latest.values()]
    .toSorted((a, b) => a.order - b.order)
    .map((block) => block.content);
}

function serializeMessage(message: ChatMessageData, index: number, toolResultLimit: number): string {
  const sections = [`[${index + 1}] role=${message.role}`];
  const text = textParts(message).join("\n");
  if (text) sections.push(text);

  const images = imageFileParts(message);
  if (images.length > 0) {
    const names = images.map((part) => part.name).join(", ");
    sections.push(`attachments: ${images.length} image(s): ${names}`);
  }

  const requests = toolCallRequests(message);
  if (requests.length > 0) {
    sections.push(
      requests
        .map((request) => {
          const args = request.arguments === undefined ? "" : ` args=${JSON.stringify(request.arguments)}`;
          const id = request.id ? ` id=${request.id}` : "";
          return `<tool-call name="${request.name}"${id}${args}>`;
        })
        .join("\n"),
    );
  }

  const results = toolResultParts(message);
  if (results.length > 0) {
    sections.push(
      results
        .map((content) => `<tool-result>\n${truncate(content, toolResultLimit)}\n</tool-result>`)
        .join("\n"),
    );
  }

  return sections.join("\n");
}

function appendPracticalSections(summary: string, details: SessionFileDetails, skillBlocks: string[]): string {
  const sections = [summary.trim()];
  if (skillBlocks.length > 0) {
    sections.push(`<skill-content>\n${skillBlocks.join("\n\n")}\n</skill-content>`);
  }
  if (details.readFiles.length > 0) {
    sections.push(`<read-files>\n${details.readFiles.join("\n")}\n</read-files>`);
  }
  if (details.modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${details.modifiedFiles.join("\n")}\n</modified-files>`);
  }
  return sections.filter((section) => section.length > 0).join("\n\n");
}

/**
 * Prepares structured checkpoint summary input from explicit message data.
 * @internal
 */
export function prepareSummaryCompaction(
  input: SummaryCompactionInput,
  toolResultLimit = DEFAULT_TOOL_RESULT_LIMIT,
): PreparedSummaryCompaction {
  const transcript = input.messages
    .map((message, index) => serializeMessage(message, index, toolResultLimit))
    .join("\n\n");
  const previous = input.previousSummary?.trim();
  const instructions = input.instructions?.trim();
  const skillBlocks = extractLatestSkillContent(input.messages);

  const prompt = [
    SUMMARY_PROMPT,
    instructions ? `\nAdditional user compaction instructions:\n${instructions}` : "",
    previous ? `\nPrevious checkpoint summary:\n${previous}` : "",
    `\nCurrent file details:\nreadFiles=${JSON.stringify(input.details.readFiles)}\nmodifiedFiles=${
      JSON.stringify(input.details.modifiedFiles)
    }`,
    `\nConversation messages to fold into the checkpoint:\n${transcript}`,
  ].join("\n");

  return {
    systemPrompt: input.systemPrompt,
    prompt,
    finish(summaryText: string): string {
      return appendPracticalSections(persistedModelText(summaryText), input.details, skillBlocks);
    },
  };
}
