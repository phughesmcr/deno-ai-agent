import { assertEquals, assertThrows } from "jsr:@std/assert@1";

import { planElicitationForm, validateElicitationContent } from "../../../src/agent/tools/elicitation-form.ts";

Deno.test("planElicitationForm orders required fields first", () => {
  const plan = planElicitationForm("Contact info", {
    type: "object",
    properties: {
      email: { type: "string", format: "email" },
      name: { type: "string" },
    },
    required: ["name"],
  });
  assertEquals(plan.steps[0]?.fieldName, "name");
  assertEquals(plan.steps[1]?.fieldName, "email");
});

Deno.test("planElicitationForm rejects nested objects", () => {
  assertThrows(
    () =>
      planElicitationForm("Bad", {
        type: "object",
        properties: { nested: { type: "object", properties: {} } },
      }),
    Error,
    "Nested object",
  );
});

Deno.test("validateElicitationContent accepts valid payload", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  };
  assertEquals(validateElicitationContent(schema, { name: "Ada" }), null);
});

Deno.test("validateElicitationContent rejects invalid payload", () => {
  const schema = {
    type: "object",
    properties: { age: { type: "integer", minimum: 18 } },
    required: ["age"],
  };
  const err = validateElicitationContent(schema, { age: 10 });
  assertEquals(typeof err, "string");
});
