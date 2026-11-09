import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/contracts/**/*.test.ts', 'tests/unit/**/*.test.ts'], environment: 'node', maxWorkers: 2 } });
