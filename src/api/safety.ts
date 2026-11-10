import { NvrError, type FailureCode, type PlaybackFailure, type ServerProfile, type CardConfigV1 } from '../contracts';

export const hasControlCharacters = (value: string): boolean => Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

const messages: Record<FailureCode, string> = {
  auth: 'Authentication required or rejected.', policy: 'Permission denied.', privacy: 'Camera privacy is enabled.',
  'source-offline': 'Source is offline.', 'unsupported-codec': 'Media codec is unsupported.',
  'unsupported-api': 'Server response or API is unsupported.', network: 'Server is unreachable.', ice: 'Media connection failed.',
  timeout: 'Request timed out.', buffer: 'Media buffer failed.', cancelled: 'Request cancelled.',
  autoplay: 'Playback needs a user gesture.',
  configuration: 'Connection configuration is invalid or conflicts with an active identity.', proxy: 'Proxy request failed.',
  'rate-limit': 'Too many requests. Try again later.', 'password-change': 'Password change is required.', totp: 'Interactive authentication is required.',
};
export function failure(code: FailureCode, status?: number, retryAfterMs?: number): NvrError {
  const value: PlaybackFailure = { code, message: messages[code] };
  if (status !== undefined) value.status = status;
  if (retryAfterMs !== undefined) value.retryAfterMs = retryAfterMs;
  return new NvrError(value);
}
/** Diagnostics are an allowlist, never a serialization of config, errors or wire data. */
export function safeDiagnostic(error: unknown): PlaybackFailure {
  return error instanceof NvrError
    ? { code: error.failure.code, message: messages[error.failure.code],
      ...(error.failure.status === undefined ? {} : {status: error.failure.status}),
      ...(error.failure.retryAfterMs === undefined ? {} : {retryAfterMs: error.failure.retryAfterMs}) }
    : { code: 'network', message: messages.network };
}
export function normalizeProfile(config: Pick<CardConfigV1, 'server'|'go2rtc_path'|'auth'|'credential_storage'>, documentUrl = globalThis.location?.href): ServerProfile {
  try {
    if (!documentUrl && config.server.startsWith('/')) throw failure('configuration');
    if (!/^(https?:\/\/|\/(?!\/))/.test(config.server) || /[\\\s]/.test(config.server)) throw failure('configuration');
    const base = new URL(config.server, documentUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw failure('configuration');
    if (/%|\/\//.test(base.pathname) || config.server.split('/').some(s => s === '.' || s === '..')) throw failure('configuration');
    base.pathname = base.pathname.replace(/\/$/, '') + '/';
    if (!/^(?:[a-zA-Z0-9_-]+\/)+$/.test(config.go2rtc_path)) throw failure('configuration');
    return Object.freeze({baseUrl: base.href, go2rtcUrl: new URL(config.go2rtc_path, base).href,
      origin: base.origin, sameOrigin: documentUrl ? new URL(documentUrl).origin === base.origin : false,
      sessionScope: base.href, auth: config.auth, credentialStorage: config.credential_storage});
  } catch { throw failure('configuration'); }
}
/** Only relative descendants: reject normalization tricks before URL resolution. */
export function scopedUrl(profile: ServerProfile, path: string): URL {
  if (!path || (path.startsWith('/') || path.startsWith('\\')) || /[\\#\s]/.test(path) || /^[a-z][a-z\d+.-]*:/i.test(path)) throw failure('configuration');
  let decoded: string;
  try { decoded = decodeURIComponent(path.split('?')[0]!); } catch { throw failure('configuration'); }
  if (decoded.includes('%') || decoded.split('/').some(s => s === '.' || s === '..') || (decoded.includes('\\') || hasControlCharacters(decoded))) throw failure('configuration');
  const url = new URL(path, profile.baseUrl);
  if (url.origin !== profile.origin || !url.pathname.startsWith(new URL(profile.baseUrl).pathname)) throw failure('configuration');
  return url;
}
export function basicHeader(username: string, password: string): string {
  if (username.includes(':') || hasControlCharacters(username + password)) throw failure('configuration');
  // lightNVR compares decoded UTF-8 bytes. btoa alone corrupts non-ASCII passwords.
  return 'Basic ' + btoa(Array.from(new TextEncoder().encode(`${username}:${password}`), b => String.fromCharCode(b)).join(''));
}
export function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw failure('cancelled'); }
export function cameraPath(name: string): string {
  if (!name || name.length > 255 || (name.includes('/') || name.includes('\\') || hasControlCharacters(name)) || name === '.' || name === '..') throw failure('configuration');
  return `api/streams/${encodeURIComponent(name)}`;
}
