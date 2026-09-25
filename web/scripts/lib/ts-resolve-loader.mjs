// Minimal ESM hooks so make-demo.mjs (plain Node, no bundler) can import web/src/core/*.ts
// directly, the way Vite does at build time (docs/PLAN.md S1-09 "or reimplement minimally and
// say so" -- this is the "small shim" alternative instead: real grounding/chunking/parsing code
// runs, unmodified, for the demo generator). It does three things Node's loader doesn't do out of
// the box:
//   1. resolve a bare relative specifier with no extension against the matching .ts/.tsx file
//      (Node's ESM resolver requires an explicit extension; Vite does not).
//   2. resolve/load a Vite `?raw` import (spec/common-words.txt?raw, spec/prompts/*.md?raw) as the
//      file's text content, default-exported -- the same shape Vite's raw loader produces.
//   3. load spec/*.json imports as JSON even without an import attribute (Vite allows a bare
//      `import x from "./y.json"`; Node's loader wants `with { type: "json" }`).
// Nothing else is transformed. Node 22's built-in TypeScript support (on by default, plus
// --experimental-transform-types for the parameter-property syntax core/*.ts uses) strips the
// type syntax itself; this loader only fixes specifier resolution and the two Vite-only import
// shapes the core modules use.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith("?raw")) {
    const base = new URL(specifier.slice(0, -"?raw".length), context.parentURL);
    return { url: `${base.href}?raw`, shortCircuit: true };
  }
  try {
    return await nextResolve(specifier, context);
  } catch (e) {
    if (!(specifier.startsWith(".") || specifier.startsWith("/"))) throw e;
    const base = new URL(specifier, context.parentURL);
    for (const ext of [".ts", ".tsx"]) {
      const candidate = base.href + ext;
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate, context);
    }
    throw e;
  }
}

export async function load(url, context, nextLoad) {
  if (url.endsWith("?raw")) {
    const path = fileURLToPath(url.slice(0, -"?raw".length));
    const text = readFileSync(path, "utf8");
    return { format: "module", source: `export default ${JSON.stringify(text)};`, shortCircuit: true };
  }
  if (/\.json$/.test(new URL(url).pathname)) {
    const path = fileURLToPath(url);
    const text = readFileSync(path, "utf8");
    return { format: "module", source: `export default ${text};`, shortCircuit: true };
  }
  return nextLoad(url, context);
}
