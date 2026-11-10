import { vi } from 'vitest';
import { validateConfig, type CameraSummary, type ClientConfig, type NvrClient, type PlaybackController, type PlaybackSnapshot } from '../../../src/contracts';
import { type ViewerRuntime } from '../../../src/ui/session';
export const config = (extra: Record<string, unknown> = {}) => validateConfig({ type: 'custom:lightnvr-camera-card', server: 'https://nvr.example.test/', stream: 'fixture', ...extra });
export const camera = (extra: Partial<CameraSummary> = {}): CameraSummary => ({ name: 'fixture', sources: { main: 'fixture', sub: 'fixture_sub' }, status: 'online', privacy: false, capabilities: { snapshot: 'allowed', ptz: 'allowed' }, backchannel: 'allowed', ptz: 'allowed', ...extra });
export const caps: ClientConfig = { go2rtc: 'allowed', audioDisabled: false, forceNativeHls: false, transports: { webrtc: 'allowed', mse: 'allowed', hls: 'allowed' } };
export function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise }; }
export const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
export function fixture(cam = camera()) {
  let disposed = false;
  let snapshot: PlaybackSnapshot = { state: 'idle', attempt: 0, talking: false, talk: { active: false, pending: false } };
  const listeners = new Set<(snapshot: PlaybackSnapshot) => void>();
  const emit = (value: Partial<PlaybackSnapshot>) => { snapshot = { ...snapshot, ...value }; listeners.forEach(fn => fn(snapshot)); };
  const client = {
    profile: { baseUrl: 'https://nvr.example.test/', go2rtcUrl: 'https://nvr.example.test/go2rtc/', origin: 'https://nvr.example.test', sameOrigin: false, sessionScope: 'https://nvr.example.test/', auth: 'session', credentialStorage: 'dashboard' },
    connect: vi.fn().mockResolvedValue({ kind: 'authenticated', mustChangePassword: false }),
    completeTotp: vi.fn().mockResolvedValue({ kind: 'authenticated', mustChangePassword: false }),
    discover: vi.fn().mockResolvedValue([cam]), clientConfig: vi.fn().mockResolvedValue(caps),
    readControl: vi.fn().mockResolvedValue({ recording: false, privacy: false, daynight: 'auto' }),
    control: vi.fn().mockImplementation(async () => { if (disposed) throw new Error('Client disposed'); return { state: 'applied' }; }),
    detections: vi.fn().mockResolvedValue([{ x: .1, y: .2, width: .3, height: .4, label: 'generated' }]),
    authorizedFetch: vi.fn().mockResolvedValue(new Response(new Blob(['fixture']), { headers: { 'Content-Type': 'image/jpeg' } })),
    mediaUrls: vi.fn().mockReturnValue({ snapshot: 'https://nvr.example.test/go2rtc/api/frame.jpeg?src=fixture' }),
    dispose: vi.fn(() => { disposed = true; }),
  } as unknown as NvrClient;
  const playback = {
    get snapshot() { return snapshot; },
    start: vi.fn().mockImplementation(async () => { emit({ state: 'playing', transport: 'webrtc' }); }),
    stop: vi.fn().mockResolvedValue(undefined), dispose: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn().mockResolvedValue(undefined), setListening: vi.fn().mockResolvedValue(undefined), setVisible: vi.fn().mockResolvedValue(undefined),
    startTalk: vi.fn().mockResolvedValue(undefined), stopTalk: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn((fn: (snapshot: PlaybackSnapshot) => void) => { listeners.add(fn); fn(snapshot); return () => listeners.delete(fn); }),
  } satisfies PlaybackController;
  const runtime: ViewerRuntime = { client: vi.fn(() => client), playback: vi.fn(() => playback), talk: vi.fn() };
  return { client, playback, runtime, emit, get disposed() { return disposed; }, get listeners() { return listeners.size; } };
}
