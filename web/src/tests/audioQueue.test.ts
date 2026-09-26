import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioQueue, type BufferLike, type ContextLike, type SourceLike } from "../engine/audioQueue";

// A fake AudioContext: the clock is set by the test; sources record start/stop calls.
class FakeSource implements SourceLike {
  buffer: BufferLike | null = null;
  onended: ((ev: Event) => unknown) | null = null;
  startedAt: number | null = null;
  stopped = false;
  connect() {
    return undefined;
  }
  start(when?: number) {
    this.startedAt = when ?? 0;
  }
  stop() {
    this.stopped = true;
  }
  end() {
    this.onended?.(new Event("ended"));
  }
}
class FakeContext implements ContextLike {
  currentTime = 0;
  state = "running";
  destination = {};
  sources: FakeSource[] = [];
  createBuffer(_c: number, length: number, sampleRate: number): BufferLike {
    return { duration: length / sampleRate, copyToChannel() {} };
  }
  createBufferSource(): SourceLike {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  async resume() {
    this.state = "running";
  }
  async suspend() {
    this.state = "suspended";
  }
}

const SR = 24000;
const item = (runId: number, seq: number, seconds: number, start = seq * 10) => ({
  runId,
  seq,
  pcm: new Float32Array(Math.round(seconds * SR)),
  sampleRate: SR,
  start,
  end: start + 10,
});

describe("AudioQueue", () => {
  let ctx: FakeContext;
  beforeEach(() => {
    ctx = new FakeContext();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules items back to back in order", () => {
    const q = new AudioQueue(ctx);
    q.beginRun(1);
    expect(q.enqueue(item(1, 0, 1))).toBe(true);
    expect(q.enqueue(item(1, 1, 2))).toBe(true);
    expect(q.enqueue(item(1, 2, 0.5))).toBe(true);
    expect(ctx.sources.map((s) => s.startedAt)).toEqual([0, 1, 3]);
    expect(q.aheadSeconds()).toBeCloseTo(3.5, 5);
    expect(q.totalSeconds).toBeCloseTo(3.5, 5);
  });

  it("bounds the PCM scheduled ahead and the requests in flight", () => {
    const q = new AudioQueue(ctx, { maxAheadSeconds: 2, maxInFlight: 3 });
    q.beginRun(1);
    expect(q.canAccept()).toBe(true);
    q.enqueue(item(1, 0, 1));
    q.enqueue(item(1, 1, 1.5));
    expect(q.aheadSeconds()).toBeCloseTo(2.5, 5);
    expect(q.canAccept()).toBe(false);
    ctx.currentTime = 1; // playback advanced
    expect(q.aheadSeconds()).toBeCloseTo(1.5, 5);
    expect(q.canAccept()).toBe(true);
    q.requestSent();
    q.requestSent();
    q.requestSent();
    expect(q.requestsInFlight).toBe(3);
    expect(q.canAccept()).toBe(false);
    q.requestSettled();
    expect(q.canAccept()).toBe(true);
  });

  it("audio still being synthesized counts against the ahead cap until its request settles", () => {
    const q = new AudioQueue(ctx, { maxAheadSeconds: 30, maxInFlight: 3 });
    q.beginRun(1);
    q.enqueue(item(1, 0, 20));
    expect(q.canAccept()).toBe(true);
    const a = q.requestSent(8);
    expect(q.canAccept()).toBe(true); // 20 + 8 < 30
    expect(q.canAccept(5)).toBe(false); // the next segment would not fit: 20 + 8 + 5 > 30
    q.requestSent(8);
    expect(q.canAccept()).toBe(false); // 20 + 16 >= 30
    q.requestSettled(a);
    expect(q.canAccept()).toBe(true);
  });

  it("a request from a replaced run does not touch the new run's counts", () => {
    const q = new AudioQueue(ctx, { maxAheadSeconds: 30, maxInFlight: 3 });
    q.beginRun(1);
    const old = q.requestSent(10);
    q.beginRun(2);
    q.requestSent(10);
    expect(q.requestsInFlight).toBe(1);
    q.requestSettled(old); // the old run's request finishing late
    expect(q.requestsInFlight).toBe(1);
  });

  it("a segment longer than the cap still goes once the queue is nearly empty", () => {
    const q = new AudioQueue(ctx, { maxAheadSeconds: 30, maxInFlight: 3 });
    q.beginRun(1);
    expect(q.canAccept(45)).toBe(true); // nothing scheduled, nothing in flight
    q.enqueue(item(1, 0, 20));
    expect(q.canAccept(45)).toBe(false);
  });

  it("stop() silences every scheduled source, drops the rest, and invalidates the run quickly", () => {
    const q = new AudioQueue(ctx);
    q.beginRun(1);
    q.enqueue(item(1, 0, 1));
    q.enqueue(item(1, 1, 1));
    const ms = q.stop();
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThan(200);
    expect(ctx.sources.every((s) => s.stopped)).toBe(true);
    expect(q.aheadSeconds()).toBe(0);
    expect(q.playing()).toBeNull();
    expect(q.enqueue(item(1, 2, 1))).toBe(false); // stale run
  });

  it("drops an item whose runId is stale", () => {
    const q = new AudioQueue(ctx);
    q.beginRun(2);
    expect(q.enqueue(item(1, 0, 1))).toBe(false);
    expect(q.enqueue(item(2, 0, 1))).toBe(true);
    expect(ctx.sources.length).toBe(1);
  });

  it("beginRun() for a new run stops the previous one", () => {
    const q = new AudioQueue(ctx);
    q.beginRun(1);
    q.enqueue(item(1, 0, 5));
    q.beginRun(2);
    expect(ctx.sources[0].stopped).toBe(true);
    expect(q.enqueue(item(2, 0, 1))).toBe(true);
  });

  it("fires onStart and onEnd with source offsets and the context clock", () => {
    const starts: number[] = [];
    const ends: number[] = [];
    const q = new AudioQueue(ctx, { onStart: (e) => starts.push(e.start), onEnd: (e) => ends.push(e.end) });
    q.beginRun(1);
    q.enqueue(item(1, 0, 1, 0));
    q.enqueue(item(1, 1, 1, 10));
    expect(starts).toEqual([0]); // the first item starts at the current clock, at once
    vi.advanceTimersByTime(1000); // wall time alone changes nothing...
    expect(starts).toEqual([0]);
    ctx.currentTime = 1; // ...the audio clock does
    vi.advanceTimersByTime(50);
    expect(starts).toEqual([0, 10]);
    ctx.sources[0].end();
    expect(ends).toEqual([10]);
    ctx.sources[1].end();
    expect(ends).toEqual([10, 20]);
    expect(q.ended).toBe(2);
  });

  it("start notifications freeze while the context is suspended (audio clock, not wall clock)", async () => {
    const starts: number[] = [];
    const q = new AudioQueue(ctx, { onStart: (e) => starts.push(e.seq) });
    q.beginRun(1);
    q.enqueue(item(1, 0, 1));
    q.enqueue(item(1, 1, 1));
    q.enqueue(item(1, 2, 1));
    expect(starts).toEqual([0]);
    await q.pause(); // a suspended context's currentTime stands still
    vi.advanceTimersByTime(5000);
    expect(starts).toEqual([0]);
    await q.resume();
    ctx.currentTime = 2.01;
    vi.advanceTimersByTime(50);
    expect(starts).toEqual([0, 1, 2]);
  });

  it("records the worst underrun gap between items", () => {
    const q = new AudioQueue(ctx);
    q.beginRun(1);
    q.enqueue(item(1, 0, 1));
    ctx.currentTime = 3; // the next PCM arrives 2 s late
    q.enqueue(item(1, 1, 1));
    expect(ctx.sources[1].startedAt).toBe(3);
    expect(q.maxGapMs).toBeCloseTo(2000, 3);
  });

  it("skip() silences the current item and pulls the rest forward", () => {
    const q = new AudioQueue(ctx);
    q.beginRun(1);
    q.enqueue(item(1, 0, 2));
    q.enqueue(item(1, 1, 1));
    q.enqueue(item(1, 2, 1));
    ctx.currentTime = 0.5;
    expect(q.playing()?.seq).toBe(0);
    expect(q.skip()).toBe(true);
    expect(ctx.sources[0].stopped).toBe(true);
    // the two remaining items were rescheduled on new sources starting now
    const restarted = ctx.sources.slice(3).map((s) => s.startedAt);
    expect(restarted).toEqual([0.5, 1.5]);
    expect(q.aheadSeconds()).toBeCloseTo(2, 5);
    expect(q.playing()?.seq).toBe(1);
  });

  it("fires onDrain once when the run is closed and the last item has ended", () => {
    const drained: number[] = [];
    const q = new AudioQueue(ctx, { onDrain: (id) => drained.push(id) });
    q.beginRun(7);
    q.enqueue(item(7, 0, 1));
    q.close();
    expect(drained).toEqual([]);
    ctx.sources[0].end();
    expect(drained).toEqual([7]);
    ctx.sources[0].end();
    expect(drained).toEqual([7]);
  });

  it("pause and resume go to the context", async () => {
    const q = new AudioQueue(ctx);
    await q.pause();
    expect(ctx.state).toBe("suspended");
    await q.resume();
    expect(ctx.state).toBe("running");
  });
});
