import { describe, it, expect } from 'vitest';
import { createRequestTracker, createSaveController } from '../src/lifecycle.js';

function harness() {
  const timers = [];
  const calls = [];
  const ctl = createSaveController({
    save: (gen) => new Promise((res, rej) => calls.push({ gen, res, rej })),
    debounceMs: 1500,
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      const i = timers.indexOf(t);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const fire = () => {
    const ts = timers.splice(0);
    ts.forEach((t) => t.fn());
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { ctl, calls, timers, fire, tick };
}

describe('request tracker', () => {
  it('tokens go stale on bump and on project switch', () => {
    const t = createRequestTracker();
    t.setProject('p1');
    const tok = t.token();
    expect(t.isCurrent(tok)).toBe(true);
    t.bump();
    expect(t.isCurrent(tok)).toBe(false);
    const tok2 = t.token();
    t.setProject('p2');
    expect(t.isCurrent(tok2)).toBe(false);
    expect(t.isCurrent(null)).toBe(false);
  });
});

describe('save controller', () => {
  it('debounces two rapid edits into one write and clears dirty on success', async () => {
    const h = harness();
    h.ctl.markChanged();
    h.ctl.markChanged();
    expect(h.timers.length).toBe(1);
    expect(h.ctl.isDirty()).toBe(true);
    h.fire();
    await h.tick();
    expect(h.calls.length).toBe(1);
    expect(h.calls[0].gen).toBe(2);
    h.calls[0].res();
    await h.tick();
    expect(h.ctl.isDirty()).toBe(false);
    expect(h.ctl.state().savedGeneration).toBe(2);
  });
  it('an edit during a pending write keeps dirty and schedules a follow-up save', async () => {
    const h = harness();
    h.ctl.markChanged();
    h.fire();
    await h.tick();
    h.ctl.markChanged();
    h.calls[0].res();
    await h.tick();
    expect(h.ctl.state().savedGeneration).toBe(1);
    expect(h.ctl.isDirty()).toBe(true);
    expect(h.timers.length).toBe(1);
    h.fire();
    await h.tick();
    expect(h.calls[1].gen).toBe(2);
    h.calls[1].res();
    await h.tick();
    expect(h.ctl.isDirty()).toBe(false);
  });
  it('a stale snapshot success never advances savedGeneration past its own generation', async () => {
    const h = harness();
    h.ctl.markChanged();
    h.fire();
    await h.tick();
    h.ctl.markChanged();
    h.ctl.markChanged();
    h.calls[0].res();
    await h.tick();
    expect(h.ctl.state().savedGeneration).toBe(1);
    expect(h.ctl.state().generation).toBe(3);
  });
  it('a failed write keeps dirty and exposes the error; saveNow retries', async () => {
    const h = harness();
    h.ctl.markChanged();
    h.fire();
    await h.tick();
    h.calls[0].rej(new Error('offline'));
    await h.tick();
    expect(h.ctl.isDirty()).toBe(true);
    expect(h.ctl.state().error.message).toBe('offline');
    expect(h.timers.length).toBe(0);
    const p = h.ctl.saveNow();
    await h.tick();
    expect(h.calls[1].gen).toBe(1);
    h.calls[1].res();
    await p;
    expect(h.ctl.isDirty()).toBe(false);
    expect(h.ctl.state().error).toBe(null);
  });
  it('pending uploads keep the project dirty even when generations match', async () => {
    const h = harness();
    h.ctl.setPendingUploads(1);
    expect(h.ctl.isDirty()).toBe(true);
    const p = h.ctl.drain();
    await h.tick();
    h.calls[0].res();
    expect(await p).toBe(false);
    h.ctl.setPendingUploads(0);
    expect(h.ctl.isDirty()).toBe(false);
  });
  it('drain loops until an edit that lands mid-write is also saved', async () => {
    const h = harness();
    h.ctl.markChanged();
    const p = h.ctl.drain();
    await h.tick();
    expect(h.calls[0].gen).toBe(1);
    h.ctl.markChanged();
    h.calls[0].res();
    await h.tick();
    await h.tick();
    expect(h.calls[1].gen).toBe(2);
    h.calls[1].res();
    expect(await p).toBe(true);
    expect(h.ctl.isDirty()).toBe(false);
  });
  describe('tracker epochs and controller dispose', () => {
    it('a token from before an A -> B -> A switch is stale', () => {
      const t = createRequestTracker();
      t.setProject('A');
      const tok = t.token();
      t.setProject('B');
      t.setProject('A');
      expect(t.isCurrent(tok)).toBe(false);
    });
    it('dispose clears the pending timer and silences later onChange calls', async () => {
      const timers = [];
      const changes = [];
      const ctl = createSaveController({
        save: async () => {},
        setTimer: (fn, ms) => {
          const t = { fn, ms };
          timers.push(t);
          return t;
        },
        clearTimer: (t) => {
          const i = timers.indexOf(t);
          if (i >= 0) timers.splice(i, 1);
        },
        onChange: (s) => changes.push(s),
      });
      ctl.markChanged();
      expect(timers.length).toBe(1);
      ctl.dispose();
      expect(timers.length).toBe(0);
      const before = changes.length;
      ctl.setPendingUploads(2);
      expect(changes.length).toBe(before);
      expect(ctl.state().disposed).toBe(true);
    });
  });
});
