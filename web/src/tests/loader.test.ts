import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "@huggingface/transformers";
import { configureRuntime, load, pinUrl, type PretrainedOptions } from "../engine/loader";
import { pinnedModels } from "../engine/pins";
import { tokenizerReady } from "../core/tokens";

const { summarizer, voice } = pinnedModels().web;
afterEach(() => vi.restoreAllMocks());

describe("loader", () => {
  it("configures Transformers.js once: pinned template, guarded fetch", () => {
    configureRuntime();
    expect(env.remotePathTemplate).toBe("{model}/resolve/{revision}/");
    expect(env.remoteHost).toBe("https://huggingface.co/");
    expect(env.allowLocalModels).toBe(false);
    expect(typeof env.fetch).toBe("function");
  });

  it("pins the tokenizer_config probe that 4.3.0 sends at resolve/main", () => {
    expect(pinUrl(`https://huggingface.co/${summarizer.id}/resolve/main/tokenizer_config.json`)).toBe(
      `https://huggingface.co/${summarizer.id}/resolve/${summarizer.revision}/tokenizer_config.json`,
    );
    expect(pinUrl(`https://huggingface.co/${voice.id}/resolve/main/tokenizer_config.json`)).toContain(`/resolve/${voice.revision}/`);
    expect(pinUrl("https://huggingface.co/someone/else/resolve/main/x.json")).toBe("https://huggingface.co/someone/else/resolve/main/x.json");
  });

  it("passes revision, dtype, device and progress to the factory", async () => {
    const seen: PretrainedOptions[] = [];
    const events: unknown[] = [];
    const out = await load(
      summarizer,
      async (id, options) => {
        seen.push(options);
        options.progress_callback?.({ status: "progress", name: id, file: "x", progress: 50, loaded: 1, total: 2 });
        return { id };
      },
      (p) => events.push(p),
    );
    expect(out).toEqual({ id: summarizer.id });
    expect(seen[0]).toMatchObject({ revision: summarizer.revision, dtype: "q4f16", device: "webgpu" });
    expect(events).toEqual([{ status: "progress", name: summarizer.id, file: "x", progress: 50, loaded: 1, total: 2 }]);
  });

  it("rejects with AbortError and aborts the in-flight request", async () => {
    const ac = new AbortController();
    let sawSignal: AbortSignal | null | undefined;
    const factory = () =>
      new Promise<never>((_, reject) => {
        // simulate Transformers.js issuing a fetch through env.fetch while loading
        void env.fetch(`https://huggingface.co/${summarizer.id}/resolve/${summarizer.revision}/config.json`).catch(reject);
      });
    vi.spyOn(globalThis, "fetch").mockImplementation((_u, init) => {
      sawSignal = init?.signal;
      return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    });
    const p = load(summarizer, factory, undefined, ac.signal);
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(sawSignal?.aborted).toBe(true);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const factory = vi.fn(async () => ({}));
    await expect(load(summarizer, factory, undefined, ac.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(factory).not.toHaveBeenCalled();
  });

  it("serves a second tokenizer load from the cache with zero requests", async () => {
    await tokenizerReady(); // warms the FS cache (or is already warm)
    const spy = vi.spyOn(globalThis, "fetch");
    const { AutoTokenizer } = await import("@huggingface/transformers");
    const tok = await AutoTokenizer.from_pretrained(summarizer.id, { revision: summarizer.revision });
    expect(tok).toBeTruthy();
    const urls = spy.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.startsWith("https://")), "no network on a warm cache").toEqual([]);
  });
});
