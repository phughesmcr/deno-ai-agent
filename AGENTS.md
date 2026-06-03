# Project Guidance

This is a personal experimental project and is greenfield - be ambitious. Backward compatibility is never required. Remove all unused and deprecated code immediately.

Silas is a monorepo. The project is a Deno-first AI Agent Harness.

Tech stack:

- Runtime: Deno 2.8.1
- Database: Deno KV
- LLM Provider: LMStudio Typescript SDK
- LLM Model: Qwen3.6 27B
- Presentation interface: Telegram (GrammY)
- Observability: OTEL (Deno / Jager)

# Code Style

- Always prefer modern (ES2025+) WebPlatform APIs, and Deno APIs, including the Deno `@std` JSR library over other libraryies where possible.
- Never use modern private fields on classes ("#") - these are ugly and hard to read. Use `private _{varName}` instead.
- Top-level functions must always be functions and not consts.
- Make use of `Promise.try` and `Disposable`/`AsyncDisposable` where relevant.
- Prefer OTEL to console logging. If you must console log use `console.error` only to avoid printing to STDOUT.
- Formatting and linting rules are defined in `deno.json`

# Coding Guidance

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes,
simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it and delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it
work") require constant clarification.
