import type { CardConfigV1, Transport } from './config';
import type { CameraSummary, ClientConfig, NvrClient, PlaybackFailure, SourceSelection } from './model';
export type PlaybackState = 'idle'|'queued'|'connecting'|'playing'|'recovering'|'suspended'|'offline'|'auth-required'|'denied'|'failed'|'stopped';
export type TransportEvent =
  | { type:'first-frame'; transport:Transport }
  | { type:'state'; state:PlaybackState }
  | { type:'failure'; failure:PlaybackFailure };
export interface TransportStart {
  video:HTMLVideoElement; source:SourceSelection; camera?:CameraSummary; capabilities:ClientConfig;
  client:NvrClient; config:CardConfigV1; signal:AbortSignal; emit:(event:TransportEvent)=>void;
}
export interface TransportAdapter {
  readonly kind:Transport;
  /** Resolves setup only. first-frame requires decoded/rendered media. */
  start(context:TransportStart):Promise<void>;
  stop():Promise<void>;
  setListening(enabled:boolean):Promise<void>;
  getAudioSender?():RTCRtpSender | undefined;
}
export type TransportFactory = (kind:Transport)=>TransportAdapter;
export interface TalkState { active:boolean; pending:boolean; failure?:PlaybackFailure; level?:number }
export interface TalkController {
  /** Explicit gesture only; token abort invalidates even a late getUserMedia result. */
  start(sender:RTCRtpSender, signal:AbortSignal):Promise<void>;
  /** Serial detach; stops all owned tracks; repeat-safe. */
  stop():Promise<void>;
  readonly state:TalkState;
  dispose():Promise<void>;
}
export interface PlaybackSnapshot { state:PlaybackState; transport?:Transport; failure?:PlaybackFailure; attempt:number; talking:boolean }
export interface PlaybackController {
  readonly snapshot:PlaybackSnapshot;
  start(video:HTMLVideoElement, config:CardConfigV1, signal?:AbortSignal):Promise<void>;
  retry():Promise<void>;
  setListening(enabled:boolean):Promise<void>;
  startTalk(signal:AbortSignal):Promise<void>;
  stopTalk():Promise<void>;
  setVisible(visible:boolean):Promise<void>;
  subscribe(listener:(snapshot:PlaybackSnapshot)=>void):()=>void;
  stop():Promise<void>;
  dispose():Promise<void>;
}
export interface PlaybackDependencies { client:NvrClient; createTransport:TransportFactory; talk:TalkController }
