import { test } from "@playwright/test";
import { fixtureSafety, upstreamSmoke } from "./harness.mjs";
import {
  authorityConfinement,
  ipv6Loopback,
  tlsUpstreamIdentity,
} from "./security.mjs";

test("request targets cannot escape to a trap authority over HTTP or WS", async () => {
  await authorityConfinement();
});
test("configured IPv6 loopback upstream forwards HTTP and WS with bare hostname options", async () => {
  await ipv6Loopback();
});
test("upstream TLS verifies configured DNS/IP identity while preserving public Host", async () => {
  await tlsUpstreamIdentity();
});
test("scoped helper rejects ambiguity and confines HLS/authentication", async () => {
  await fixtureSafety();
});
test("Traefik TLS/WSS browser smoke against the actual isolated upstream", async () => {
  test.setTimeout(180_000);
  await upstreamSmoke();
});
