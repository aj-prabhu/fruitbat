#!/usr/bin/env node
// S1-13a: fronts `vite preview` with a tiny reverse proxy so a large cached model file can be
// served at a SAME-ORIGIN path instead of through Playwright's route.fulfill().
//
// Why this exists: route.fulfill({ body }) (or { path }) crashes the page/context/browser outright
// -- "Target page, context or browser has been closed" -- once the body is somewhere between
// 70 MB and 92 MB (verified empirically while building this packet, both wasm-ci headless and
// webgpu-local headed, with a minimal repro outside the app entirely: fulfilling a 70 MB slice of
// the real cached file works, the full 92,361,116-byte file does not). This is Playwright/CDP's
// Fetch-domain transport (base64 over the DevTools protocol), not this app or this packet's route
// logic. tests/model-cache.ts's handleRoute() therefore redirects any cached file over
// LARGE_FILE_INLINE_LIMIT_BYTES to this proxy's /__model_cache__/<host>/<path>, instead of
// fulfilling it inline.
//
// Same-origin is required, not incidental: net.ts's guardedFetch only allows a redirect to land
// on an exact pinned Hub URL, a recorded CDN host, or the app's OWN origin (`kind: "same-origin"`,
// always allowed, no allowlist entry needed) -- a different-port local server would need a new
// net.ts redirect-host entry, which is app source this packet does not touch.
//
// Usage: node tests/dev-proxy.mjs <publicPort> <internalPort>
// Spawns `vite preview --port <internalPort> --strictPort` and listens on <publicPort>: requests
// under /__model_cache__/ are served directly from web/.cache/models/ (Range honored); everything
// else is proxied byte-for-byte to <internalPort>.
import { spawn } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [, , publicPortArg, internalPortArg] = process.argv;
const publicPort = Number(publicPortArg);
const internalPort = Number(internalPortArg);
if (!publicPort || !internalPort) {
  console.error("usage: dev-proxy.mjs <publicPort> <internalPort>");
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CACHE_DIR = path.join(ROOT, "web", ".cache", "models");
const SEED_PREFIX = "/__model_cache__/";

const child = spawn("npx", ["vite", "preview", "--port", String(internalPort), "--strictPort"], {
  cwd: path.join(ROOT, "web"),
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGTERM", "SIGINT", "exit"]) {
  process.on(sig, () => {
    try {
      child.kill();
    } catch {
      // already dead
    }
    if (sig !== "exit") process.exit(0);
  });
}

function contentTypeFor(filePath) {
  return filePath.endsWith(".json") ? "application/json" : "application/octet-stream";
}

function serveCacheFile(req, res, urlPath) {
  const rel = decodeURIComponent(urlPath.slice(SEED_PREFIX.length));
  const filePath = path.join(CACHE_DIR, rel);
  if (!filePath.startsWith(CACHE_DIR) || !existsSync(filePath)) {
    res.writeHead(404).end();
    return;
  }
  const total = statSync(filePath).size;
  const contentType = contentTypeFor(filePath);
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    const start = m && m[1] !== "" ? parseInt(m[1], 10) : 0;
    const end = m && m[2] !== "" ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
      res.writeHead(416, { "content-range": `bytes */${total}` }).end();
      return;
    }
    res.writeHead(206, {
      "content-type": contentType,
      "content-length": String(end - start + 1),
      "content-range": `bytes ${start}-${end}/${total}`,
      "accept-ranges": "bytes",
      "access-control-allow-origin": "*",
    });
    createReadStream(filePath, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": String(total),
    "accept-ranges": "bytes",
    "access-control-allow-origin": "*",
  });
  createReadStream(filePath).pipe(res);
}

function proxy(req, res) {
  // "localhost", not "127.0.0.1": vite preview binds to whatever "localhost" resolves to on this
  // machine, which on modern macOS/Node is the IPv6 loopback (::1), not the IPv4 one -- a
  // hardcoded 127.0.0.1 here got ECONNREFUSED even though vite preview was up (found while
  // building this packet).
  const proxyReq = http.request(
    { host: "localhost", port: internalPort, path: req.url, method: req.method, headers: req.headers },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", (err) => {
    console.error("dev-proxy: proxy error", err);
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(proxyReq);
}

const server = http.createServer((req, res) => {
  if (req.url && req.url.startsWith(SEED_PREFIX)) {
    serveCacheFile(req, res, req.url);
    return;
  }
  proxy(req, res);
});
server.listen(publicPort, () => {
  console.log(`dev-proxy: listening on ${publicPort}, forwarding to vite preview on ${internalPort}`);
});
