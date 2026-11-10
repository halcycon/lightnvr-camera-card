import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireStartup } from '../../../src/playback/startup';
import { controllers, deferred, flush, harness, mockClient } from './fixture';

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  const cleanup = Promise.all(controllers.splice(0).map(c => c.dispose()));
  await vi.advanceTimersByTimeAsync(2100); await cleanup;
  expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
describe('shared bounded FIFO startup admission', () => {
  it('starts ten cards fairly with at most two pending first frames per NVR', async () => {
    const api = mockClient(); const cards = Array.from({ length: 10 }, () => harness({ api }));
    const starts = cards.map(h => h.start()); await flush();
    expect(cards.map(h => h.adapters.length)).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
    const admitted: number[] = [0, 1];
    for (let i = 0; i < 8; i++) {
      cards[i]!.last().frame(); await flush();
      expect(cards[i + 2]!.adapters).toHaveLength(1); admitted.push(i + 2);
      expect(cards.slice(i + 3).every(h => h.adapters.length === 0)).toBe(true);
      expect(cards.filter(h => h.controller.snapshot.state === 'connecting')).toHaveLength(2);
    }
    cards[8]!.last().frame(); cards[9]!.last().frame(); await Promise.all(starts);
    expect(admitted).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(cards.every(h => h.controller.snapshot.state === 'playing')).toBe(true);
    expect(api.client.dispose).not.toHaveBeenCalled(); expect(api.client.control).not.toHaveBeenCalled();
  });
  it('removing a queued card preserves both active cards and remaining queue order', async () => {
    const api = mockClient(), cards = Array.from({ length: 5 }, () => harness({ api }));
    const starts = cards.map(h => h.start()); await flush();
    await cards[2]!.controller.dispose(); await flush();
    expect(cards[0]!.last().stop).not.toHaveBeenCalled(); expect(cards[1]!.last().stop).not.toHaveBeenCalled();
    cards[0]!.last().frame(); await flush(); expect(cards[3]!.adapters).toHaveLength(1); expect(cards[4]!.adapters).toHaveLength(0);
    cards[1]!.last().frame(); await flush(); expect(cards[4]!.adapters).toHaveLength(1); expect(cards[2]!.adapters).toHaveLength(0);
    await Promise.all(starts); expect(api.client.dispose).not.toHaveBeenCalled();
  });
  it('cancelling noncooperative in-flight setup frees its slot for the next card', async () => {
    const api = mockClient(), pending = deferred<void>();
    const first = harness({ api, setup: () => pending.promise }), second = harness({ api }), third = harness({ api });
    const starts = [first.start(), second.start(), third.start()]; await flush();
    expect(third.adapters).toHaveLength(0); await first.controller.stop(); await flush();
    expect(third.adapters).toHaveLength(1); expect(second.last().stop).not.toHaveBeenCalled();
    pending.resolve(); await Promise.all(starts); first.last().frame(); expect(first.controller.snapshot.state).toBe('stopped');
  });
  it('profiles use independent pools and releases are idempotent', async () => {
    const abort = new AbortController();
    const [one, two, other] = await Promise.all([acquireStartup('profile-one', abort.signal), acquireStartup('profile-one', abort.signal), acquireStartup('profile-two', abort.signal)]);
    const waiter = vi.fn(); const pending = acquireStartup('profile-one', abort.signal).then(r => { waiter(); return r; }); await flush();
    expect(waiter).not.toHaveBeenCalled(); one(); one(); const next = await pending;
    expect(waiter).toHaveBeenCalledOnce(); two(); other(); next(); abort.abort();
  });
  it('bounds queue wait, supports cancellation and leaves no orphan queue entries', async () => {
    const holders = new AbortController(), cancelled = new AbortController(), timeout = new AbortController();
    const [one, two] = await Promise.all([acquireStartup('bounded', holders.signal), acquireStartup('bounded', holders.signal)]);
    const aborted = acquireStartup('bounded', cancelled.signal); const abortedCheck = expect(aborted).rejects.toMatchObject({ failure: { code: 'cancelled' } });
    const timed = acquireStartup('bounded', timeout.signal, 150); const timedCheck = expect(timed).rejects.toMatchObject({ failure: { code: 'timeout' } });
    cancelled.abort(); await abortedCheck; await vi.advanceTimersByTimeAsync(150); await timedCheck;
    one(); two(); const fresh = await acquireStartup('bounded', holders.signal); fresh();
    holders.abort(); timeout.abort();
    await expect(acquireStartup('bounded', holders.signal)).rejects.toMatchObject({ failure: { code: 'cancelled' } });
  });
  it('a failing first card requeues fallback behind cards already waiting', async () => {
    const api = mockClient(), cards = Array.from({ length: 4 }, () => harness({ api }));
    const starts = cards.map(h => h.start()); await flush(); cards[0]!.last().fail('ice'); await flush();
    expect(cards[2]!.adapters).toHaveLength(1); expect(cards[0]!.adapters).toHaveLength(1);
    cards[1]!.last().frame(); await flush(); expect(cards[3]!.adapters).toHaveLength(1); expect(cards[0]!.adapters).toHaveLength(1);
    cards[2]!.last().frame(); await flush(); expect(cards[0]!.adapters.map(a => a.kind)).toEqual(['webrtc', 'mse']);
    await Promise.all(starts);
  });
});
