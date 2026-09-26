// S1-L0 proof (docs/PLAN.md rule 8): every value in spec/strings/en.json is written (no
// placeholder), every key the web UI asks for exists, and no user-facing string literal lives in
// UI code (web/src/ui/**, app.tsx, intake/**, main.tsx). Exit 1 on any miss. Runs in CI
// (npm run check:strings) and in scripts/release-check.sh.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

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
// Parse each UI file as TSX with the project's own TypeScript and look only at real JSX: text
// nodes, string children and user-facing attributes. A regex over the source mistook generics
// (`useRef<T>(null)`) and comparisons (`a >= b`) for JSX text (found 2026-09-26).
const ts = createRequire(path.join(root, "web/package.json"))("typescript");
const HAS_LETTER = /[A-Za-z]/;
const USER_ATTRS = new Set(["aria-label", "placeholder", "title", "alt", "aria-description"]);
const literalText = (n) =>
  ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)
    ? n.text
    : ts.isTemplateExpression(n)
      ? [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join("")
      : null;
for (const f of uiFiles) {
  const src = readFileSync(f, "utf8");
  const rel = path.relative(root, f);
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t") {
      const a = node.arguments[0];
      if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) usedKeys.add(a.text);
    }
    if (ts.isJsxText(node)) {
      const text = node.text.trim();
      if (text && HAS_LETTER.test(text)) problems.push(`${rel}: JSX text literal "${text.replace(/\s+/g, " ").slice(0, 40)}"`);
    }
    // a string literal as a JSX child expression: `>{"Read it"}<` (Codex review, PR #10)
    if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      const text = literalText(node.expression);
      if (text !== null && HAS_LETTER.test(text)) problems.push(`${rel}: JSX string child "${text.slice(0, 40)}"`);
    }
    // user-facing attributes with a literal value, quoted or as a string expression
    if (ts.isJsxAttribute(node) && USER_ATTRS.has(node.name.getText(sf)) && node.initializer) {
      const init = node.initializer;
      const text = ts.isStringLiteral(init) ? init.text : ts.isJsxExpression(init) && init.expression ? literalText(init.expression) : null;
      if (text !== null && HAS_LETTER.test(text)) problems.push(`${rel}: literal ${node.name.getText(sf)}="${text.slice(0, 40)}"`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
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
