import { z } from 'zod';
// Wire types are permissive to added fields, while selecting only credential-free fields.
export const loginResponseSchema = z.union([
  z.object({success:z.literal(true),redirect:z.string().optional(),must_change_password:z.boolean().optional()}),
  z.object({totp_required:z.literal(true),totp_token:z.string().min(1)}),
]);
export const streamSummarySchema = z.object({
  name:z.string().min(1),camera_uuid:z.string().optional(),enabled:z.boolean().optional(),
  status:z.string().optional(),privacy_mode:z.boolean().optional(),has_sub_stream:z.boolean().optional(),
  streaming_enabled:z.boolean().optional(),backchannel_enabled:z.boolean().optional(),ptz_enabled:z.boolean().optional(),
  can_control_privacy:z.boolean().optional(),recording_active:z.boolean().optional(),go2rtc_hls_available:z.boolean().optional(),
  playback_transport:z.string().optional(),
});
export const streamPageSchema = z.object({streams:z.array(streamSummarySchema),page:z.number().int().min(1),page_size:z.number().int().min(1),total:z.number().int().min(0),total_pages:z.number().int().min(0)});
export type StreamSummaryWire = z.infer<typeof streamSummarySchema>;
export type StreamPageWire = z.infer<typeof streamPageSchema>;
