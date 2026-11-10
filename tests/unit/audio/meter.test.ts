import { afterEach, expect, it, vi } from 'vitest';
import { createLocalMeter } from '../../../src/audio/meter';
import { Stream } from '../webrtc/fakes';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('local metering samples without an output connection and closes all analysis resources', () => {
  vi.useFakeTimers();
  const analyser = { fftSize: 0, getByteTimeDomainData: vi.fn((samples: Uint8Array) => samples.fill(160)), disconnect: vi.fn() };
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const close = vi.fn(async () => {});
  class Context {
    createMediaStreamSource = vi.fn(() => source);
    createAnalyser = vi.fn(() => analyser);
    close = close;
  }
  vi.stubGlobal('AudioContext', Context);
  const report = vi.fn(); const stop = createLocalMeter(new Stream().asStream(), report);
  vi.advanceTimersByTime(100); expect(report).toHaveBeenCalledWith(0.25);
  expect(source.connect.mock.calls).toEqual([[analyser]]);
  stop(); vi.advanceTimersByTime(1000);
  expect(report).toHaveBeenCalledOnce(); expect(source.disconnect).toHaveBeenCalledOnce(); expect(analyser.disconnect).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
it('partial meter initialization failure closes its context', () => {
  const close = vi.fn(async () => {});
  class Context {
    createMediaStreamSource() { throw new Error('unavailable input'); }
    close = close;
  }
  vi.stubGlobal('AudioContext', Context);
  expect(() => createLocalMeter(new Stream().asStream(), vi.fn())).not.toThrow(); expect(close).toHaveBeenCalledOnce();
});
it('missing AudioContext leaves the optional meter unavailable', () => {
  vi.stubGlobal('AudioContext', undefined); const report = vi.fn(); const stop = createLocalMeter(new Stream().asStream(), report); stop(); expect(report).not.toHaveBeenCalled();
});
