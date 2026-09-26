import { afterEach, describe, expect, it, vi } from "vitest";
import { NetworkPolicyError, allowedUrl, cspConnectSrc, exactUrls, guardedFetch, netStats } from "../engine/net";
import { pinnedFileUrl, pinnedModels } from "../engine/pins";

const { summarizer, voice } = pinnedModels().web;
const CONFIG = pinnedFileUrl(summarizer, "config.json");
const ONNX = pinnedFileUrl(summarizer, "onnx/model_q4f16.onnx_data");

afterEach(() => vi.restoreAllMocks());

describe("allowedUrl", () => {
  it("allows every pinned file URL exactly", () => {
    for (const u of exactUrls()) expect(allowedUrl(u)).toMatchObject({ ok: true, kind: "exact" });
    expect(exactUrls().size).toBeGreaterThanOrEqual(summarizer.files.length + voice.files.length);
  });
  it("rejects a host that is not on the list", () => {
    expect(allowedUrl("https://example.com/onnx-community/Qwen3.5-0.8B-Text-ONNX/resolve/1e45daba048899e7f771657ada617ec49350aa91/config.json")).toMatchObject({ ok: false });
    expect(allowedUrl("https://evil.cdn.hf.co.example.net/x")).toMatchObject({ ok: false });
  });
  it("rejects a query string on a pinned file URL (canary in the URL)", () => {
    expect(allowedUrl(`${CONFIG}?text=CANARY-7f3a`)).toMatchObject({ ok: false });
    expect(allowedUrl(`${CONFIG}#CANARY-7f3a`).ok).toBe(true); // fragments never leave the page
  });
  it("rejects any resolve/main URL, including the tokenizer_config probe", () => {
    expect(allowedUrl(`https://huggingface.co/${summarizer.id}/resolve/main/tokenizer_config.json`)).toMatchObject({ ok: false, reason: "unpinned revision" });
  });
  it("rejects an unpinned revision or file of a pinned model", () => {
    expect(allowedUrl(`https://huggingface.co/${summarizer.id}/resolve/0000000000000000000000000000000000000000/config.json`).ok).toBe(false);
    expect(allowedUrl(pinnedFileUrl(summarizer, "onnx/model_fp16.onnx")).ok).toBe(false);
  });
  it("allows the Hub's recorded redirect targets for a pinned file only", () => {
    const lfs = `https://us.aws.cdn.hf.co/xet-bridge-us/abc/def?user_id=public&X-Xet-Cas-Uid=public&response-content-disposition=inline%3B%20filename*%3DUTF-8%27%27model_q4f16.onnx_data%3B%20filename%3D%22model_q4f16.onnx_data%22%3B&Expires=1&Policy=p&Signature=s&Key-Pair-Id=k&Hash-Algorithm=SHA256`;
    expect(allowedUrl(lfs)).toMatchObject({ ok: true, kind: "redirect" });
    expect(allowedUrl("https://eu.aws.cdn.hf.co/xet-bridge-eu/abc/def?response-content-disposition=filename%3D%22model_q4f16.onnx_data%22")).toMatchObject({ ok: true, kind: "redirect" });
    const notOurs = lfs.replace("model_q4f16.onnx_data", "model_fp16.onnx");
    expect(allowedUrl(notOurs).ok).toBe(false);
    const extraParam = `${lfs}&text=CANARY-7f3a`;
    expect(allowedUrl(extraParam)).toMatchObject({ ok: false, reason: "redirect query parameter not recorded" });
    const cache = `https://huggingface.co/api/resolve-cache/models/${summarizer.id}/${summarizer.revision}/config.json?${encodeURIComponent(`/${summarizer.id}/resolve/${summarizer.revision}/config.json`)}=&etag=%22abc%22`;
    expect(allowedUrl(cache)).toMatchObject({ ok: true, kind: "redirect" });
    expect(allowedUrl(`${cache}&x=1`).ok).toBe(false);
  });
  it("lists CSP connect-src hosts from the spec", () => {
    const csp = cspConnectSrc();
    expect(csp).toContain("'self'");
    expect(csp).toContain("https://huggingface.co");
    expect(csp.some((h) => h.includes("cdn.hf.co"))).toBe(true);
  });
});

describe("guardedFetch", () => {
  it("never calls fetch for a rejected URL", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("x"));
    const before = netStats.rejected;
    await expect(guardedFetch("https://example.com/leak?text=CANARY-7f3a")).rejects.toBeInstanceOf(NetworkPolicyError);
    await expect(guardedFetch(`${CONFIG}?text=CANARY-7f3a`)).rejects.toBeInstanceOf(NetworkPolicyError);
    await expect(guardedFetch(CONFIG, { method: "POST", body: "CANARY-7f3a" })).rejects.toThrow(/only GET/);
    expect(spy).not.toHaveBeenCalled();
    expect(netStats.rejected).toBe(before + 3);
  });
  it("calls fetch with GET, no credentials, and passes the signal through", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => {
      expect(init?.method).toBe("GET");
      expect(init?.credentials).toBe("omit");
      return new Response("ok", { status: 200 });
    });
    const ac = new AbortController();
    const res = await guardedFetch(ONNX, { signal: ac.signal });
    expect(res.status).toBe(200);
    expect(spy.mock.calls[0][1]?.signal).toBe(ac.signal);
  });
  it("reads the final URL from the service worker's header when res.url is empty", async () => {
    const off = "https://evil.example/x";
    const fake = vi.fn(async () => {
      const r = new Response("", { status: 200, headers: { "x-fruitbat-final-url": off } });
      Object.defineProperty(r, "url", { value: url }); // the browser fills url with the original request
      return r;
    });
    vi.stubGlobal("fetch", fake);
    const url = [...exactUrls()][0];
    await expect(guardedFetch(url)).rejects.toThrow(/redirected off-list/);
    vi.unstubAllGlobals();
  });

  it("throws after the fact if the browser followed a redirect off the list", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const r = new Response("x", { status: 200 });
      Object.defineProperty(r, "url", { value: "https://example.com/somewhere" });
      return r;
    });
    await expect(guardedFetch(ONNX)).rejects.toThrow(/redirected off-list/);
  });
});
