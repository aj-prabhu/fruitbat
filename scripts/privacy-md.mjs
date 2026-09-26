#!/usr/bin/env node
// scripts/privacy-md.mjs (docs/PLAN.md S1-12): generates PRIVACY.md from spec/network.json, so
// the human-readable privacy statement cannot drift from the machine-enforced allowlist (net.ts,
// scripts/csp.mjs, the privacy e2e). Plain words, no marketing.
//
//   node scripts/privacy-md.mjs          # writes PRIVACY.md
//   node scripts/privacy-md.mjs --check  # exits 1 if PRIVACY.md is not what this would write
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "PRIVACY.md");

function readJson(rel) {
  return JSON.parse(readFileSync(path.join(ROOT, rel), "utf8"));
}

function hostList(hosts, patterns) {
  return [...hosts, ...patterns].join(", ");
}

function build(network) {
  const web = network.web ?? {};
  const mac = network.mac ?? {};
  const redirectHosts = web.redirect_hosts ?? [];
  const redirectPatterns = web.redirect_host_patterns ?? [];
  const bugPrefix = mac.bug_report?.prefix ?? "https://github.com/aj-prabhu/fruitbat/issues/new";
  const appcast = mac.updates?.appcast ?? "";

  return `# Privacy

Nothing you read leaves your device. No telemetry. This file is generated from \`spec/network.json\`
(\`scripts/privacy-md.mjs --check\` runs in CI, so it cannot drift out of sync) -- don't hand-edit it.

## Web (the browser demo)

The web app makes network requests for exactly two things, and nothing else:

1. **Downloading the AI models it needs**, straight from the Hugging Face Hub, at an exact,
   pinned file version -- never the latest version of a model, so nothing changes under you between
   visits. Every file it can ever request is listed in \`spec/network.json\`.
2. **Following the Hub's own redirects** for those same files, to one of: ${hostList(redirectHosts, redirectPatterns)}.
   These are Hugging Face's own file-serving infrastructure, not a third party we chose.

That's it. Every request is a \`GET\`. No analytics, no crash reporting, no ping of any kind. The
text you paste or select, the bullets it generates, and the audio it plays are never sent
anywhere -- they exist only in your browser's memory while the page is open. A Content-Security-Policy
on every page enforces this list in your browser for the page itself. The summarizer and the voice
run in background workers and a static host can't give those their own policy. There every request
goes through one allowlist in our code, and our privacy test records every request the page and its
workers make.

## macOS app

The Mac app makes the same two web requests above, plus:

3. **License checks (Polar).** If you've entered a license key, the app validates it at most once
   a week. A failed check nags you to fix it -- it never locks you out of the app.
4. **Update checks (Sparkle).** The app checks a fixed URL (\`${appcast}\`) for new releases. This is
   disclosed the first time you open the app and can be switched off in Settings at any time.
5. **A bug report, only if you choose to send one.** It opens a prefilled GitHub issue in your own
   browser; you review it and press send yourself. The app never files it for you.

Logs on both platforms are numbers and category names only -- never the text you read, the bullets
generated from it, audio, file names, or URLs of what you were reading.

## The exact list

\`spec/network.json\` is the source of truth: every exact URL, every redirect host, every allowed
method, per target. This file is generated from it.
`;
}

function main() {
  const check = process.argv.includes("--check");
  const network = readJson("spec/network.json");
  const content = build(network);

  if (check) {
    let current = "";
    try {
      current = readFileSync(OUT, "utf8");
    } catch {
      // missing file: current stays "", which will not match and reports FAIL below
    }
    if (current !== content) {
      process.stderr.write("privacy-md --check: PRIVACY.md is out of date with spec/network.json\n");
      process.exit(1);
    }
    process.stdout.write("privacy-md --check: OK\n");
    return;
  }

  writeFileSync(OUT, content, "utf8");
  process.stdout.write(`privacy-md: wrote ${path.relative(ROOT, OUT)}\n`);
}

main();
