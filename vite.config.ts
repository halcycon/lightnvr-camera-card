import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
const licenseBanner = '/*! @license\nlightNVR Camera Card — https://github.com/halcycon/lightnvr-camera-card\n' +
  ['LICENSE', 'THIRD_PARTY_NOTICES.md'].map(file => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n\n') + '\n*/';
// Explicit output keeps validation builds away from the published artifact.
// HACS downloads one JS file, so that file carries the complete distribution notices.
export default defineConfig({
  plugins: [{ name: 'distribution-notices', generateBundle(_options, bundle) {
    for (const item of Object.values(bundle)) if (item.type === 'chunk') item.code = licenseBanner + '\n' + item.code;
  } }],
  build: {
  outDir: process.env.LIGHTNVR_BUILD_DIR ?? resolve('dist'),
  emptyOutDir: true, sourcemap: false, target: 'es2022',
  lib: { entry: process.env.LIGHTNVR_BUILD_ENTRY ?? 'src/index.ts', formats: ['es'], fileName: () => 'lightnvr-camera-card.js' },
  rollupOptions: { output: { inlineDynamicImports: true } },
} });
