import { test } from '@playwright/test';
import { fixtureSafety, upstreamSmoke } from './harness.mjs';

test('scoped helper rejects ambiguity and confines HLS/authentication', async () => {
  await fixtureSafety();
});
test('Traefik TLS/WSS browser smoke against the actual isolated upstream', async () => {
  test.setTimeout(180_000);
  await upstreamSmoke();
});
