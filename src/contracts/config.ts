import { z } from 'zod';
export const transportSchema = z.enum(['webrtc', 'mse', 'hls']);
export type Transport = z.infer<typeof transportSchema>;
const duration = z.number().int().min(100).max(300000);
const server = z.string().min(1).superRefine((value, ctx) => {
  try {
    if (value.startsWith('//')) throw new Error();
    const url = new URL(value, 'https://dashboard.invalid');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error();
    if (!value.startsWith('/') && !/^https?:\/\//.test(value)) throw new Error();
  } catch { ctx.addIssue({ code: 'custom', message: 'Use an HTTP(S) server or same-origin path without userinfo, query or fragment' }); }
});
export const cardConfigSchema = z.object({
  type: z.literal('custom:lightnvr-camera-card'), version: z.literal(1).default(1), server,
  go2rtc_path: z.string().regex(/^(?:[A-Za-z0-9_-]+\/)+$/).default('go2rtc/'),
  viewer_url: server.optional(),
  username: z.string().optional(), password: z.string().optional(),
  credential_storage: z.enum(['dashboard', 'session']).default('dashboard'),
  auth: z.enum(['session', 'basic']).default('session'),
  stream: z.string().min(1), camera_uuid: z.string().min(1).optional(),
  source: z.string().min(1).optional(), profile: z.enum(['main', 'sub']).default('main'),
  title: z.string().optional(),
  transports: z.array(transportSchema).min(1).max(3).default(['webrtc', 'mse', 'hls'])
    .refine(v => new Set(v).size === v.length, 'Duplicate transports'),
  hls: z.object({ provider: z.enum(['auto', 'go2rtc', 'native']).default('auto') }).strict().prefault({}),
  timeouts: z.object({ connection_ms: duration.or(z.literal('inherit')).default(30000), ice_grace_ms: duration.default(5000), webrtc_ms: duration.optional(), mse_ms: duration.optional(), hls_ms: duration.optional() }).strict().prefault({}),
  retry: z.object({ base_ms: duration.default(2000), cap_ms: duration.default(30000), attempts: z.number().int().min(0).max(100).default(5), jitter: z.number().min(0).max(1).default(0.2) }).strict().prefault({}),
  video: z.object({ enabled:z.literal(true) }).strict().default({enabled:true}),
  audio: z.object({ enabled:z.boolean().default(true), listen:z.boolean().default(true), muted: z.boolean().default(true), microphone: z.boolean().default(false), talk_mode: z.enum(['ptt', 'toggle']).default('ptt'), volume: z.number().min(0).max(1).default(1) }).strict().prefault({}),
  controls: z.object({ speaker:z.boolean().optional(), microphone:z.boolean().optional(), fullscreen:z.boolean().optional(), snapshot:z.boolean().optional(), transport:z.boolean().optional(), profile:z.boolean().optional(), zoom:z.boolean().optional(), ptz:z.boolean().optional(), daynight:z.boolean().optional(), recording:z.boolean().optional(), privacy:z.boolean().optional(), detection:z.boolean().optional(), refresh_source:z.boolean().optional(), timeline:z.boolean().optional() }).strict().prefault({}),
  layout: z.object({ aspect_ratio: z.number().positive().default(16/9), object_fit:z.enum(['contain','cover']).default('contain'), fullscreen_main: z.boolean().default(false) }).strict().prefault({}),
  visibility:z.object({ hidden:z.enum(['pause','continue']).default('pause'), offscreen:z.enum(['pause','continue']).default('pause') }).strict().prefault({}),
  ice_servers:z.array(z.object({ urls:z.union([z.string().regex(/^turns?:|^stuns?:/),z.array(z.string().regex(/^turns?:|^stuns?:/)).min(1)]), username:z.string().optional(), credential:z.string().optional() }).strict()).max(16).optional(),
}).strict().superRefine((c,ctx) => {
  if (c.retry.cap_ms < c.retry.base_ms) ctx.addIssue({ code:'custom', path:['retry'], message:'Retry cap must be at least base' });
  if (!c.audio.enabled && (c.audio.microphone || c.audio.listen)) ctx.addIssue({code:'custom',path:['audio'],message:'Disabled audio requires listen and microphone to be false'});
  if (c.audio.microphone && !c.transports.includes('webrtc')) ctx.addIssue({code:'custom',path:['audio','microphone'],message:'Microphone requires WebRTC in the transport order'});
});
export type CardConfigV1 = z.infer<typeof cardConfigSchema>;
export function validateConfig(input: unknown): CardConfigV1 { return cardConfigSchema.parse(input); }
export interface MigrationPreview { config: CardConfigV1; warnings: readonly string[] }
/** Explicit preview only. Unknown legacy fields are rejected rather than silently lost. */
export function migrateLegacy(input: unknown): MigrationPreview {
  const legacy = z.object({ type:z.literal('custom:webrtc-camera').optional(), server:z.string(), url:z.string().min(1), mode:z.enum(['webrtc','mse','hls']).optional(),
    media:z.union([z.string().refine(v => v.split(',').every(t => ['video','audio','microphone'].includes(t.trim())), 'Unknown legacy media token'),z.object({ video:z.boolean().optional(), audio:z.boolean().optional(), microphone:z.boolean().optional() }).strict()]).optional(),
    ui:z.boolean().optional() }).strict().parse(input);
  const media = typeof legacy.media === 'string' ? {video:legacy.media.split(',').map(v=>v.trim()).includes('video'),audio:legacy.media.split(',').map(v=>v.trim()).includes('audio'),microphone:legacy.media.split(',').map(v=>v.trim()).includes('microphone')} : legacy.media;
  if (media?.video === false) throw new Error('Audio-only legacy configuration requires manual review');
  const u = new URL(legacy.server);
  const username = decodeURIComponent(u.username), password = decodeURIComponent(u.password);
  u.username = ''; u.password = '';
  u.pathname = u.pathname.replace(/\/go2rtc\/?$/, '/');
  return { config: validateConfig({ type:'custom:lightnvr-camera-card', server:u.href, stream:legacy.url, source:legacy.url,
    ...(username ? {username,password} : {}), ...(legacy.mode ? {transports:[legacy.mode]} : {}),
    audio:{listen:media?.audio ?? true,muted:media?.audio !== true,microphone:media?.microphone ?? false}, ...(legacy.ui === false ? { controls:{speaker:false,microphone:false,fullscreen:false,snapshot:false,transport:false,profile:false,zoom:false,ptz:false,daynight:false,recording:false,privacy:false,detection:false,refresh_source:false,timeline:false} } : {}) }),
    warnings:['Review credentials stored in dashboard configuration; exact legacy source preserved.'] };
}
