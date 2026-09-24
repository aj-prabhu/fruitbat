// Streaming bullet parser (docs/PLAN.md S1-03, Architecture -> Pipeline: "bullet parser").
//
// Consumes the LLM worker's token stream incrementally and emits a Bullet the moment a `- `
// (also `•`, `*`, or a numbered `1.`/`1)`) line is terminated by a newline. Lines that are not
// bullets are ignored outright (the prompts occasionally produce a stray heading or blank line).
// Per spec/chunking.md rule 4, the prompt only *asks* for a bullet count and length; this parser
// *enforces* the per-chunk caps from spec/dial.json: extra bullets past `max_bullets_per_chunk`
// are dropped (counted in `dropped`), an over-long bullet is kept but counted in `overlength`.
//
// Any `<think>...</think>` block is stripped before lines are ever considered, even when the
// open/close tags land in different push() calls. (A tag itself split across two push() calls,
// e.g. "<th" then "ink>", is not reassembled -- real token streams emit control tags close to
// atomically, and spec/PLAN.md's "thinking off" rule means a well-behaved stream should not emit
// <think> at all; this is a defensive strip, not a guarantee against an adversarial split.)

export interface Bullet {
  text: string;
  index: number;
}

export interface BulletParserOptions {
  max_bullets_per_chunk: number;
  max_words_per_bullet: number;
}

const BULLET_PREFIX = /^(?:[-•*]|\d+[.)])\s+/;
const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

export class BulletParser {
  private buffer = "";
  private insideThink = false;
  private count = 0;
  /** Bullets dropped for exceeding max_bullets_per_chunk. */
  dropped = 0;
  /** Bullets kept but over max_words_per_bullet. */
  overlength = 0;

  constructor(private readonly opts: BulletParserOptions) {}

  /** Feed one chunk of streamed text. Returns any bullets completed by this push. */
  push(tokenText: string): Bullet[] {
    this.ingest(tokenText);
    return this.drainCompleteLines();
  }

  /** End of stream: the buffer's last (possibly newline-less) line, if it is itself a bullet. */
  flush(): Bullet[] {
    const remaining = this.buffer;
    this.buffer = "";
    const bullet = this.consumeLine(remaining);
    return bullet ? [bullet] : [];
  }

  /** Append `text` to the visible buffer, silently dropping anything inside <think>...</think>. */
  private ingest(text: string): void {
    let rest = text;
    for (;;) {
      if (this.insideThink) {
        const end = rest.indexOf(THINK_CLOSE);
        if (end === -1) return; // still hidden; nothing usable in this push
        rest = rest.slice(end + THINK_CLOSE.length);
        this.insideThink = false;
        continue;
      }
      const start = rest.indexOf(THINK_OPEN);
      if (start === -1) {
        this.buffer += rest;
        return;
      }
      this.buffer += rest.slice(0, start);
      rest = rest.slice(start + THINK_OPEN.length);
      this.insideThink = true;
    }
  }

  private drainCompleteLines(): Bullet[] {
    const bullets: Bullet[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      const bullet = this.consumeLine(line);
      if (bullet) bullets.push(bullet);
    }
    return bullets;
  }

  private consumeLine(line: string): Bullet | null {
    const trimmed = line.trim();
    if (!BULLET_PREFIX.test(trimmed)) return null;
    const text = trimmed.replace(BULLET_PREFIX, "").trim();
    if (text.length === 0) return null;
    if (this.count >= this.opts.max_bullets_per_chunk) {
      this.dropped++;
      return null;
    }
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length > this.opts.max_words_per_bullet) {
      this.overlength++;
    }
    const bullet: Bullet = { text, index: this.count };
    this.count++;
    return bullet;
  }
}
