// S1-L0 proof (docs/PLAN.md rule 8): every value in spec/strings/en.json is written (no
// placeholder), every key the web UI asks for exists, and no user-facing string literal lives in
// UI code (web/src/ui/**, app.tsx, intake/**, main.tsx). Exit 1 on any miss. Runs in
// scripts/release-check.sh.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const strings = JSON.parse(readFileSync(path.join(root, "spec/strings/en.json"), "utf8")).strings;
const problems = [];

for (const [k, v] of Object.entries(strings)) {
  if (typeof v !== "string" || v.trim() === "" || /TODO\(/.test(v)) problems.push(`placeholder or empty value: ${k}`);
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(f) && !/\.test\.|\.spec\./.test(f)) out.push(p);
  }
  return out;
}
const uiFiles = [
  ...walk(path.join(root, "web/src/ui")),
  ...walk(path.join(root, "web/src/intake")),
  ...[path.join(root, "web/src/app.tsx"), path.join(root, "web/src/main.tsx")].filter(existsSync),
];
const usedKeys = new Set();
for (const f of uiFiles) {
  const src = readFileSync(f, "utf8");
  const rel = path.relative(root, f);
  for (const m of src.matchAll(/\bt\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) usedKeys.add(m[1]);
  // JSX text nodes with letters, outside expressions (multiline too): `>Some words<`
  for (const m of src.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)) {
    const text = m[1].trim();
    if (text && !/^[\s\S]*=>/.test(text)) problems.push(`${rel}: JSX text literal "${text.replace(/\s+/g, " ").slice(0, 40)}"`);
  }
  // string literals as a JSX child expression: `>{"Read it"}<` (Codex review, PR #10)
  for (const m of src.matchAll(/>\s*\{\s*(["'`])([^"'`]*[A-Za-z][^"'`]*)\1\s*\}\s*</g)) {
    problems.push(`${rel}: JSX string child "${m[2].slice(0, 40)}"`);
  }
  // user-facing attributes with a literal value, quoted or as a string expression
  for (const m of src.matchAll(/\b(aria-label|placeholder|title|alt|aria-description)\s*=\s*(?:"([^"]*[A-Za-z][^"]*)"|\{\s*(["'`])([^"'`]*[A-Za-z][^"'`]*)\3\s*\})/g)) {
    problems.push(`${rel}: literal ${m[1]}="${(m[2] ?? m[4]).slice(0, 40)}"`);
  }
}
// Keys the UI reads from the spec rather than from a literal t("..."): the dial's label_key values
// (Codex review, PR #10).
const dial = JSON.parse(readFileSync(path.join(root, "spec/dial.json"), "utf8"));
for (const l of dial.levels ?? []) if (l.label_key) usedKeys.add(l.label_key);
for (const k of usedKeys) if (!(k in strings)) problems.push(`missing key used by UI: ${k}`);

if (problems.length) {
  for (const p of problems) console.error(p);
  console.error(`strings-check: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`strings-check: OK (${Object.keys(strings).length} strings, ${uiFiles.length} UI files, ${usedKeys.size} keys used)`);
