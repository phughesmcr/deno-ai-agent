import Ajv from "ajv";

import type { ElicitationFormPlan, ElicitationFormStep, McpRequestedSchema } from "./user-interaction.ts";

const ajv = new Ajv({ allErrors: true, strict: false });

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseEnumOptions(
  prop: Record<string, unknown>,
): { value: string; label: string }[] {
  const enumValues = prop["enum"];
  if (Array.isArray(enumValues)) {
    return enumValues.filter((v): v is string => typeof v === "string").map((v) => ({ value: v, label: v }));
  }
  const oneOf = prop["oneOf"];
  if (Array.isArray(oneOf)) {
    const out: { value: string; label: string }[] = [];
    for (const entry of oneOf) {
      const item = asRecord(entry);
      if (!item) continue;
      const c = item["const"];
      if (typeof c !== "string") continue;
      const title = stringField(item["title"]) ?? c;
      out.push({ value: c, label: title });
    }
    return out;
  }
  return [];
}

function parseArrayEnumOptions(items: Record<string, unknown>): { value: string; label: string }[] {
  const enumValues = items["enum"];
  if (Array.isArray(enumValues)) {
    return enumValues.filter((v): v is string => typeof v === "string").map((v) => ({ value: v, label: v }));
  }
  const anyOf = items["anyOf"];
  if (Array.isArray(anyOf)) {
    const out: { value: string; label: string }[] = [];
    for (const entry of anyOf) {
      const item = asRecord(entry);
      if (!item) continue;
      const c = item["const"];
      if (typeof c !== "string") continue;
      out.push({ value: c, label: stringField(item["title"]) ?? c });
    }
    return out;
  }
  return [];
}

function stepFromProperty(
  fieldName: string,
  prop: Record<string, unknown>,
  required: boolean,
): ElicitationFormStep {
  const title = stringField(prop["title"]) ?? fieldName;
  const description = stringField(prop["description"]);
  const type = prop["type"];

  if (type === "boolean") {
    return {
      kind: "boolean",
      fieldName,
      title,
      description,
      required,
      defaultValue: typeof prop["default"] === "boolean" ? prop["default"] : undefined,
    };
  }

  if (type === "number" || type === "integer") {
    return {
      kind: "number",
      fieldName,
      title,
      description,
      required,
      integer: type === "integer",
      minimum: numberField(prop["minimum"]),
      maximum: numberField(prop["maximum"]),
      defaultValue: numberField(prop["default"]),
    };
  }

  if (type === "array") {
    const items = asRecord(prop["items"]);
    if (!items) throw new Error(`Field "${fieldName}": array items schema is required.`);
    const options = parseArrayEnumOptions(items);
    if (options.length === 0) {
      throw new Error(`Field "${fieldName}": unsupported array item schema.`);
    }
    const defaultValue = Array.isArray(prop["default"]) ?
      prop["default"].filter((v): v is string => typeof v === "string") :
      undefined;
    return {
      kind: "array_enum",
      fieldName,
      title,
      description,
      required,
      options,
      minItems: numberField(prop["minItems"]),
      maxItems: numberField(prop["maxItems"]),
      defaultValue,
    };
  }

  if (type === "string") {
    const options = parseEnumOptions(prop);
    if (options.length > 0) {
      const defaultValue = stringField(prop["default"]);
      return {
        kind: "string_enum",
        fieldName,
        title,
        description,
        required,
        options,
        defaultValue,
      };
    }
    return {
      kind: "string_free",
      fieldName,
      title,
      description,
      required,
      format: stringField(prop["format"]),
      minLength: numberField(prop["minLength"]),
      maxLength: numberField(prop["maxLength"]),
      pattern: stringField(prop["pattern"]),
      defaultValue: stringField(prop["default"]),
    };
  }

  throw new Error(`Field "${fieldName}": unsupported type "${String(type)}".`);
}

/**
 * Builds a wizard plan from an MCP form elicitation schema.
 * @throws Error if schema is not a flat object of supported primitives.
 */
export function planElicitationForm(message: string, requestedSchema: McpRequestedSchema): ElicitationFormPlan {
  const schema = asRecord(requestedSchema);
  if (!schema || schema["type"] !== "object") {
    throw new Error('requestedSchema must be a JSON Schema object with type "object".');
  }
  const properties = asRecord(schema["properties"]);
  if (!properties) throw new Error("requestedSchema.properties is required.");

  for (const prop of Object.values(properties)) {
    const p = asRecord(prop);
    if (!p) throw new Error("Each property must be an object schema.");
    if (p["type"] === "object") throw new Error("Nested object properties are not supported.");
  }

  const requiredList = Array.isArray(schema["required"]) ?
    schema["required"].filter((n): n is string => typeof n === "string") :
    [];
  const requiredSet = new Set(requiredList);
  const names = Object.keys(properties);
  const ordered = [
    ...requiredList.filter((n) => names.includes(n)),
    ...names.filter((n) => !requiredSet.has(n)),
  ];

  const steps: ElicitationFormStep[] = [];
  for (const fieldName of ordered) {
    const prop = asRecord(properties[fieldName]);
    if (!prop) continue;
    steps.push(stepFromProperty(fieldName, prop, requiredSet.has(fieldName)));
  }

  if (steps.length === 0) throw new Error("requestedSchema has no properties.");

  return { message, steps, schema: requestedSchema };
}

/** Formats collected content for review display. */
export function formatElicitationReview(content: Record<string, unknown>): string {
  return JSON.stringify(content, null, 2);
}

/**
 * Validates content against the full requested schema.
 * @returns Error message or null if valid.
 */
export function validateElicitationContent(
  schema: McpRequestedSchema,
  content: Record<string, unknown>,
): string | null {
  const validate = ajv.compile(schema);
  if (validate(content)) return null;
  const errors = validate.errors ?? [];
  return errors.map((e) => `${e.instancePath || "root"}: ${e.message ?? "invalid"}`).join("; ");
}

/** Parses a user text answer for a number step. */
export function parseNumberAnswer(text: string, integer: boolean): number {
  const trimmed = text.trim();
  const value = integer ? Number.parseInt(trimmed, 10) : Number.parseFloat(trimmed);
  if (!Number.isFinite(value)) {
    throw new Error(integer ? "Enter a valid integer." : "Enter a valid number.");
  }
  return value;
}

/** Parses boolean from yes/no style answers. */
export function parseBooleanAnswer(text: string): boolean {
  const lower = text.trim().toLowerCase();
  if (lower === "yes" || lower === "y" || lower === "true" || lower === "1") return true;
  if (lower === "no" || lower === "n" || lower === "false" || lower === "0") return false;
  throw new Error("Choose Yes or No.");
}
