// Typed view of spec/models.json (rule 4: the spec is the source of truth; nothing here is hand-typed).
import models from "../../../spec/models.json";

export interface PinnedFile {
  path: string;
  bytes: number;
}
export interface PinnedModel {
  id: string;
  revision: string;
  dtype: string;
  device: string;
  files: PinnedFile[];
  url_template: string;
}
export interface PinnedModels {
  web: {
    summarizer: PinnedModel;
    /** fallback-a, fallback-b, low-end (spec/models.json, S0-03). */
    summarizer_fallbacks?: (PinnedModel & { role: string })[];
    voice: PinnedModel & { voices_vendored: { path: string; files: string[] }; tts_phoneme_limit: number; tts_phoneme_target: number };
    libraries: Record<string, string>;
  };
}

/** Every summarizer tier the web target may load: the default first, then the fallbacks. */
export function summarizerTiers(): (PinnedModel & { role: string })[] {
  const { summarizer, summarizer_fallbacks } = pinnedModels().web;
  return [{ ...summarizer, role: "default" }, ...(summarizer_fallbacks ?? [])];
}

export function pinnedModels(): PinnedModels {
  return models as unknown as PinnedModels;
}

/** Exact file URL for a pinned model file, e.g. https://huggingface.co/<id>/resolve/<sha>/<path>. */
export function pinnedFileUrl(model: PinnedModel, path: string): string {
  return model.url_template.replace("{id}", model.id).replace("{revision}", model.revision).replace("{path}", path);
}

/** Every exact remote file URL the web target may fetch, from models.json. */
export function pinnedFileUrls(): string[] {
  // The fallback tiers are pinned too (S1-05): the allowlist covers every tier the loader may pick.
  const { voice } = pinnedModels().web;
  const models: PinnedModel[] = [...summarizerTiers(), voice];
  return models.flatMap((m) => m.files.map((f) => pinnedFileUrl(m, f.path)));
}
