import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTalkController } from '../../../src/audio';
import { registerSender } from '../../../src/audio/sender-lease';
import type { TalkState } from '../../../src/contracts';
import { deferred, flush, Sender, Stream, Track } from '../webrtc/fakes';

function setup() {
  const streams: Stream[] = [];
  const acquire = vi.fn(async () => { const stream = new Stream([new Track().asTrack()]); streams.push(stream); return stream.asStream(); });
  const meterStop = vi.fn();
  let report!: (level: number) => void;
  const meter = vi.fn((_stream: MediaStream, callback: (level: number) => void) => { report = callback; return meterStop; });
  const talk = createTalkController({ getUserMedia: acquire, isSecureContext: () => true, createMeter: meter });
  const sender = new Sender(); const abort = new AbortController();
  return { talk, sender, abort, acquire, streams, meter, meterStop, report: (n: number) => report(n) };
}
afterEach(() => vi.restoreAllMocks());
describe('microphone ownership and cancellation', () => {
  it('constructing, reading and subscribing do not acquire a microphone', () => {
    const s = setup(); const listener = vi.fn(); const unsubscribe = s.talk.subscribe(listener);
    expect(s.talk.state).toEqual({ active: false, pending: false }); expect(s.acquire).not.toHaveBeenCalled();
    expect(Object.isFrozen(listener.mock.calls[0]![0])).toBe(true); unsubscribe();
  });
  it('emits immutable pending, active, meter and stopped states', async () => {
    const s = setup(); const states: Readonly<TalkState>[] = []; s.talk.subscribe(state => states.push(state));
    await s.talk.start(s.sender.asSender(), s.abort.signal); s.report(0.4);
    expect(states).toContainEqual({ active: false, pending: true });
    expect(s.talk.state).toEqual({ active: true, pending: false, level: 0.4 });
    expect(states.every(Object.isFrozen)).toBe(true);
    await s.talk.stop(); expect(s.meterStop).toHaveBeenCalledOnce();
    expect(s.streams[0]!.tracks[0]!.readyState).toBe('ended');
    expect(s.sender.replaceTrack).toHaveBeenLastCalledWith(null);
    s.report(1); expect(s.talk.state).toEqual({ active: false, pending: false });
  });
  it.each(['stop', 'abort', 'dispose'] as const)('%s during delayed permission stops the late stream without sending', async action => {
    const s = setup(), pending = deferred<MediaStream>(), late = new Track(); s.acquire.mockReturnValueOnce(pending.promise);
    const start = s.talk.start(s.sender.asSender(), s.abort.signal);
    if (action === 'abort') s.abort.abort(); else await s.talk[action]();
    await start; pending.resolve(new Stream([late.asTrack()]).asStream()); await flush();
    expect(late.stop).toHaveBeenCalledOnce(); expect(s.sender.replaceTrack).not.toHaveBeenCalled(); expect(s.meter).not.toHaveBeenCalled();
  });
  it('serializes release during attach before the next press on the same sender', async () => {
    const s = setup(), attached = deferred<void>(); s.sender.replaceTrack.mockImplementationOnce(() => attached.promise);
    const first = s.talk.start(s.sender.asSender(), s.abort.signal); await flush();
    const oldTrack = s.streams[0]!.tracks[0]!; const stopped = s.talk.stop();
    expect(oldTrack.readyState).toBe('ended'); expect(oldTrack.enabled).toBe(false);
    const second = s.talk.start(s.sender.asSender(), s.abort.signal); await flush();
    expect(s.sender.replaceTrack).toHaveBeenCalledTimes(1); attached.resolve();
    await Promise.all([first, second, stopped]);
    expect(s.sender.replaceTrack.mock.calls).toEqual([[oldTrack], [null], [s.streams[1]!.tracks[0]]]);
    expect(s.talk.state.active).toBe(true); await s.talk.dispose();
  });
  it('overlapping permission requests stop stale success and ignore stale denial', async () => {
    const s = setup(), old = deferred<MediaStream>(), denied = deferred<MediaStream>();
    s.acquire.mockReturnValueOnce(old.promise).mockReturnValueOnce(denied.promise);
    const first = s.talk.start(s.sender.asSender(), s.abort.signal);
    const second = s.talk.start(s.sender.asSender(), s.abort.signal);
    await s.talk.start(s.sender.asSender(), s.abort.signal);
    const track = new Track(); old.resolve(new Stream([track.asTrack()]).asStream()); denied.reject(new DOMException('private reason', 'NotAllowedError'));
    await Promise.all([first, second]); await flush();
    expect(track.stop).toHaveBeenCalledOnce(); expect(s.talk.state.active).toBe(true); expect(s.talk.state.failure).toBeUndefined(); await s.talk.dispose();
  });
  it('reconnection cleanup stays on the old sender', async () => {
    const s = setup(), attached = deferred<void>(); s.sender.replaceTrack.mockImplementationOnce(() => attached.promise);
    const first = s.talk.start(s.sender.asSender(), s.abort.signal); await flush();
    void s.talk.stop(); const replacement = new Sender();
    await s.talk.start(replacement.asSender(), s.abort.signal); attached.resolve(); await first; await flush();
    expect(s.sender.replaceTrack).toHaveBeenLastCalledWith(null);
    expect(replacement.replaceTrack.mock.calls).toEqual([[s.streams[1]!.tracks[0]]]); await s.talk.dispose();
  });
  it('rejects attachment safely and releases every returned track', async () => {
    const s = setup(), extra = new Track('video'), audio = new Track(); s.acquire.mockResolvedValueOnce(new Stream([audio.asTrack(), extra.asTrack()]).asStream());
    s.sender.replaceTrack.mockRejectedValueOnce(new Error('private sender internals'));
    await expect(s.talk.start(s.sender.asSender(), s.abort.signal)).rejects.toMatchObject({ failure: { code: 'ice' } }); await flush();
    expect(audio.stop).toHaveBeenCalledOnce(); expect(extra.stop).toHaveBeenCalledOnce(); expect(s.sender.replaceTrack).toHaveBeenLastCalledWith(null);
    expect(s.talk.state.failure?.message).not.toContain('private');
  });
  it.each([['NotAllowedError', 'policy'], ['SecurityError', 'policy'], ['NotFoundError', 'unsupported-api'], ['NotReadableError', 'ice']])('classifies %s without echoing raw details', async (name, code) => {
    const s = setup(); s.acquire.mockRejectedValueOnce(new DOMException('private device info', name));
    await expect(s.talk.start(s.sender.asSender(), s.abort.signal)).rejects.toMatchObject({ failure: { code } });
    expect(Object.isFrozen(s.talk.state.failure)).toBe(true); expect(s.talk.state.failure?.message).not.toContain('private'); expect(s.talk.state.pending).toBe(false);
  });
  it('does not capture in an insecure context', async () => {
    const acquire = vi.fn(); const talk = createTalkController({ isSecureContext: () => false, getUserMedia: acquire });
    await expect(talk.start(new Sender().asSender(), new AbortController().signal)).rejects.toMatchObject({ failure: { code: 'configuration' } }); expect(acquire).not.toHaveBeenCalled();
  });
  it('reports a missing browser capture API separately', async () => {
    const talk = createTalkController({ isSecureContext: () => true });
    await expect(talk.start(new Sender().asSender(), new AbortController().signal)).rejects.toMatchObject({ failure: { code: 'unsupported-api' } });
  });
  it('releases streams with no audio or an already ended audio track', async () => {
    const s = setup(), track = new Track('video'); s.acquire.mockResolvedValueOnce(new Stream([track.asTrack()]).asStream());
    await expect(s.talk.start(s.sender.asSender(), s.abort.signal)).rejects.toMatchObject({ failure: { code: 'unsupported-api' } }); expect(track.stop).toHaveBeenCalledOnce();
  });
  it('sender invalidation cancels pending permission and never attaches to stale sender', async () => {
    const s = setup(), pending = deferred<MediaStream>(), late = new Track();
    const revoke = registerSender(s.sender.asSender(), () => true); s.acquire.mockReturnValueOnce(pending.promise);
    const start = s.talk.start(s.sender.asSender(), s.abort.signal); revoke(); await start;
    pending.resolve(new Stream([late.asTrack()]).asStream()); await flush();
    expect(late.stop).toHaveBeenCalledOnce(); expect(s.sender.replaceTrack).not.toHaveBeenCalled();
    await expect(s.talk.start(s.sender.asSender(), s.abort.signal)).rejects.toMatchObject({ failure: { code: 'ice' } });
  });
  it('remote sender invalidation or local track end stops active capture without restarting', async () => {
    const s = setup(), revoke = registerSender(s.sender.asSender(), () => true);
    await s.talk.start(s.sender.asSender(), s.abort.signal); revoke(); await flush();
    expect(s.talk.state.active).toBe(false); expect(s.meterStop).toHaveBeenCalledOnce(); expect(s.acquire).toHaveBeenCalledTimes(1);
    const replacement = new Sender(); await s.talk.start(replacement.asSender(), s.abort.signal);
    (s.streams[1]!.tracks[0] as unknown as Track).end(); await flush(); expect(s.talk.state.failure?.message).toContain('ended'); expect(s.acquire).toHaveBeenCalledTimes(2);
  });
  it('a throwing optional meter cleanup cannot retain the device or sender', async () => {
    const track = new Track(), sender = new Sender();
    const talk = createTalkController({ isSecureContext: () => true, getUserMedia: async () => new Stream([track.asTrack()]).asStream(), createMeter: () => () => { throw new Error('meter failed'); } });
    await talk.start(sender.asSender(), new AbortController().signal); await talk.dispose();
    expect(track.readyState).toBe('ended'); expect(sender.replaceTrack).toHaveBeenLastCalledWith(null);
  });
  it('an old detach rejection cannot overwrite a newer permission failure', async () => {
    const s = setup(), pending = deferred<void>();
    s.sender.replaceTrack.mockImplementationOnce(() => pending.promise).mockRejectedValueOnce(new Error('stale detach'));
    const first = s.talk.start(s.sender.asSender(), s.abort.signal); await flush(); void s.talk.stop();
    s.acquire.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    await expect(s.talk.start(s.sender.asSender(), s.abort.signal)).rejects.toMatchObject({ failure: { code: 'policy' } });
    pending.resolve(); await first; await flush(); expect(s.talk.state.failure?.code).toBe('policy');
  });
  it('an aborted signal stops active capture and a second stop remains safe', async () => {
    const s = setup(); await s.talk.start(s.sender.asSender(), s.abort.signal); s.abort.abort(); await s.talk.stop();
    expect(s.streams[0]!.tracks[0]!.readyState).toBe('ended'); expect(s.meterStop).toHaveBeenCalledOnce(); expect(s.talk.state.active).toBe(false);
  });
  it('rapid press/release, pre-aborted signal and dispose never restart capture', async () => {
    const s = setup();
    for (let i = 0; i < 20; i++) { const start = s.talk.start(s.sender.asSender(), s.abort.signal); await s.talk.stop(); await start; }
    expect(s.sender.replaceTrack).not.toHaveBeenCalled();
    s.abort.abort(); await s.talk.start(s.sender.asSender(), s.abort.signal); await s.talk.dispose();
    await s.talk.start(s.sender.asSender(), new AbortController().signal); expect(s.acquire).toHaveBeenCalledTimes(20);
    expect(s.streams.every(stream => stream.tracks.every(track => track.readyState === 'ended'))).toBe(true);
  });
});
