// A generalized, stdlib-only runtime validator for the JSON Schema (draft 2020-12) subset spread
// across spec/schemas/*.json (docs/PLAN.md S1-11, C11: "BugReport envelope, never persisted").
// This generalizes stats/schema.ts's hand-rolled RunStats-only checker so it can also validate
// bug-report.schema.json and event.schema.json, both of which `$ref` fields out to
// run-stats.schema.json's `$defs` (e.g. "run-stats.schema.json#/$defs/level") -- a *cross-file*
// $ref that stats/schema.ts's local-only resolver doesn't need to handle and this one does.
// stats/schema.ts is left as-is (S1-10's own tests pin its exact shape); this module is additive,
// not a replacement, and mirrors exactly the subset bench/schema_check.py (the independent Python
// validator) implements -- type incl. nullable via ["x","null"], enum, pattern, minimum/maximum,
// minLength/maxLength, minItems/maxItems, required, additionalProperties: false, items, and
// same-document or cross-file `$ref` -- so an instance that passes here also passes there.
import bugReportSchema from "../../../spec/schemas/bug-report.schema.json";
import eventSchema from "../../../spec/schemas/event.schema.json";
import runStatsSchema from "../../../spec/schemas/run-stats.schema.json";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

interface JsonSchemaNode {
  type?: string | string[];
  enum?: unknown[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  $ref?: string;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchemaNode;
  $defs?: Record<string, JsonSchemaNode>;
}

/** Every schema file this validator knows how to resolve a `$ref` into, keyed exactly as the
 *  schemas themselves spell the file part of a $ref (e.g. "run-stats.schema.json"). Adding a
 *  schema file that $refs another one it doesn't already list is a small addition here. */
const SCHEMA_FILES: Record<string, JsonSchemaNode> = {
  "bug-report.schema.json": bugReportSchema as unknown as JsonSchemaNode,
  "event.schema.json": eventSchema as unknown as JsonSchemaNode,
  "run-stats.schema.json": runStatsSchema as unknown as JsonSchemaNode,
};

function jsonType(value: unknown): "null" | "array" | "integer" | "number" | "string" | "boolean" | "object" | "invalid" {
  if (value === null) return "null";
  // undefined, functions, symbols, bigints and non-finite numbers are not JSON: they match no
  // schema type, so a missing or broken value is reported, never waved through as an object
  // (Codex review, PR #23).
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") return "invalid";
  if (typeof value === "number" && !Number.isFinite(value)) return "invalid";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "object") return "object";
  return "invalid";
}

function matchesType(value: unknown, want: string): boolean {
  const t = jsonType(value);
  if (want === "number") return t === "number" || t === "integer";
  return t === want;
}

/** Resolves a `$ref` to its target node and the document that node lives in (needed so a nested
 *  `$ref` inside the target, e.g. run-stats.schema.json's own local `#/$defs/...`, resolves
 *  against *that* document, not the one that pointed to it). */
function resolveRef(ref: string, currentDoc: JsonSchemaNode): { node: JsonSchemaNode; doc: JsonSchemaNode } {
  const hashIndex = ref.indexOf("#");
  const filePart = hashIndex === -1 ? ref : ref.slice(0, hashIndex);
  const frag = hashIndex === -1 ? "" : ref.slice(hashIndex + 1);
  const doc = filePart ? SCHEMA_FILES[filePart] : currentDoc;
  if (!doc) throw new Error(`stats/validate: unknown schema file in $ref "${ref}"`);
  let node: unknown = doc;
  for (const part of frag.split("/").filter(Boolean)) {
    if (typeof node !== "object" || node === null || !(part in node)) {
      throw new Error(`stats/validate: $ref "${ref}" does not resolve (missing "${part}")`);
    }
    node = (node as Record<string, unknown>)[part];
  }
  return { node: node as JsonSchemaNode, doc };
}

function validateNode(path: string, value: unknown, schema: JsonSchemaNode, doc: JsonSchemaNode, errors: string[]): void {
  if (schema.$ref !== undefined) {
    const { node, doc: targetDoc } = resolveRef(schema.$ref, doc);
    validateNode(path, value, node, targetDoc, errors);
    return;
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${path}: expected type ${JSON.stringify(schema.type)}, got ${jsonType(value)} (${JSON.stringify(value)})`);
      return; // a type mismatch makes every other check meaningless
    }
  }
  if (value === null) return; // nullable field, value is null: nothing further applies

  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === "string") {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: ${JSON.stringify(value)} does not match pattern ${schema.pattern}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: length ${value.length} exceeds maxLength ${schema.maxLength}`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: length ${value.length} is below minLength ${schema.minLength}`);
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: ${value} is below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: ${value} is above maximum ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: ${value.length} items is below minItems ${schema.minItems}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: ${value.length} items exceeds maxItems ${schema.maxItems}`);
    }
    if (schema.items !== undefined) {
      value.forEach((item, i) => validateNode(`${path}[${i}]`, item, schema.items as JsonSchemaNode, doc, errors));
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push(`${path}: missing required field: ${key}`);
    }
    const props = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) errors.push(`${path}: unknown field: ${key}`);
      }
    }
    for (const [key, def] of Object.entries(props)) {
      if (key in obj) validateNode(`${path}.${key}`, obj[key], def, doc, errors);
    }
  }
}

/** Validate `instance` against the named schema file (one of SCHEMA_FILES' keys). Never throws
 *  for a malformed instance -- a wrong shape is reported as errors, not an exception -- but a
 *  broken *schema* (an unresolvable $ref) is a bug in this module or the spec files and does
 *  throw, same as bench/schema_check.py's SchemaError. */
export function validateAgainst(schemaFile: keyof typeof SCHEMA_FILES, instance: unknown): ValidationResult {
  const doc = SCHEMA_FILES[schemaFile];
  const errors: string[] = [];
  validateNode("$", instance, doc, doc, errors);
  return { ok: errors.length === 0, errors };
}

/** `instance` against spec/schemas/bug-report.schema.json (the BugReport envelope, S1-11). */
export function validateBugReport(instance: unknown): ValidationResult {
  return validateAgainst("bug-report.schema.json", instance);
}
