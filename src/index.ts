import { LightNvrCameraCard } from './card';
export { LightNvrCameraCard } from './card';
if (!customElements.get('lightnvr-camera-card')) customElements.define('lightnvr-camera-card', LightNvrCameraCard);
const registry = window as Window & { customCards?: { type: string; name: string; description: string; preview: boolean }[] };
registry.customCards ??= [];
if (!registry.customCards.some(card => card.type === 'lightnvr-camera-card')) registry.customCards.push({ type: 'lightnvr-camera-card', name: 'lightNVR Camera', description: 'Authorized lightNVR live viewer with independent listening and talk.', preview: true });
