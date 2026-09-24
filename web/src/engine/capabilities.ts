// Capability probe and URL flags for the summarizer (docs/PLAN.md S1-05, "Two-stage probe",
// "Fake LLM for CI", rule 11). Stage one runs on page load and touches nothing big: WebGPU
// adapter + device only, milliseconds. Stage two (a 1-token generation) lives in the worker and
// runs only after the summarizer has been downloaded on request.

export type Inject = "nogpu" | "devicelost" | "oom" | null;

export interface Flags {
  /** `?llm=fake` selects the scripted worker (CI); anything else is the real one. */
  llm: "real" | "fake";
  /** `?inject=nogpu|devicelost|oom` fault injection (webgpu-local tests). */
  inject: Inject;
  /** `?delay=<ms>` per streamed token in fake mode (default 0). */
  delay_ms: number;
  /** `?fake=<fixture key>` forces a fixture entry in fake mode (e.g. `cutall`). */
  fake: string | null;
  /** `?model=<role>` picks a summarizer tier from spec/models.json (bake-off). */
  model: string | null;
  /** `?prompt=system` tries the system-prompt variant (bake-off only). */
  prompt: "default" | "system";
  /** `?chunk=<tokens>` overrides the chunk budget (bake-off only). */
  chunk: number | null;
}

export function parseFlags(search: string = typeof location !== "undefined" ? location.search : ""): Flags {
  const q = new URLSearchParams(search);
  const inject = q.get("inject");
  const chunk = Number(q.get("chunk"));
  return {
    llm: q.get("llm") === "fake" ? "fake" : "real",
    inject: inject === "nogpu" || inject === "devicelost" || inject === "oom" ? inject : null,
    delay_ms: Math.max(0, Number(q.get("delay") ?? 0) || 0),
    fake: q.get("fake"),
    model: q.get("model"),
    prompt: q.get("prompt") === "system" ? "system" : "default",
    chunk: Number.isFinite(chunk) && chunk > 0 ? chunk : null,
  };
}

export interface GpuProbe {
  ok: boolean;
  available: boolean;
  adapter: boolean;
  device: boolean;
  f16: boolean;
  reason: "ok" | "no_navigator_gpu" | "no_adapter" | "no_device" | "injected_nogpu";
}

/** Stage one: adapter + device only. Never downloads anything. */
export async function probeWebGpu(inject: Inject = null): Promise<GpuProbe> {
  const out: GpuProbe = { ok: false, available: false, adapter: false, device: false, f16: false, reason: "no_navigator_gpu" };
  if (inject === "nogpu") return { ...out, reason: "injected_nogpu" };
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) return out;
  out.available = true;
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { ...out, reason: "no_adapter" };
    out.adapter = true;
    out.f16 = adapter.features.has("shader-f16");
    const device = await adapter.requestDevice();
    out.device = !!device;
    device.destroy();
  } catch {
    return { ...out, reason: out.adapter ? "no_device" : "no_adapter" };
  }
  out.ok = out.device;
  out.reason = out.ok ? "ok" : "no_device";
  return out;
}

/** `navigator.connection.saveData` (rule 11: nothing big downloads unasked when it is on). */
export function saveData(): boolean {
  const c = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return !!c?.saveData;
}

/** Coarse mobile detection (rule 11 / C14: phones get the canned demo, not a 470 MB download). */
export function isMobile(): boolean {
  const ua = navigator.userAgent || "";
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua) === false && window.innerWidth < 900);
}
