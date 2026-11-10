import { vi } from 'vitest';
import { validateConfig, type CameraSummary, type ClientConfig, type NvrClient, type PlaybackController, type TalkController, type TalkState, type Transport, type TransportAdapter, type TransportStart } from '../../../src/contracts';
import { createPlaybackController } from '../../../src/playback';

export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export async function flush() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
export function configuration(input: Record<string, unknown> = {}) {
  return validateConfig({ type: 'custom:lightnvr-camera-card', server: '/nvr/', stream: 'generated',
    timeouts: { connection_ms: 500 }, retry: { base_ms: 100, cap_ms: 400, attempts: 2, jitter: 0 }, ...input });
}
export class Video extends EventTarget {
  paused = true; muted = true; readyState = 0; videoWidth = 0;
  play = vi.fn(async () => { this.paused = false; });
  canPlayType = vi.fn(() => '');
  asVideo() { return this as unknown as HTMLVideoElement; }
}
export function mockClient(scope = 'https://dashboard.example.test/nvr/') {
  const camera: CameraSummary = { name: 'generated', sources: { main: 'generated', sub: 'generated_sub' }, status: 'online', privacy: false,
    capabilities: { 'live.view': 'allowed', 'audio.listen': 'allowed', 'audio.talk': 'allowed' }, backchannel: 'allowed', ptz: 'unknown' };
  const settings: ClientConfig = { go2rtc: 'allowed', forceNativeHls: false, audioDisabled: false, transports: { webrtc: 'allowed', mse: 'allowed', hls: 'allowed' } };
  const client = {
    profile: { sessionScope: scope, sameOrigin: true, auth: 'session', baseUrl: scope },
    connect: vi.fn(async () => ({ kind: 'authenticated' as const, mustChangePassword: false })),
    discover: vi.fn(async () => [camera]), clientConfig: vi.fn(async () => settings),
    dispose: vi.fn(), control: vi.fn(), authorizedFetch: vi.fn(),
  };
  return { client, camera, settings, asClient: () => client as unknown as NvrClient };
}
export function mockTalk(log: string[] = []) {
  let state: TalkState = { active: false, pending: false };
  const listeners = new Set<(s: TalkState) => void>();
  const update = (s: TalkState) => { state = s; for (const fn of listeners) fn(s); };
  const talk: TalkController = {
    get state() { return state; },
    start: vi.fn(async (_sender: RTCRtpSender, signal: AbortSignal) => {
      if (signal.aborted) return;
      update({ active: true, pending: false }); signal.addEventListener('abort', () => update({ active: false, pending: false }), { once: true });
    }),
    stop: vi.fn(async () => { log.push('talk-stop'); update({ active: false, pending: false }); }),
    dispose: vi.fn(async () => { update({ active: false, pending: false }); }),
    subscribe(fn) { listeners.add(fn); fn(state); return () => { listeners.delete(fn); }; },
  };
  return { talk, update, listeners };
}
export interface FakeAdapter extends TransportAdapter { context?: TransportStart; frame: () => void; fail: (code: string, status?: number) => void }
export function harness(options: { api?: ReturnType<typeof mockClient>; talk?: TalkController; setup?: (adapter: FakeAdapter, context: TransportStart) => Promise<void> } = {}) {
  const log: string[] = [], adapters: FakeAdapter[] = [], api = options.api ?? mockClient();
  const audio = mockTalk(log), talk = options.talk ?? audio.talk;
  const video = new Video();
  const createTransport = vi.fn((kind: Transport): FakeAdapter => {
    const a: FakeAdapter = {
      kind,
      start: vi.fn(async (context: TransportStart) => {
        a.context = context; log.push(`start-${kind}`); context.video.muted = context.config.audio.muted;
        await options.setup?.(a, context);
      }),
      stop: vi.fn(async () => { log.push(`stop-${kind}`); }),
      setListening: vi.fn(async enabled => { video.muted = !enabled; }),
      getAudioSender: () => kind === 'webrtc' ? {} as RTCRtpSender : undefined,
      frame: () => { video.paused = false; a.context!.emit({ type: 'first-frame', transport: kind }); },
      fail: (code, status) => { a.context!.emit({ type: 'failure', failure: { code: code as 'network', message: 'untrusted raw fixture text', ...(status ? { status } : {}) } }); },
    };
    adapters.push(a); return a;
  });
  const controller = createPlaybackController({ client: api.asClient(), talk, createTransport });
  controllers.push(controller);
  return { controller, api, audio, talk, video, adapters, log, createTransport, start: (input: Record<string, unknown> = {}) => controller.start(video.asVideo(), configuration(input)),
    last: () => adapters.at(-1)! };
}
export const controllers: PlaybackController[] = [];
