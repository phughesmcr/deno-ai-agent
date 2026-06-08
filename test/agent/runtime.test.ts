import { assertEquals } from "jsr:@std/assert@1";

import { isSystemPromptModifyEvent } from "../../src/agent/runtime.ts";

Deno.test("isSystemPromptModifyEvent matches SYSTEM.md anywhere in a modify event", () => {
  assertEquals(
    isSystemPromptModifyEvent({
      kind: "modify",
      paths: ["/tmp/workspace/notes.md", "/tmp/workspace/SYSTEM.md"],
    } as Deno.FsEvent),
    true,
  );
  assertEquals(
    isSystemPromptModifyEvent({
      kind: "modify",
      paths: ["/tmp/workspace/SYSTEM.md", "/tmp/workspace/notes.md"],
    } as Deno.FsEvent),
    true,
  );
});

Deno.test("isSystemPromptModifyEvent ignores non-modify events and suffix-only matches", () => {
  assertEquals(
    isSystemPromptModifyEvent({
      kind: "create",
      paths: ["/tmp/workspace/SYSTEM.md"],
    } as Deno.FsEvent),
    false,
  );
  assertEquals(
    isSystemPromptModifyEvent({
      kind: "modify",
      paths: ["/tmp/workspace/NOTSYSTEM.md"],
    } as Deno.FsEvent),
    false,
  );
});
