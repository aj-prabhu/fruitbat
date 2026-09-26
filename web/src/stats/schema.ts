// A stdlib-only runtime validator for spec/schemas/run-stats.schema.json (docs/PLAN.md S1-10,
// C11: "strict RunStats (persisted, benched)"). No `jsonschema` dependency (matches
// bench/schema_check.py's own stdlib-only rule): this hand-rolled checker covers exactly the
// subset the schema uses (type incl. nullable via ["x","null"], enum, pattern, minimum/maximum,
// required, additionalProperties: false, and local `#/$defs/...` $ref) so a row that fails here
// also fails bench/schema_check.py against the same file.
import schemaJson from "../../../spec/schemas/run-stats.schema.json";

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
  $ref?: string;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
}

interface RootSchema extends JsonSchemaNode {
  $defs?: Record<string, JsonSchemaNode>;
}

const ROOT = schemaJson as unknown as RootSchema;

/** RunStats as this schema describes it (spec/schemas/run-stats.schema.json, field order = the
 *  fixed column order of bench/results.csv, per the schema's own $comment). */
export interface StatsRow {
  schema_version: 1;
  target: "web" | "mac";
  device: "webgpu" | "wasm" | "mlx";
  level: "readall" | "short" | "caveman" | "oneline";
  browser: "chrome" | "safari" | "firefox" | "none";
  browser_major: number | null;
  os: "macos" | "windows" | "linux" | "ios" | "android";
  os_major: number;
  cache_state: "cold" | "warm";
  model_id: string;
  model_rev: string;
  dtype: string;
  doc_id: string;
  commit: string;
  date: string;
  machine_id: string;
  ttfa_ms: number | null;
  gen_ms: number | null;
  tok_s: number | null;
  rtf: number | null;
  gap_ms: number | null;
  stop_ms: number | null;
  coverage: number | null;
  bullets_total: number | null;
  bullets_cut: number | null;
  cut_rate: number | null;
  facts_token_hit: number | null;
  halluc_flags: number | null;
  forbidden_hits: number | null;
  oneline_keyword_hit: number | null;
  tts_overlimit: number | null;
  peak_mb: number | null;
  heap_mb: number | null;
}

/** The schema's own `required` array, which is (per its $comment) the fixed CSV column order. */
export const CSV_FIELDS: readonly string[] = Object.freeze([...(ROOT.required ?? [])]);

function resolveRef(ref: string): JsonSchemaNode {
  const m = /^#\/\$defs\/(.+)$/.exec(ref);
  if (!m) throw new Error(`stats/schema: unsupported $ref "${ref}"`);
  const def = ROOT.$defs?.[m[1]];
  if (!def) throw new Error(`stats/schema: unknown $defs entry "${m[1]}"`);
  return def;
}

/** JSON Schema "type" names, not JS `typeof` names: an integer value is also a "number". */
function jsonType(value: unknown): "null" | "array" | "integer" | "number" | "string" | "boolean" | "object" {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  return "object";
}

function matchesType(value: unknown, want: string): boolean {
  const t = jsonType(value);
  if (want === "number") return t === "number" || t === "integer";
  return t === want;
}

function validateField(path: string, value: unknown, def: JsonSchemaNode, errors: string[]): void {
  const node = def.$ref ? resolveRef(def.$ref) : def;
  if (node.type !== undefined) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${path}: expected type ${JSON.stringify(node.type)}, got ${jsonType(value)} (${JSON.stringify(value)})`);
      return; // a type mismatch makes enum/pattern/range checks meaningless
    }
  }
  if (value === null) return; // nullable field, value is null: nothing further applies
  if (node.enum !== undefined && !node.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(node.enum)}`);
  }
  if (node.pattern !== undefined && typeof value === "string" && !new RegExp(node.pattern).test(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} does not match pattern ${node.pattern}`);
  }
  if (node.minimum !== undefined && typeof value === "number" && value < node.minimum) {
    errors.push(`${path}: ${value} is below minimum ${node.minimum}`);
  }
  if (node.maximum !== undefined && typeof value === "number" && value > node.maximum) {
    errors.push(`${path}: ${value} is above maximum ${node.maximum}`);
  }
}

/**
 * Validate `row` against run-stats.schema.json: every `required` field present, no field outside
 * `properties` (additionalProperties: false), and every present field's type/enum/pattern/range
 * satisfied. Never throws for a malformed `row` — a wrong shape is reported as errors, not an
 * exception, so a caller (stats/store.ts) can always safely decide not to persist it.
 */
export function validateRunStats(row: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    return { ok: false, errors: ["row is not a plain object"] };
  }
  const obj = row as Record<string, unknown>;
  const props = ROOT.properties ?? {};
  for (const key of ROOT.required ?? []) {
    if (!(key in obj)) errors.push(`missing required field: ${key}`);
  }
  if (ROOT.additionalProperties === false) {
    for (const key of Object.keys(obj)) {
      if (!(key in props)) errors.push(`unknown field: ${key}`);
    }
  }
  for (const [key, def] of Object.entries(props)) {
    if (!(key in obj)) continue; // already reported above if it was required
    validateField(key, obj[key], def, errors);
  }
  return { ok: errors.length === 0, errors };
}
