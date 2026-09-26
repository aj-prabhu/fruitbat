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
    voice: PinnedModel & { voices_vendored: { path: string; files: string[] } };
    libraries: Record<string, string>;
  };
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
  const { summarizer, voice } = pinnedModels().web;
  return [...summarizer.files.map((f) => pinnedFileUrl(summarizer, f.path)), ...voice.files.map((f) => pinnedFileUrl(voice, f.path))];
}
