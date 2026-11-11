// Creates a new disposable HA only. No existing configuration is imported.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { confirmFixtureProxy } from "./ha-http-config.mjs";

const images = {
  "2026.11.1":
    "ghcr.io/home-assistant/home-assistant@sha256:1e25a28cb9ee48dbcd33b65cbdcf2919d01991fe11f71cdae0a09c9fc3017ebb",
  "2026.10.4":
    "ghcr.io/home-assistant/home-assistant@sha256:21935614df6d9f24f680a1ef749f0570d2d6b7936c606c0a44253ae875865c04",
};
const version = process.env.LIGHTNVR_HA_VERSION ?? "2026.11.1";
if (!images[version]) throw Error("Choose a pinned HA fixture version");
const args = JSON.parse(process.env.LIGHTNVR_PODMAN_ARGS ?? "[]");
const podman = (...rest) =>
  execFileSync("podman", [...args, ...rest], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 600_000,
  }).trim();
const dir = await mkdtemp(
  join(resolve(process.env.LIGHTNVR_FIXTURE_ROOT ?? tmpdir()), "lightnvr-ha-"),
);
const config_dir = join(dir, "config");
await mkdir(join(config_dir, "www"), { recursive: true, mode: 0o700 });
const name = "lightnvr-card-ha-" + randomBytes(5).toString("hex");
const network = name + "-net";
const credentials = {
  username: "generated_card_admin",
  password: randomBytes(18).toString("hex"),
};
let phase = "network creation";
try {
  podman("network", "create", "--internal", network);
  const net = JSON.parse(podman("network", "inspect", network))[0];
  const cidr = net.subnets[0].subnet;
  // Present before first start: modern HA imports this into managed HTTP configuration.
  await writeFile(
    join(config_dir, "configuration.yaml"),
    `default_config:\nhttp:\n  use_x_forwarded_for: true\n  trusted_proxies:\n    - ${cidr}\n    - 127.0.0.1/32\n`,
    { mode: 0o600 },
  );
  phase = "image/container startup";
  podman(
    "run",
    "-d",
    "--name",
    name,
    "--label",
    "io.lightnvr-card.fixture=T10-HA",
    "--network",
    network,
    "-p",
    "127.0.0.1::8123",
    "-v",
    `${config_dir}:/config:Z`,
    images[version],
  );
  const port = podman("port", name, "8123/tcp").split(":").at(-1);
  const origin = `http://127.0.0.1:${port}`;
  phase = "onboarding readiness";
  let ready = false;
  for (let i = 0; i < 180; i++) {
    try {
      const r = await fetch(origin + "/api/onboarding", {
        signal: AbortSignal.timeout(1500),
      });
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {
      /* starting */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!ready) throw Error("HA readiness timeout");
  phase = "generated account onboarding";
  const client_id = origin + "/";
  const user = await fetch(origin + "/api/onboarding/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...credentials,
      name: "Generated card acceptance",
      language: "en",
      client_id,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!user.ok) throw Error("Fixture user setup rejected");
  const code = (await user.json()).auth_code;
  const tokenResponse = await fetch(origin + "/auth/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!tokenResponse.ok) throw Error("Fixture token exchange rejected");
  const tokens = {
    ...(await tokenResponse.json()),
    client_id,
    received_at: Date.now() / 1000,
  };
  for (const [step, body] of [
    ["core_config", {}],
    ["analytics", {}],
    ["integration", { client_id, redirect_uri: client_id }],
  ]) {
    const r = await fetch(origin + "/api/onboarding/" + step, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + tokens.access_token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) throw Error("Fixture onboarding step rejected");
  }
  await writeFile(
    join(dir, "fixture.json"),
    JSON.stringify(
      {
        container: name,
        image: images[version],
        version,
        config_dir,
        network,
        network_cidr: cidr,
        origin,
        credentials,
        tokens,
        podman_args: args,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  phase = "managed HTTP confirmation";
  await confirmFixtureProxy(join(dir, "fixture.json"));
  console.log(
    "PASS generated HA fixture. Private descriptor: " +
      join(dir, "fixture.json"),
  );
  console.log(
    "No GitHub login, store installation, physical camera or device proof is implied.",
  );
} catch {
  // Never print response bodies, tokens or raw container errors.
  try {
    await writeFile(join(dir, "failure-private.log"), podman("logs", name), {
      mode: 0o600,
    });
  } catch {
    /* absent */
  }
  try {
    podman("rm", "-f", name);
  } catch {
    /* absent */
  }
  try {
    podman("network", "rm", network);
  } catch {
    /* absent */
  }
  throw Error(
    "Disposable HA setup failed during " +
      phase +
      "; private directory: " +
      dir,
  );
}
