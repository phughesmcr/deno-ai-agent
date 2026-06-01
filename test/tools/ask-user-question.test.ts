import { assertEquals } from "jsr:@std/assert@1";

import {
  createAskUserQuestionTool,
  formatAnswers,
  UserQuestionDeclinedError,
  validateAskUserQuestionParams,
} from "../../src/tools/ask-user-question.ts";
import type { AskUserQuestionPort } from "../../src/tools/user-question-port.ts";
import { runTool, runToolImplementationThrows } from "./helpers.ts";

function mockPort(answers: Record<string, string>): AskUserQuestionPort {
  return {
    isAvailable: () => true,
    isPending: () => false,
    setTurnContext: () => {},
    clearTurnContext: () => {},
    ask: () => Promise.resolve(answers),
  };
}

Deno.test("validateAskUserQuestionParams rejects empty questions", () => {
  assertEquals(
    validateAskUserQuestionParams({ questions: [] }),
    'Parameter "questions" must contain between 1 and 4 questions.',
  );
});

Deno.test("validateAskUserQuestionParams rejects long header", () => {
  const err = validateAskUserQuestionParams({
    questions: [{
      question: "Which?",
      header: "this-is-too-long",
      options: [
        { label: "A", description: "a" },
        { label: "B", description: "b" },
      ],
    }],
  });
  assertEquals(err, 'Question 1: "header" must be 12 characters or less.');
});

Deno.test("formatAnswers uses headers", () => {
  const text = formatAnswers(
    [{
      question: "Q?",
      header: "Lib",
      options: [
        { label: "a", description: "a" },
        { label: "b", description: "b" },
      ],
    }],
    { "0": "date-fns" },
  );
  assertEquals(text, "User has provided the following answers:\n\n**Lib**: date-fns");
});

Deno.test("ask_user_question tool returns formatted answers", async () => {
  const tool = createAskUserQuestionTool(mockPort({ "0": "JWT" }));
  const result = await runTool(tool, {
    questions: [{
      question: "Auth?",
      header: "Auth",
      options: [
        { label: "JWT", description: "tokens" },
        { label: "Session", description: "cookies" },
      ],
    }],
  });
  assertEquals(result.includes("**Auth**: JWT"), true);
});

Deno.test("ask_user_question tool returns unavailable message", async () => {
  const tool = createAskUserQuestionTool({
    isAvailable: () => false,
    isPending: () => false,
    setTurnContext: () => {},
    clearTurnContext: () => {},
    ask: () => Promise.resolve({}),
  });
  const result = await runTool(tool, {
    questions: [{
      question: "Q?",
      header: "H",
      options: [
        { label: "A", description: "a" },
        { label: "B", description: "b" },
      ],
    }],
  });
  assertEquals(result, "Cannot ask user questions: no interactive channel configured.");
});

Deno.test("ask_user_question tool returns decline message", async () => {
  const tool = createAskUserQuestionTool({
    isAvailable: () => true,
    isPending: () => false,
    setTurnContext: () => {},
    clearTurnContext: () => {},
    ask: () => Promise.reject(new UserQuestionDeclinedError()),
  });
  const result = await runTool(tool, {
    questions: [{
      question: "Q?",
      header: "H",
      options: [
        { label: "A", description: "a" },
        { label: "B", description: "b" },
      ],
    }],
  });
  assertEquals(result, "User declined to answer the questions.");
});

Deno.test("ask_user_question tool throws on invalid params", async () => {
  const tool = createAskUserQuestionTool(mockPort({}));
  const error = await runToolImplementationThrows(tool, {
    questions: [{
      question: "",
      header: "H",
      options: [
        { label: "A", description: "a" },
        { label: "B", description: "b" },
      ],
    }],
  });
  assertEquals(error.message, 'Question 1: "question" must be a non-empty string.');
});
