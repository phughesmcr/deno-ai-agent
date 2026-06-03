import { assertEquals } from "jsr:@std/assert@1";

import { getActDraftModel } from "../../src/shared/draft-model.ts";

const KEY = "DRAFT_MODEL";

Deno.test("getActDraftModel returns draftModel when DRAFT_MODEL is set", () => {
  const previous = Deno.env.get(KEY);
  try {
    Deno.env.set(KEY, "small-draft");
    assertEquals(getActDraftModel(), { draftModel: "small-draft" });
  } finally {
    if (previous === undefined) Deno.env.delete(KEY);
    else Deno.env.set(KEY, previous);
  }
});

Deno.test("getActDraftModel is undefined when DRAFT_MODEL is unset", () => {
  const previous = Deno.env.get(KEY);
  try {
    Deno.env.delete(KEY);
    assertEquals(getActDraftModel(), undefined);
  } finally {
    if (previous === undefined) Deno.env.delete(KEY);
    else Deno.env.set(KEY, previous);
  }
});
