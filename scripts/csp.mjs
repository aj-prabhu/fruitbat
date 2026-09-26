#!/usr/bin/env node
// scripts/csp.mjs (docs/PLAN.md S1-12, packet v4): generates the Content-Security-Policy meta tag
// that goes into every web HTML entry, so the browser itself enforces rule 1's allowlist, not
// just our own code (net.ts) and our own test (privacy.spec.ts).
//
// `connect-src` is re-derived here from spec/network.json (and spec/models.json's url_template
// origins) rather than imported from web/src/engine/net.ts's cspConnectSrc(): this script runs
// as a plain Node script (prebuild), outside the Vite/tsc project, and Playwright's own test
// loader already can't import a TS module that does a bare JSON import (see the comment in
// web/tests/smoke.spec.ts), so a plain-Node script can't reliably import web/src/engine/net.ts
// either. The two are meant to agree; if they ever don't, network.json's own `csp_connect_src`
// field (S1-00b/S0-03) is the tie-breaker documentation, not a third source of truth — this
// script still computes its own list from the raw url_template + redirect_hosts +
// redirect_host_patterns, same inputs net.ts's cspConnectSrc() uses.
//
//   node scripts/csp.mjs          # writes the meta tag into all four HTML files
//   node scripts/csp.mjs --check  # exits 1 if any file's meta tag is not what this would write
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML_FILES = ["web/index.html", "web/skeleton.html", "web/readall.html", "web/summarize.html"].map((f) =>
  path.join(ROOT, f),
);

const START = "<!-- csp:start -->";
const END = "<!-- csp:end -->";

function readJson(rel) {
  return JSON.parse(readFileSync(path.join(ROOT, rel), "utf8"));
}

/** The origin (scheme://host, no path) a `{id}/{revision}/{path}`-style url_template resolves to. */
function templateOrigin(template) {
  const m = /^(https:\/\/[^/]+)\//.exec(template);
  if (!m) throw new Error(`csp.mjs: url_template has no origin: ${template}`);
  return m[1];
}

function buildConnectSrc(network, models) {
  const web = network.web ?? {};
  const hubFiles = web.hub_files ?? {};
  const set = new Set(["'self'"]);
  // The Hub origin: from network.json's own url_template, and from spec/models.json's per-model
  // url_templates (S0-03 pins these separately; today they're identical, but this script doesn't
  // assume that -- it unions whatever origins the pinned files actually declare).
  if (hubFiles.url_template) set.add(templateOrigin(hubFiles.url_template));
  const webModels = models.web ?? {};
  for (const m of [webModels.summarizer, webModels.voice, ...(webModels.summarizer_fallbacks ?? [])]) {
    if (m?.url_template) set.add(templateOrigin(m.url_template));
  }
  for (const host of web.redirect_hosts ?? []) set.add(`https://${host}`);
  for (const pattern of web.redirect_host_patterns ?? []) set.add(`https://${pattern}`);
  return [...set];
}

function buildCsp(connectSrc) {
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    `connect-src ${connectSrc.join(" ")}`,
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join("; ");
}

function metaBlock(csp) {
  return `${START}\n    <meta http-equiv="Content-Security-Policy" content="${csp}">\n    ${END}`;
}

function applyTo(html, block) {
  const re = new RegExp(`${START}[\\s\\S]*?${END}`);
  if (re.test(html)) return html.replace(re, block);
  // First run: insert right after the <title> line, common to every entry file, before the
  // coi-serviceworker script (present with or without a preceding comment across the 4 files).
  const titleRe = /(<title>[^<]*<\/title>\n)/;
  if (!titleRe.test(html)) throw new Error("csp.mjs: no <title> line to anchor the CSP meta after");
  return html.replace(titleRe, `$1    ${block}\n`);
}

function main() {
  const check = process.argv.includes("--check");
  const network = readJson("spec/network.json");
  const models = readJson("spec/models.json");
  const connectSrc = buildConnectSrc(network, models);
  const csp = buildCsp(connectSrc);
  const block = metaBlock(csp);

  let mismatched = [];
  for (const file of HTML_FILES) {
    const before = readFileSync(file, "utf8");
    const after = applyTo(before, block);
    if (before === after) continue;
    if (check) {
      mismatched.push(path.relative(ROOT, file));
    } else {
      writeFileSync(file, after, "utf8");
      process.stdout.write(`csp: wrote ${path.relative(ROOT, file)}\n`);
    }
  }

  if (check) {
    if (mismatched.length) {
      process.stderr.write(`csp --check: out of date: ${mismatched.join(", ")}\n`);
      process.stderr.write(`csp: expected content=\"${csp}\"\n`);
      process.exit(1);
    }
    process.stdout.write(`csp --check: OK (${HTML_FILES.length} files, connect-src: ${connectSrc.join(" ")})\n`);
  }
}

main();
