import { parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import { validateConfig, migrateLegacy, type CardConfigV1, type CameraSummary, type ClientConfig } from '../contracts';

/** Paths and fixed explanations only: Zod errors may contain supplied secrets. */
export function configProblem(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map(issue => {
    const path = issue.path.map(p => typeof p === 'number' ? `[${p}]` : String(p)).join('.') || 'configuration';
    return `${path}: ${issue.code === 'unrecognized_keys' ? 'unsupported option; remove it or use a supported configuration version' : 'invalid value or incompatible settings; review this field'}`;
  }).join('; ');
  return 'Invalid configuration. Review supported fields, transport order, audio policy and retry limits.';
}
export function getStubConfig(): CardConfigV1 {
  return validateConfig({ type: 'custom:lightnvr-camera-card', server: '/lightnvr/', stream: 'select_camera' });
}
export function persistentConfig(config: CardConfigV1): CardConfigV1 {
  const copy = structuredClone(config);
  if (copy.credential_storage === 'session') { delete copy.username; delete copy.password; }
  return validateConfig(copy);
}
/** YAML is parsed as data, with duplicate keys/custom tags/aliases rejected. */
export function parseConfigYaml(text: string): unknown {
  if (text.length > 100000) throw new Error('Configuration is too large.');
  const doc = parseDocument(text, { uniqueKeys: true, schema: 'core' });
  if (doc.errors.length || doc.warnings.length) throw new Error('Use plain YAML with unique keys and no custom tags.');
  return doc.toJS({ maxAliasCount: 0 });
}
export function migrationPreview(text: string): { config: CardConfigV1; warnings: readonly string[] } {
  try { return migrateLegacy(parseConfigYaml(text)); }
  catch { throw new Error('Legacy import rejected. Use only server, url, mode, media and ui; video must be enabled. Check the server URL and transport/audio combination.'); }
}
function redactIceUrl(url: string): string {
  return url.replace(/^((?:turns?|stuns?):(?:\/\/)?)[^@]+@/i, '$1REDACTED@');
}
export function redactedConfig(config: CardConfigV1): CardConfigV1 {
  const copy = persistentConfig(config);
  for (const field of ['source', 'stream'] as const) {
    if (copy[field] && /^[a-z][a-z0-9+.-]*:\/\//i.test(copy[field])) copy[field] = 'REDACTED_SOURCE_URL';
  }
  if (copy.password !== undefined) copy.password = 'REDACTED';
  if (copy.username !== undefined) copy.username = 'REDACTED';
  if (copy.ice_servers) copy.ice_servers = copy.ice_servers.map(s => ({ ...s,
    urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).map(url => redactIceUrl(url)),
    ...(s.username === undefined ? {} : { username: 'REDACTED' }),
    ...(s.credential === undefined ? {} : { credential: 'REDACTED' }) }));
  return copy;
}
export function cameraConfig(base: CardConfigV1, camera: CameraSummary, profile: 'main' | 'sub'): CardConfigV1 {
  if (camera.status === 'disabled' || camera.privacy === true || camera.capabilities['live.view'] === 'denied')
    throw new Error('Camera is disabled, private or live viewing is denied. Review its state in lightNVR.');
  if (profile === 'sub' && !camera.sources.sub) throw new Error('No managed substream is available. Choose main.');
  const copy = structuredClone(base);
  delete copy.source; delete copy.camera_uuid;
  return validateConfig({ ...copy, stream: camera.name, ...(camera.uuid ? { camera_uuid: camera.uuid } : {}), profile });
}
export function capabilityProblems(config: CardConfigV1, caps?: ClientConfig, camera?: CameraSummary): string[] {
  const problems: string[] = [];
  if (caps) {
    for (const transport of config.transports) {
      if (caps.transports[transport] === 'denied') problems.push(`${transport} is disabled by the server. Remove it from the transport order.`);
      if (caps.go2rtc === 'denied' && transport !== 'hls') problems.push('The server requires native HLS. Choose HLS only.');
    }
    if (config.transports.includes('hls') && (caps.forceNativeHls === true || caps.go2rtc === 'denied') && config.hls.provider === 'go2rtc') problems.push('The server requires native HLS. Choose native or auto provider.');
    if (caps.audioDisabled === true && (config.audio.listen || config.audio.microphone)) problems.push('Server audio is disabled. Turn off listening and microphone.');
  }
  const native = config.hls.provider === 'native' || caps?.forceNativeHls === true || caps?.go2rtc === 'denied';
  if (config.transports.includes('hls') && native && (config.profile !== 'main' || !config.audio.listen || !camera || (config.source !== undefined && config.source !== camera.sources.main))) problems.push('Native HLS needs a discovered exact main camera source with listening enabled. Choose main/listen or a supported go2rtc provider.');
  if (config.audio.microphone && camera?.backchannel === 'denied') problems.push('This camera has no backchannel. Disable microphone.');
  if (config.audio.listen && camera?.capabilities['audio.listen'] === 'denied') problems.push('Listening is denied. Disable listening.');
  if (config.audio.microphone && camera?.capabilities['audio.talk'] === 'denied') problems.push('Talk is denied. Disable microphone.');
  return [...new Set(problems)];
}
export function generateYaml(base: CardConfigV1, cameras: readonly CameraSummary[], profile: 'main' | 'sub', mode: 'cards' | 'grid', columns = 2): string {
  if (!cameras.length) throw new Error('Select at least one camera.');
  if (!Number.isInteger(columns) || columns < 1 || columns > 12) throw new Error('Grid columns must be 1–12.');
  const cards = cameras.map(camera => {
    const c = persistentConfig(cameraConfig(base, camera, profile));
    delete c.password; delete c.username;
    if (c.ice_servers) c.ice_servers = c.ice_servers.map(server => ({ ...server,
      urls: Array.isArray(server.urls) ? server.urls.map(redactIceUrl) : redactIceUrl(server.urls),
      ...(server.username === undefined ? {} : { username: 'REPLACE_WITH_TURN_USERNAME' }),
      ...(server.credential === undefined ? {} : { credential: 'REPLACE_WITH_TURN_CREDENTIAL' }) }));
    return c;
  });
  const notice = '# REVIEW BEFORE USE: login credentials omitted; reauthenticate for session storage or add dashboard credentials.\n' +
    '# ICE routing is preserved. Replace TURN username/credential placeholders and any REDACTED URL userinfo; playback may fail until restored.\n' +
    '# Dashboard configuration readers can read saved credentials. UI-managed dashboards do not promise !secret support.\n';
  return notice + stringify(mode === 'grid' ? { type: 'grid', columns, square: false, cards } : cards);
}
