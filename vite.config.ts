import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
// T1 can build contracts before T7 supplies the card entry. Never writes shared dist.
export default defineConfig({ build: {
  outDir: process.env.LIGHTNVR_BUILD_DIR ?? resolve(tmpdir(), 'lightnvr-T1-build'),
  emptyOutDir: true, sourcemap: false, target: 'es2022',
  lib: { entry: process.env.LIGHTNVR_BUILD_ENTRY ?? 'src/index.ts', formats: ['es'], fileName: () => 'lightnvr-camera-card.js' },
  rollupOptions: { output: { inlineDynamicImports: true } },
} });
