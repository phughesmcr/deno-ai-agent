import type { Tool } from "@lmstudio/sdk";
import { z } from "zod/v3";

import { type AgentToolDefinition, type AgentToolDeps, toolFromDefinition } from "./definitions.ts";
import { UserQuestionDeclinedError } from "./user-interaction.ts";
import { cursorQuestionsToAnswers, type UserInteractionPort } from "./user-question-port.ts";

export { UserQuestionAbortedError, UserQuestionDeclinedError } from "./user-interaction.ts";

/** One selectable option in a user question. */
export interface QuestionOption {
  label: string;
  description: string;
}

/** One question presented to the user. */
export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

/** Parameters for the ask_user_question tool. */
export interface AskUserQuestionParams {
  questions: Question[];
  metadata?: { source?: string };
}

const TOOL_DESCRIPTION = `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes (Telegram):
- Questions are sent sequentially with inline keyboard buttons.
- Users can tap "Other" to type a custom answer, or "Cancel" to decline.
- Use multiSelect: true when choices are not mutually exclusive (toggle options, then tap Done).
- If you recommend a specific option, make that the first option and add "(Recommended)" to the label.
- Do not include an "Other" option in the list; it is added automatically.`;

const questionOptionSchema = z.object({
  label: z.string().describe("Display text for this option (1-5 words)."),
  description: z.string().describe("What this option means or implies."),
});

const questionSchema = z.object({
  question: z
    .string()
    .describe("Clear question ending with ? (or phrased for multiSelect)."),
  header: z.string().describe("Short chip label, max 12 characters."),
  options: z
    .array(questionOptionSchema)
    .min(2)
    .max(4)
    .describe("2-4 mutually exclusive choices (unless multiSelect)."),
  multiSelect: z
    .boolean()
    .optional()
    .describe("Allow multiple selections; user toggles options then taps Done."),
});

const askUserQuestionParameters = {
  questions: z
    .array(questionSchema)
    .min(1)
    .max(4)
    .describe("Questions to ask the user (1-4)."),
  metadata: z
    .object({
      source: z.string().optional().describe("Optional analytics source identifier."),
    })
    .optional(),
} as const;

/**
 * Validates ask_user_question params (Qwen-aligned rules).
 * @returns Error message or null if valid.
 * @internal
 */
export function validateAskUserQuestionParams(params: AskUserQuestionParams): string | null {
  if (!Array.isArray(params.questions)) {
    return 'Parameter "questions" must be an array.';
  }
  if (params.questions.length < 1 || params.questions.length > 4) {
    return 'Parameter "questions" must contain between 1 and 4 questions.';
  }

  for (let i = 0; i < params.questions.length; i++) {
    const question = params.questions[i];
    if (!question) continue;

    if (!question.question || typeof question.question !== "string" || question.question.trim() === "") {
      return `Question ${i + 1}: "question" must be a non-empty string.`;
    }
    if (!question.header || typeof question.header !== "string" || question.header.trim() === "") {
      return `Question ${i + 1}: "header" must be a non-empty string.`;
    }
    if (question.header.length > 12) {
      return `Question ${i + 1}: "header" must be 12 characters or less.`;
    }
    if (!Array.isArray(question.options)) {
      return `Question ${i + 1}: "options" must be an array.`;
    }
    if (question.options.length < 2 || question.options.length > 4) {
      return `Question ${i + 1}: "options" must contain between 2 and 4 options.`;
    }

    for (let j = 0; j < question.options.length; j++) {
      const option = question.options[j];
      if (!option?.label || typeof option.label !== "string" || option.label.trim() === "") {
        return `Question ${i + 1}, Option ${j + 1}: "label" must be a non-empty string.`;
      }
      if (
        !option.description ||
        typeof option.description !== "string" ||
        option.description.trim() === ""
      ) {
        return `Question ${i + 1}, Option ${j + 1}: "description" must be a non-empty string.`;
      }
    }

    if (question.multiSelect !== undefined && typeof question.multiSelect !== "boolean") {
      return `Question ${i + 1}: "multiSelect" must be a boolean.`;
    }
  }

  return null;
}

/**
 * Formats collected answers for the model (Qwen-aligned).
 * @internal
 */
export function formatAnswers(questions: Question[], answers: Record<string, string>): string {
  const lines = Object.entries(answers).map(([key, value]) => {
    const questionIndex = Number.parseInt(key, 10);
    const question = questions[questionIndex];
    const header = question?.header ?? `Question ${questionIndex + 1}`;
    return `**${header}**: ${value}`;
  });
  return `User has provided the following answers:\n\n${lines.join("\n")}`;
}

export const askUserQuestionToolDefinition: AgentToolDefinition<typeof askUserQuestionParameters> = {
  name: "ask_user_question",
  description: TOOL_DESCRIPTION,
  parameters: askUserQuestionParameters,
  authorize: (): null => {
    return null;
  },
  run: async (params, deps): Promise<string> => {
    const validationError = validateAskUserQuestionParams(params);
    if (validationError) {
      throw new Error(validationError);
    }
    if (!deps.userQuestions.isAvailable()) {
      return "Cannot ask user questions: no interactive channel configured.";
    }
    try {
      const result = await deps.userQuestions.interact({
        mode: "cursor_questions",
        questions: params.questions,
        metadata: params.metadata,
      });
      const answers = cursorQuestionsToAnswers(result, params.questions.length);
      return formatAnswers(params.questions, answers);
    } catch (error) {
      if (error instanceof UserQuestionDeclinedError) {
        return error.message;
      }
      const message = error instanceof Error ? error.message : String(error);
      return `Failed to process user answers: ${message}`;
    }
  },
};

/**
 * LM Studio tool that asks the user structured questions via the configured port.
 * @internal
 */
export function createAskUserQuestionTool(port: UserInteractionPort): Tool {
  return toolFromDefinition(askUserQuestionToolDefinition, { userQuestions: port } as AgentToolDeps);
}
