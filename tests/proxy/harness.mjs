import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes, createHash, X509Certificate } from "node:crypto";
import { chromium } from "@playwright/test";
import {
  createRouter,
  rewritePlaylist,
  safePath,
} from "../../examples/proxy/router.mjs";

const traefikImage =
  "docker.io/library/traefik@sha256:e15b8921020b4fd81de5746b170dfceec221d2450711449f6427e4692881511a";
const nodeImage =
  "docker.io/library/node@sha256:cb15fca92530d7ac113467696cf1001208dac49c3c64355fd1348c11a88ddf8f";
const sourceRevision = "4e578c1dac4a21688b420c8fc852f741d62efd2e";
const run = (...args) =>
  execFileSync("podman", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 45000,
  }).trim();
async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
function request(origin, path, headers = {}, ca) {
  return new Promise((resolve, reject) => {
    const target = new URL(origin);
    if (target.protocol === "https:" && !ca) {
      reject(Error("Explicit generated fixture CA required for HTTPS"));
      return;
    }
    const req = (target.protocol === "https:" ? https : http).request(
      {
        hostname: target.hostname,
        port: target.port,
        path,
        headers,
        ...(target.protocol === "https:" ? { ca } : {}),
      },
      (res) => {
        const chunks = [];
        res.on("data", (b) => chunks.push(b));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.setTimeout(10000, () =>
      req.destroy(Error("Isolated HTTP request timeout")),
    );
    req.on("error", (error) =>
      reject(
        Error(
          "Isolated HTTP endpoint " + path.split("?")[0] + ": " + error.message,
        ),
      ),
    );
    req.end();
  });
}
export async function fixtureSafety() {
  const received = [];
  const upstream = http.createServer((req, res) => {
    received.push({ path: req.url, headers: req.headers });
    if (req.url.startsWith("/api/login")) {
      res.writeHead(200, {
        "Set-Cookie": [
          "session=generated; Domain=private.invalid; Path=/; Max-Age=60; HttpOnly; SameSite=Lax",
          "ignored=bad; Path=/",
        ],
        Location: "/api/verify",
      });
      res.end();
    } else if (req.url.startsWith("/api/duplicate")) {
      res.setHeader("Set-Cookie", ["session=one", "session=two"]);
      res.end();
    } else if (req.url.startsWith("/api/strict")) {
      res.setHeader("Set-Cookie", "session=generated; SameSite=Strict");
      res.end();
    } else if (req.url.startsWith("/api/absolute")) {
      res.writeHead(302, {
        Location: upstreamOrigin + "/api/verify?next=a%2Fb",
      });
      res.end();
    } else if (req.url.startsWith("/api/logout")) {
      res.setHeader("Set-Cookie", "session=; Max-Age=0; Path=/");
      res.end();
    } else if (req.url.startsWith("/api/redirect")) {
      res.writeHead(302, { Location: "https://foreign.invalid/steal" });
      res.end();
    } else if (req.url.startsWith("/api/expired")) {
      res.writeHead(401);
      res.end();
    } else if (req.url.includes(".m3u8")) {
      res.setHeader("Content-Type", "audio/x-mpegurl");
      if (req.url.includes("partial")) {
        res.writeHead(206);
        res.end("#EXTM3U\nsegment.ts");
      } else if (req.url.includes("compressed")) {
        res.setHeader("Content-Encoding", "gzip");
        res.end("#EXTM3U\nsegment.ts");
      } else if (req.url.includes("foreign"))
        res.end("#EXTM3U\nhttps://foreign.invalid/segment.ts");
      else if (req.url.includes("oversize"))
        res.end("#EXTM3U\n" + "#".repeat(1024 * 1024));
      else if (req.url.includes("outside"))
        res.end("#EXTM3U\n../../api/auth/verify");
      else
        res.end(
          '#EXTM3U\n#EXT-X-MAP:URI="../init.mp4?id=a%2Fb%26c"\n#EXT-X-KEY:METHOD=AES-128,URI="/hls/test/key"\n../nested/segment.ts?id=a%2Fb%26c\n',
        );
    } else {
      res.end("ok");
    }
  });
  const upstreamOrigin = await listen(upstream);
  const scope = {
    prefix: "/nested/lightnvr/front/",
    cookieName: "lnvr_front_session",
    upstream: upstreamOrigin + "/",
  };
  const router = createRouter({
    trustedPeers: ["127.0.0.1"],
    origins: ["https://ha.example.test"],
    scopes: [
      scope,
      { ...scope, prefix: "/lightnvr/back/", cookieName: "lnvr_back_session" },
    ],
  });
  const origin = await listen(router.server);
  const headers = {
    host: "ha.example.test",
    "x-forwarded-host": "ha.example.test",
    "x-forwarded-proto": "https",
    origin: "https://ha.example.test",
  };
  const get = (path, extra = {}) =>
    request(origin, path, { ...headers, ...extra });
  try {
    for (const path of [
      "/a/../b",
      "/a/%2e%2e/b",
      "/a/%252e%252e/b",
      "/a/%2fb",
      "/a\\b",
      "//evil",
      "/%zz",
    ])
      assert.equal(safePath(path), false);
    assert.equal(safePath("/hls/front%20door/index.m3u8"), true);
    const login = await get(scope.prefix + "api/login");
    assert.equal(login.status, 200);
    assert.match(
      login.headers["set-cookie"][0],
      /lnvr_front_session=generated;/,
    );
    assert.match(
      login.headers["set-cookie"][0],
      /Path=\/nested\/lightnvr\/front\/; Secure; HttpOnly; SameSite=Lax/,
    );
    assert.doesNotMatch(login.headers["set-cookie"][0], /Domain=/i);
    assert.equal(login.headers["set-cookie"].length, 1);
    assert.equal(login.headers.location, scope.prefix + "api/verify");
    await get(scope.prefix + "api/verify?src=front%20door%2F%26%3F%25", {
      cookie:
        "ha=private; session=ha-session; lnvr_back_session=other; lnvr_front_session=chosen",
      forwarded: "host=evil",
      "x-forwarded-for": "evil",
      "x-auth-user": "admin",
    });
    const seen = received.at(-1);
    assert.equal(seen.path, "/api/verify?src=front%20door%2F%26%3F%25");
    assert.equal(seen.headers.cookie, "session=chosen");
    assert.equal(seen.headers.origin, headers.origin);
    assert.equal(seen.headers.host, "ha.example.test");
    assert.equal(seen.headers["x-forwarded-proto"], "https");
    assert.equal(seen.headers.forwarded, undefined);
    assert.equal(seen.headers["x-forwarded-for"], undefined);
    assert.equal(seen.headers["x-auth-user"], undefined);
    const before = received.length;
    for (const extra of [
      { origin: "https://evil.invalid" },
      { origin: "null" },
      { host: "evil.invalid" },
      { "x-forwarded-proto": "http" },
      { "sec-fetch-site": "cross-site" },
    ])
      assert.equal((await get(scope.prefix + "api/verify", extra)).status, 403);
    assert.equal(
      (
        await get(scope.prefix + "api/verify", {
          cookie: "lnvr_front_session=a; lnvr_front_session=b",
        })
      ).status,
      400,
    );
    for (const path of [
      scope.prefix + "go2rtc/api/streams",
      scope.prefix + "go2rtc/api/config",
      "/api/ha",
      "/lightnvr/frontier/api/verify",
    ])
      assert.equal((await get(path)).status, 404);
    for (const path of [
      scope.prefix + "hls/%2e%2e/api",
      scope.prefix + "hls/%2Fsecret",
      scope.prefix + "hls/%252e%252e/x",
    ])
      assert.equal((await get(path)).status, 400);
    assert.equal(received.length, before);
    const playlist = await get(scope.prefix + "hls/test/nested/index.m3u8");
    assert.equal(playlist.status, 200);
    assert.match(
      playlist.body,
      /\/nested\/lightnvr\/front\/hls\/test\/init.mp4\?id=a%2Fb%26c/,
    );
    assert.match(
      playlist.body,
      /URI="\/nested\/lightnvr\/front\/hls\/test\/key"/,
    );
    assert.match(
      playlist.body,
      /\/nested\/lightnvr\/front\/hls\/test\/nested\/segment.ts/,
    );
    for (const name of [
      "foreign",
      "outside",
      "oversize",
      "partial",
      "compressed",
    ])
      assert.equal((await get(scope.prefix + `hls/${name}.m3u8`)).status, 502);
    assert.equal((await get(scope.prefix + "api/redirect")).status, 502);
    assert.equal((await get(scope.prefix + "api/expired")).status, 401);
    assert.equal((await get(scope.prefix + "api/duplicate")).status, 502);
    assert.match(
      (await get(scope.prefix + "api/strict")).headers["set-cookie"][0],
      /SameSite=Strict/,
    );
    assert.equal(
      (await get(scope.prefix + "api/absolute")).headers.location,
      scope.prefix + "api/verify?next=a%2Fb",
    );
    assert.equal(
      (
        await get(scope.prefix + "api/oversize", {
          "Content-Length": String(2 * 1024 * 1024 + 1),
        })
      ).status,
      413,
    );
    for (const manifest of [
      "#EXTM3U\n#EXT-X-KEY:URI=//evil.invalid/key",
      '#EXTM3U\n#EXT-X-MAP:URI = "init.mp4"',
      '#EXTM3U\n#EXT-X-MAP:URI="https://evil.invalid/init.mp4"',
    ])
      assert.throws(() =>
        rewritePlaylist(manifest, "/hls/test/index.m3u8", scope),
      );
    // Duplicate singleton headers are rejected even though Node combines some values.
    const raw = await new Promise((resolve, reject) => {
      const socket = net.connect(Number(new URL(origin).port), "127.0.0.1");
      let body = "";
      socket.on("connect", () =>
        socket.write(
          "GET " +
            scope.prefix +
            "api/verify HTTP/1.1\r\nHost: ha.example.test\r\nX-Forwarded-Host: ha.example.test\r\nX-Forwarded-Proto: https\r\nCookie: lnvr_front_session=a\r\nCookie: lnvr_front_session=b\r\nConnection: close\r\n\r\n",
        ),
      );
      socket.on("data", (b) => {
        body += b;
      });
      socket.on("end", () => resolve(body));
      socket.on("error", reject);
    });
    assert.match(raw, /^HTTP\/1.1 400/);
    const upgradeHeaders = {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
    };
    const reached = received.length;
    assert.equal(
      (
        await get(scope.prefix + "go2rtc/api/ws?src=generated", {
          ...upgradeHeaders,
          origin: "https://evil.invalid",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await get(scope.prefix + "go2rtc/api/ws?src=generated", {
          ...upgradeHeaders,
          origin: "",
        })
      ).status,
      403,
    );
    assert.equal(received.length, reached);
    const logout = await get(scope.prefix + "api/logout");
    assert.match(logout.headers["set-cookie"][0], /Max-Age=0/);
    const manifest = rewritePlaylist(
      "#EXTM3U\nhls/playlist.m3u8?id=q%2Fz",
      "/go2rtc/api/stream.m3u8",
      scope,
    );
    assert.equal(
      manifest,
      "#EXTM3U\n" + scope.prefix + "go2rtc/api/hls/playlist.m3u8?id=q%2Fz",
    );
    assert.throws(() =>
      createRouter({ trustedPeers: [], origins: [], scopes: [] }),
    );
    assert.throws(
      () =>
        createRouter({
          trustedPeers: ["127.0.0.1"],
          origins: ["https://ha.example.test"],
          scopes: [{ ...scope, forwardAuthority: "arbitrary" }],
        }),
      /Invalid scope/,
    );
    const denied = createRouter({
      trustedPeers: ["192.0.2.1"],
      origins: ["https://ha.example.test"],
      scopes: [scope],
    });
    const deniedOrigin = await listen(denied.server);
    try {
      assert.equal(
        (await request(deniedOrigin, scope.prefix + "api/verify", headers))
          .status,
        403,
      );
    } finally {
      await denied.close();
    }
  } finally {
    await router.close();
    await close(upstream);
  }
}

export async function upstreamSmoke() {
  if (!process.env.LIGHTNVR_PROBE_FIXTURE)
    throw Error(
      "INCOMPLETE: set LIGHTNVR_PROBE_FIXTURE to an isolated T1 fixture descriptor; no mocked upstream pass",
    );
  const fixture = JSON.parse(
    await readFile(process.env.LIGHTNVR_PROBE_FIXTURE, "utf8"),
  );
  const u = new URL(fixture.origin);
  assert.equal(u.hostname, "127.0.0.1");
  assert.equal(u.protocol, "http:");
  assert.equal(u.pathname, "/");
  assert.equal(u.username, "");
  assert.equal(u.password, "");
  const container = JSON.parse(run("inspect", fixture.container))[0];
  const image = JSON.parse(run("image", "inspect", container.Image))[0];
  assert.equal(container.Config.Labels?.["io.lightnvr-card.fixture"], "T1");
  assert.equal(container.State.Running, true);
  assert.equal(
    image.Labels["org.opencontainers.image.revision"],
    sourceRevision,
  );
  assert(
    container.NetworkSettings.Ports["8080/tcp"].some(
      (p) => p.HostIp === "127.0.0.1" && p.HostPort === u.port,
    ),
  );
  const dir = await mkdtemp(`${tmpdir()}/lightnvr-T3-`);
  const name = `lightnvr-t3-${randomBytes(4).toString("hex")}`;
  const nativeStem = "t3-" + randomBytes(4).toString("hex");
  assert.match(fixture.source, /^[a-zA-Z0-9_.-]+$/);
  const nativeDir = "/var/lib/lightnvr/data/recordings/hls/" + fixture.source;
  const nativeFiles = [
    nativeDir + "/" + nativeStem + ".m3u8",
    ...Array.from(
      { length: 8 },
      (_, i) => nativeDir + "/" + nativeStem + i + ".ts",
    ),
  ];
  const scopes = [
    {
      prefix: "/lightnvr/front/",
      cookieName: "lnvr_front_session",
      upstream: fixture.origin,
      forwardAuthority: "upstream",
    },
    {
      prefix: "/lightnvr/back/",
      cookieName: "lnvr_back_session",
      upstream: fixture.origin,
    },
  ];
  let browser,
    router,
    ha,
    started = false,
    startedRouter = false;
  const checks = [];
  const check = (label, value) => {
    assert(value, label);
    checks.push(label);
  };
  try {
    // Generated local HLS exercises the real native handler, without depending on live native production.
    run("exec", fixture.container, "mkdir", "-p", nativeDir);
    run(
      "exec",
      fixture.container,
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=160x90:rate=10",
      "-t",
      "3",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "10",
      "-hls_time",
      "1",
      "-hls_segment_filename",
      nativeDir + "/" + nativeStem + "%d.ts",
      "-f",
      "hls",
      nativeFiles[0],
    );
    // Reserve an unused loopback port; Traefik binds only this test-owned address.
    const reserve = net.createServer();
    await listen(reserve);
    const port = reserve.address().port;
    await new Promise((resolve) => reserve.close(resolve));
    const publicOrigin = `https://127.0.0.1:${port}`;
    router = createRouter({
      bind: "127.0.0.1",
      origins: [publicOrigin],
      trustedPeers: ["127.0.0.1"],
      scopes,
    });
    const helperOrigin = await listen(router.server);
    ha = http.createServer((req, res) => {
      res.setHeader(
        "Content-Type",
        req.url === "/cookie-check" ? "application/json" : "text/html",
      );
      res.end(
        req.url === "/cookie-check"
          ? JSON.stringify({
              nvrCookie: /lnvr_/.test(req.headers.cookie ?? ""),
            })
          : "<!doctype html><title>Owned HA origin fixture</title>",
      );
    });
    const haOrigin = await listen(ha);
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-keyout",
        dir + "/ha.key",
        "-out",
        dir + "/ha.crt",
      ],
      { stdio: "ignore" },
    );
    await chmod(dir + "/ha.key", 0o600);
    await chmod(dir, 0o755); // Generated routing config contains no login credentials.
    const certificate = await readFile(dir + "/ha.crt");
    const spki = createHash("sha256")
      .update(
        new X509Certificate(certificate).publicKey.export({
          type: "spki",
          format: "der",
        }),
      )
      .digest("base64");
    const template = await readFile(
      new URL("../../examples/proxy/traefik.dynamic.yaml", import.meta.url),
      "utf8",
    );
    const dynamic = template
      .replaceAll("ha.example.test", "127.0.0.1")
      .replace("http://router:8080", helperOrigin)
      .replaceAll("/certs/", "/t3/")
      .replace(
        "tls:\n  certificates:",
        "tls:\n  stores:\n    default:\n      defaultCertificate:\n        certFile: /t3/ha.crt\n        keyFile: /t3/ha.key\n  certificates:",
      );
    await writeFile(dir + "/nvr.yaml", dynamic);
    await writeFile(
      dir + "/ha.yaml",
      `http:\n  routers:\n    ha:\n      rule: "Host(\`127.0.0.1\`)"\n      priority: 1\n      entryPoints: [websecure]\n      service: ha\n      tls: {}\n  services:\n    ha:\n      loadBalancer:\n        servers:\n          - url: ${haOrigin}\n`,
    );
    await writeFile(
      dir + "/router.json",
      JSON.stringify({
        bind: "127.0.0.1",
        port: Number(new URL(helperOrigin).port),
        origins: [publicOrigin],
        trustedPeers: ["127.0.0.1"],
        scopes,
      }),
    );
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir + "/dynamic");
    await writeFile(dir + "/dynamic/nvr.yaml", dynamic);
    await writeFile(dir + "/dynamic/ha.yaml", await readFile(dir + "/ha.yaml"));
    await writeFile(
      dir + "/traefik.yaml",
      `entryPoints:\n  websecure:\n    address: "127.0.0.1:${port}"\n    forwardedHeaders:\n      insecure: false\nproviders:\n  file:\n    directory: /t3/dynamic\nlog:\n  level: ERROR\n`,
    );
    await router.close();
    router = undefined;
    await writeFile(
      dir + "/router.mjs",
      await readFile(
        new URL("../../examples/proxy/router.mjs", import.meta.url),
      ),
    );
    run(
      "run",
      "-d",
      "--name",
      name + "-router",
      "--user",
      "65534:65534",
      "--label",
      "io.lightnvr-card.fixture=T3",
      "--network",
      "host",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "-v",
      `${dir}:/t3:ro,z`,
      "-e",
      "LIGHTNVR_ROUTER_CONFIG=/t3/router.json",
      nodeImage,
      "node",
      "/t3/router.mjs",
    );
    startedRouter = true;
    check(
      "Node image 22.22.2 runtime",
      run("exec", name + "-router", "node", "--version") === "v22.22.2",
    );
    run(
      "run",
      "-d",
      "--name",
      name,
      "--label",
      "io.lightnvr-card.fixture=T3",
      "--network",
      "host",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "-v",
      `${dir}:/t3:ro,z`,
      traefikImage,
      "--configFile=/t3/traefik.yaml",
    );
    started = true;
    for (let i = 0; i < 50; i++) {
      try {
        if ((await request(publicOrigin, "/", {}, certificate)).status === 200)
          break;
      } catch {
        /* startup */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const version = run("exec", name, "traefik", "version");
    check("Traefik 3.7.17 runtime", /Version:\s+3\.7\.17/.test(version));
    await assert.rejects(
      new Promise((resolve, reject) => {
        const req = https.get(
          publicOrigin,
          { ca: certificate, servername: "wrong.fixture.invalid" },
          (res) => {
            res.resume();
            resolve();
          },
        );
        req.setTimeout(10000, () =>
          req.destroy(Error("Isolated TLS hostname timeout")),
        );
        req.on("error", reject);
      }),
      { code: "ERR_TLS_CERT_ALTNAME_INVALID" },
    );
    check("wrong TLS hostname rejected with trusted CA", true);
    const trustedTLS = await new Promise((resolve, reject) => {
      const req = https.get(
        publicOrigin,
        { ca: certificate, rejectUnauthorized: true },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
    });
    check("TLS certificate and IP SAN verified", trustedTLS === 200);
    browser = await chromium.launch({
      headless: true,
      args: ["--ignore-certificate-errors-spki-list=" + spki],
      executablePath:
        process.env.LIGHTNVR_CHROMIUM ?? "/usr/bin/chromium-browser",
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(publicOrigin);
    const result = await page.evaluate(
      async (f) => {
        const front = "/lightnvr/front/",
          back = "/lightnvr/back/";
        const encodedSource = encodeURIComponent(f.source).replace(
          /./,
          (c) => "%" + c.charCodeAt(0).toString(16),
        );
        const credentials = JSON.stringify({
          username: f.username,
          password: f.password,
        });
        const login = async (prefix) =>
          (
            await fetch(prefix + "api/auth/login", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: credentials,
            })
          ).status;
        const loginFront = await login(front);
        const backBefore = (
          await fetch(back + "api/streams?summary=true&surface=live")
        ).status;
        const loginBack = await login(back);
        const inventory = await (
          await fetch(
            front +
              "api/streams?summary=true&surface=live&page=1&page_size=100&availability=all",
          )
        ).json();
        const ws = await new Promise((resolve) => {
          const w = new WebSocket(
            location.origin.replace("https:", "wss:") +
              front +
              "go2rtc/api/ws?src=" +
              encodedSource,
          );
          const timer = setTimeout(() => {
            w.close();
            resolve(false);
          }, 10000);
          w.onopen = () => {
            clearTimeout(timer);
            w.close();
            resolve(true);
          };
          w.onerror = () => {
            clearTimeout(timer);
            resolve(false);
          };
        });
        const pc = new RTCPeerConnection({ iceServers: [] });
        pc.addTransceiver("video", { direction: "recvonly" });
        await pc.setLocalDescription(await pc.createOffer());
        await Promise.race([
          new Promise((resolve) => {
            if (pc.iceGatheringState === "complete") resolve();
            else
              pc.onicegatheringstatechange = () => {
                if (pc.iceGatheringState === "complete") resolve();
              };
          }),
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ]);
        const answer = await fetch(
          front + "go2rtc/api/webrtc?src=" + encodedSource,
          {
            method: "POST",
            headers: { "Content-Type": "application/sdp" },
            body: pc.localDescription.sdp,
          },
        );
        let sdp = false;
        try {
          await pc.setRemoteDescription({
            type: "answer",
            sdp: await answer.text(),
          });
          sdp = answer.status === 201;
        } catch {
          /* invalid */
        } finally {
          pc.close();
        }
        const master = await fetch(
          front + "go2rtc/api/stream.m3u8?src=" + encodedSource + "&mp4=flac",
        );
        const child = (await master.text())
          .split("\n")
          .find((v) => v.trim() && !v.startsWith("#"))
          ?.trim();
        const media = child ? await fetch(child) : null;
        const text = media ? await media.text() : "";
        const init = text.match(/URI="([^"]+)"/)?.[1];
        const segment = text
          .split("\n")
          .find((v) => v.trim() && !v.startsWith("#"))
          ?.trim();
        const initStatus = init ? (await fetch(init)).status : 0;
        const segmentStatus = segment ? (await fetch(segment)).status : 0;
        const anonymous = child
          ? (await fetch(child, { credentials: "omit" })).status
          : 0;
        const crossed = child
          ? (await fetch(child.replace(front, back))).status
          : 0;
        const native = await fetch(
          front + "hls/" + encodedSource + "/" + f.nativeStem + ".m3u8",
        );
        const nativeText = await native.text();
        const nativeChild = nativeText
          .split("\n")
          .find((v) => v.trim() && !v.startsWith("#"))
          ?.trim();
        const nativeSegment = nativeChild
          ? (await fetch(nativeChild)).status
          : 0;
        const anonymousNative = nativeChild
          ? (await fetch(nativeChild, { credentials: "omit" })).status
          : 0;
        const nativeNested = (
          await fetch(front + "hls/" + encodedSource + "/nested/index.m3u8")
        ).status;
        const ha = await (await fetch("/cookie-check")).json();
        const logout = await fetch(front + "api/auth/logout", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: "{}",
        });
        const revokedChild = child ? (await fetch(child)).status : 0;
        const frontAfter = (
          await fetch(front + "api/streams?summary=true&surface=live")
        ).status;
        const backAfter = (
          await fetch(back + "api/streams?summary=true&surface=live")
        ).status;
        return {
          loginFront,
          backBefore,
          loginBack,
          inventory: inventory.streams?.some((s) => s.name === f.source),
          ws,
          sdp,
          master: master.status,
          media: media?.status,
          scoped: [child, init, segment].every((v) => v?.startsWith(front)),
          initStatus,
          segmentStatus,
          anonymous,
          crossed,
          native: native.status === 200 && nativeText.startsWith("#EXTM3U"),
          nativeSegment,
          anonymousNative,
          nativeNested,
          haClean: !ha.nvrCookie,
          logout: logout.status,
          revokedChild,
          frontAfter,
          backAfter,
        };
      },
      { ...fixture, nativeStem },
    );
    await writeFile(dir + "/observations.json", JSON.stringify(result));
    for (const [label, passed] of Object.entries({
      login: result.loginFront === 200 && result.loginBack === 200,
      prefixIsolationBeforeLogin: result.backBefore === 401,
      inventory: result.inventory,
      authenticatedWSS: result.ws,
      SDP201: result.sdp,
      masterMediaInitSegment:
        result.master === 200 &&
        result.media === 200 &&
        result.initStatus === 200 &&
        result.segmentStatus === 200,
      scopedHLS: result.scoped,
      anonymousHLS401: result.anonymous === 401,
      credentialBoundHLS: [401, 403].includes(result.crossed),
      nativePlaylist: result.native,
      nativeSegment: result.nativeSegment === 200,
      anonymousNative401: result.anonymousNative === 401,
      nativeNestedPathRejected: result.nativeNested === 404,
      haCookieAbsent: result.haClean,
      revokedHLS401: result.revokedChild === 401,
      logoutSucceeded: result.logout === 200,
      logoutScopeIsolation:
        result.frontAfter === 401 && result.backAfter === 200,
    }))
      check(label, passed);
    // Cookie properties were collected before logout via back scope (front is deleted).
    const cookies = await context.cookies(publicOrigin + "/lightnvr/back/");
    check(
      "Secure HttpOnly scoped cookie",
      cookies.some(
        (c) =>
          c.name === "lnvr_back_session" &&
          c.path === "/lightnvr/back/" &&
          c.secure &&
          c.httpOnly &&
          c.sameSite === "Lax",
      ),
    );
    const expiryPaths = await page.evaluate(async (source) => {
      const master = await fetch(
        "/lightnvr/back/go2rtc/api/stream.m3u8?src=" +
          encodeURIComponent(source) +
          "&mp4=flac",
      );
      const child = (await master.text())
        .split("\n")
        .find((v) => v.trim() && !v.startsWith("#"))
        ?.trim();
      const media = child ? await fetch(child) : null;
      const text = media ? await media.text() : "";
      return [
        child,
        text.match(/URI="([^"]+)"/)?.[1],
        text
          .split("\n")
          .find((v) => v.trim() && !v.startsWith("#"))
          ?.trim(),
      ];
    }, fixture.source);
    assert(expiryPaths.every((path) => path?.startsWith("/lightnvr/back/")));
    // Advance only this generated session's stored expiry in the exclusively assigned fixture DB.
    const session = cookies.find((c) => c.name === "lnvr_back_session");
    assert.match(session.value, /^[a-z0-9]{16,128}$/i);
    execFileSync(
      "podman",
      [
        "exec",
        "-i",
        fixture.container,
        "sqlite3",
        "/var/lib/lightnvr/data/database/lightnvr.db",
      ],
      {
        input:
          "UPDATE sessions SET expires_at=1, idle_expires_at=1 WHERE token='" +
          session.value +
          "';\n",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10000,
      },
    );
    const expiry = await page.evaluate(
      async () =>
        (await fetch("/lightnvr/back/api/streams?summary=true&surface=live"))
          .status,
    );
    check("actual expired session rejected", expiry === 401);
    const immediateExpiredMedia = await page.evaluate(
      async (paths) =>
        Promise.all(paths.map(async (path) => (await fetch(path)).status)),
      expiryPaths,
    );
    // Upstream intentionally caches media authority for 30 seconds; do not invent immediate revocation.
    await new Promise((resolve) => setTimeout(resolve, 32000));
    const expiredMedia = await page.evaluate(
      async (paths) =>
        Promise.all(paths.map(async (path) => (await fetch(path)).status)),
      expiryPaths,
    );
    await writeFile(
      dir + "/expiry-observations.json",
      JSON.stringify(expiredMedia),
    );
    check(
      "expired media/init/segment rejected after upstream 30-second window",
      expiredMedia.every((status) => status === 401 || status === 403),
    );
    const wsDenied = await request(
      publicOrigin,
      "/lightnvr/back/go2rtc/api/ws?src=generated",
      {
        Origin: publicOrigin,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
      },
      certificate,
    );
    check("anonymous WSS upgrade rejected", wsDenied.status === 401);
    check(
      "no NVR cookie for HA",
      !(await context.cookies(publicOrigin + "/")).some((c) =>
        c.name.startsWith("lnvr_"),
      ),
    );
    check(
      "hostile origin denied at actual edge",
      (
        await request(
          publicOrigin,
          "/lightnvr/back/api/auth/verify",
          { Origin: "https://hostile.invalid" },
          certificate,
        )
      ).status === 403,
    );
    check(
      "forwarded host spoof denied",
      (
        await request(
          publicOrigin,
          "/lightnvr/back/api/auth/verify",
          {
            "X-Forwarded-Host": "hostile.invalid",
            "X-Forwarded-Proto": "http",
          },
          certificate,
        )
      ).status === 401,
    );
    check(
      "raw go2rtc not routed",
      (
        await request(
          publicOrigin,
          "/lightnvr/front/go2rtc/api/streams",
          {},
          certificate,
        )
      ).status === 404,
    );
    const report = {
      status: "passed",
      traefik: "3.7.17",
      traefikImage,
      node: process.version,
      nodeImage,
      tls: "Every Node HTTPS request verifies generated CA and IP SAN, including readiness and rejection tests; wrong hostname rejected; Chromium trusts only the certificate SPKI pin",
      expiredMediaStatuses: expiredMedia,
      immediateExpiredMediaStatuses: immediateExpiredMedia,
      mediaAuthorizationWindowSeconds: 30,
      browser: browser.version(),
      upstream: sourceRevision,
      checks,
      forwardAuthorities: scopes.map((scope) => ({
        prefix: scope.prefix,
        mode: scope.forwardAuthority ?? "public",
      })),
      nativeSegment:
        "passed: generated local TS through real upstream native handler",
      boundaries: [
        "No real HA, Companion, Safari, physical camera or decoded playback acceptance",
        "Expiry forced in isolated fixture DB; no wait for production timeout; native producer/decoded playback not claimed",
      ],
    };
    await writeFile(dir + "/receipt.json", JSON.stringify(report, null, 2));
    if (process.env.LIGHTNVR_PROXY_REPORT)
      await writeFile(
        process.env.LIGHTNVR_PROXY_REPORT,
        JSON.stringify(report, null, 2),
      );
    console.log(JSON.stringify(report));
    await context.close();
  } catch (error) {
    // Only private temporary files may contain browser URLs or generated fixture details.
    await writeFile(dir + "/failure.log", String(error), { mode: 0o600 });
    if (started)
      await writeFile(dir + "/edge.log", run("logs", name), { mode: 0o600 });
    if (startedRouter)
      await writeFile(dir + "/router.log", run("logs", name + "-router"), {
        mode: 0o600,
      });
    throw Error(
      `Actual proxy smoke failed; private diagnostics: ${dir}/failure.log`,
    );
  } finally {
    await browser?.close();
    if (started) run("rm", "-f", name);
    if (startedRouter) run("rm", "-f", name + "-router");
    await router?.close();
    if (ha) await close(ha);
    run("exec", fixture.container, "rm", "-f", ...nativeFiles);
    // Keep sanitized receipt only; generated certs and routing files are temporary evidence.
    for (const path of ["ha.key", "ha.crt"])
      await rm(dir + "/" + path, { force: true });
  }
}
