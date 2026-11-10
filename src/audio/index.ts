import { NvrError, type PlaybackFailure, type TalkController, type TalkState } from '../contracts';
import { createLocalMeter } from './meter';
import { senderIsValid, watchSender } from './sender-lease';

export interface TalkOptions {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  isSecureContext?: () => boolean;
  createMeter?: (stream: MediaStream, report: (level: number) => void) => () => void;
}
interface Request {
  sender: RTCRtpSender; cancel: AbortController; cleanup: (() => void)[];
  stream?: MediaStream; meter?: () => void; attached: boolean;
}
const error = (code: PlaybackFailure['code'], message: string) => new NvrError({ code, message });
const cancelled = () => error('cancelled', 'Microphone request cancelled.');

/** Construction and state reads never acquire a device. start() is the gesture boundary. */
export function createTalkController(options: TalkOptions = {}): TalkController {
  let state: Readonly<TalkState> = Object.freeze({ active: false, pending: false });
  let active: Request | undefined;
  let disposed = false;
  let revision = 0;
  let shutdown = Promise.resolve();
  const listeners = new Set<(state: Readonly<TalkState>) => void>();
  const queues = new WeakMap<RTCRtpSender, Promise<void>>();
  const update = (value: TalkState) => {
    state = Object.freeze({ ...value, ...(value.failure ? { failure: Object.freeze({ ...value.failure }) } : {}) });
    for (const listener of [...listeners]) { try { listener(state); } catch { /* Observers cannot retain devices. */ } }
  };
  const replace = (sender: RTCRtpSender, operation: () => Promise<void>) => {
    const work = (queues.get(sender) ?? Promise.resolve()).then(operation);
    queues.set(sender, work.catch(() => {}));
    return work;
  };
  const current = (r: Request) => active === r && !r.cancel.signal.aborted && senderIsValid(r.sender);
  function stop(): Promise<void> {
    const stoppedRevision = ++revision;
    const r = active;
    active = undefined;
    if (r) {
      r.cancel.abort();
      r.cleanup.forEach(fn => fn());
      try { r.meter?.(); } catch { /* Meter cleanup cannot prevent device shutdown. */ }
      // Device shutdown is synchronous, even when replaceTrack is still pending.
      r.stream?.getTracks().forEach(track => { track.enabled = false; track.stop(); });
      if (r.attached) {
        const detach = replace(r.sender, () => r.sender.replaceTrack(null)).catch(() => {
          if (revision === stoppedRevision && !active && !disposed) update({ active: false, pending: false, failure: { code: 'ice', message: 'Microphone sender could not detach; local capture has stopped.' } });
        });
        shutdown = Promise.all([shutdown, detach]).then(() => {});
      }
    }
    update({ active: false, pending: false });
    return shutdown;
  }
  async function start(sender: RTCRtpSender, signal: AbortSignal): Promise<void> {
    void stop();
    if (disposed || signal.aborted) return;
    const r: Request = { sender, cancel: new AbortController(), cleanup: [], attached: false };
    active = r;
    const cancel = () => { if (active === r) void stop(); };
    signal.addEventListener('abort', cancel, { once: true });
    r.cleanup.push(() => signal.removeEventListener('abort', cancel), watchSender(sender, cancel));
    update({ active: false, pending: true });
    try {
      if (!(options.isSecureContext?.() ?? globalThis.isSecureContext)) throw error('configuration', 'Microphone requires a secure Home Assistant document context (trusted HTTPS or localhost).');
      if (!senderIsValid(sender)) throw error('ice', 'The negotiated microphone sender is no longer available.');
      const acquire = options.getUserMedia ?? globalThis.navigator?.mediaDevices?.getUserMedia.bind(globalThis.navigator.mediaDevices);
      if (!current(r)) return;
      if (!acquire) throw error('unsupported-api', 'Microphone capture is unavailable in this browser.');
      const acquired = acquire({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }).then(stream => {
        if (!current(r)) { stream.getTracks().forEach(track => track.stop()); throw cancelled(); }
        r.stream = stream;
        return stream;
      });
      // Cancellation settles immediately; the acquisition continuation still releases late streams.
      const abort = new Promise<never>((_, reject) => {
        const onAbort = () => reject(cancelled());
        r.cancel.signal.addEventListener('abort', onAbort, { once: true });
        r.cleanup.push(() => r.cancel.signal.removeEventListener('abort', onAbort));
        if (r.cancel.signal.aborted) onAbort();
      });
      const stream = await Promise.race([acquired, abort]);
      const track = stream.getAudioTracks().find(t => t.readyState !== 'ended');
      if (!track) throw error('unsupported-api', 'No usable microphone audio track was returned.');
      const ended = () => {
        if (active !== r) return;
        void stop();
        update({ active: false, pending: false, failure: { code: 'unsupported-api', message: 'Microphone capture ended. Start again with an explicit gesture.' } });
      };
      track.addEventListener('ended', ended);
      r.cleanup.push(() => track.removeEventListener('ended', ended));
      await Promise.race([replace(sender, async () => {
        if (!current(r)) return;
        r.attached = true;
        await sender.replaceTrack(track);
      }), abort]);
      if (!current(r)) return;
      update({ active: true, pending: false });
      if (!current(r)) return;
      let meter: () => void;
      try { meter = (options.createMeter ?? createLocalMeter)(stream, level => {
        if (current(r) && state.active && Number.isFinite(level)) update({ active: true, pending: false, level: Math.max(0, Math.min(1, level)) });
      });
      } catch { return; } // A missing meter must not invalidate working talk.
      if (current(r)) r.meter = meter;
      else meter();
    } catch (cause) {
      if (active !== r) return;
      const name = cause instanceof Error ? cause.name : '';
      const failure = cause instanceof NvrError ? cause.failure : name === 'NotAllowedError' || name === 'SecurityError'
        ? { code: 'policy' as const, message: 'Microphone permission was denied by the browser or document policy.' }
        : name === 'NotFoundError' || name === 'DevicesNotFoundError'
          ? { code: 'unsupported-api' as const, message: 'No microphone device is available.' }
          : { code: 'ice' as const, message: 'Microphone capture or sender attachment failed.' };
      void stop();
      update({ active: false, pending: false, failure });
      throw new NvrError(failure);
    }
  }
  return {
    start, stop, get state() { return state; },
    subscribe(listener) { listeners.add(listener); listener(state); return () => { listeners.delete(listener); }; },
    async dispose() { disposed = true; await stop(); listeners.clear(); },
  };
}
