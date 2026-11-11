import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { createRouter } from "../../examples/proxy/router.mjs";
import { startProxy } from "../probes/proxy.mjs";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
function send(origin, path, headers) {
  const target = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path,
        headers,
        agent: false,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.setTimeout(5000, () =>
      req.destroy(Error("Isolated authority regression timeout")),
    );
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      reject(Error("Unexpected accepted adversarial upgrade"));
    });
    req.on("error", reject);
    req.end();
  });
}
export async function authorityConfinement() {
  const escaped = { http: 0, ws: 0, connections: 0 };
  const trap = http.createServer((_req, res) => {
    escaped.http++;
    res.end("trap");
  });
  trap.on("upgrade", (_req, socket) => {
    escaped.ws++;
    socket.end("HTTP/1.1 403 Rejected\r\nConnection: close\r\n\r\n");
  });
  trap.on("connection", () => escaped.connections++);
  const trapOrigin = await listen(trap);
  const trapAuthority = new URL(trapOrigin).host;
  const received = { http: [], ws: [] };
  const upstream = http.createServer((req, res) => {
    received.http.push({
      path: req.url,
      host: req.headers.host,
      origin: req.headers.origin,
    });
    res.end("configured upstream");
  });
  upstream.on("upgrade", (req, socket) => {
    received.ws.push({
      path: req.url,
      host: req.headers.host,
      origin: req.headers.origin,
    });
    socket.end("HTTP/1.1 401 Rejected\r\nConnection: close\r\n\r\n");
  });
  const upstreamOrigin = await listen(upstream);
  const scope = "/lightnvr/front/";
  const router = createRouter({
    origins: ["https://ha.example.test"],
    trustedPeers: ["127.0.0.1"],
    scopes: [
      {
        prefix: scope,
        cookieName: "lnvr_front_session",
        upstream: upstreamOrigin + "/",
      },
    ],
  });
  const routerOrigin = await listen(router.server);
  let proof;
  const cases = [
    ["network-path authority", "/" + trapAuthority + "/api/escaped"],
    ["triple slash", "//" + trapAuthority + "/api/escaped"],
    ["backslash authority", "\\" + trapAuthority + "/api/escaped"],
    ["encoded slashes", "%2f%2f" + trapAuthority + "/api/escaped"],
    ["double-encoded slashes", "%252f%252f" + trapAuthority + "/api/escaped"],
    ["encoded backslashes", "%5c%5c" + trapAuthority + "/api/escaped"],
    ["embedded HTTP URL", trapOrigin + "/api/escaped"],
    ["embedded HTTPS URL", "https://" + trapAuthority + "/api/escaped"],
    [
      "userinfo authority",
      "/generated:fixture@" + trapAuthority + "/api/escaped",
    ],
    [
      "encoded traversal to authority",
      "api/%2e%2e//" + trapAuthority + "/api/escaped",
    ],
  ];
  const upgrade = {
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
  };
  try {
    for (const value of [
      "https://127.0.0.1:12345/",
      "http://192.0.2.1:12345/",
      "http://localhost:12345/",
      upstreamOrigin + "/nested/",
      upstreamOrigin + "/?query",
      upstreamOrigin + "/#fragment",
      "http://generated:fixture@127.0.0.1:12345/",
    ]) {
      await assert.rejects(
        startProxy(value),
        /Only generated loopback HTTP fixture roots/,
      );
    }
    proof = await startProxy(upstreamOrigin + "/");
    const targets = [
      {
        name: "production",
        origin: routerOrigin,
        headers: {
          host: "ha.example.test",
          origin: "https://ha.example.test",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "ha.example.test",
        },
      },
      {
        name: "proof",
        origin: proof.origin,
        headers: { origin: proof.origin },
      },
    ];
    for (const target of targets) {
      const beforeHttp = received.http.length,
        beforeWs = received.ws.length;
      for (const [name, suffix] of cases) {
        assert.equal(
          await send(target.origin, scope + suffix, target.headers),
          400,
          target.name + " HTTP " + name,
        );
        assert.equal(
          await send(target.origin, scope + suffix, {
            ...target.headers,
            ...upgrade,
          }),
          400,
          target.name + " WS " + name,
        );
      }
      assert.equal(
        received.http.length,
        beforeHttp,
        target.name + ": rejected HTTP paths never forwarded",
      );
      assert.equal(
        received.ws.length,
        beforeWs,
        target.name + ": rejected WS paths never forwarded",
      );
      // Absolute-form request targets also cannot select an outbound authority.
      const absolute = trapOrigin + scope + "api/escaped";
      assert.equal(
        await send(target.origin, absolute, target.headers),
        target.name === "production" ? 400 : 200,
      );
      assert.equal(
        await send(target.origin, absolute, { ...target.headers, ...upgrade }),
        target.name === "production" ? 400 : 403,
      );
      const query =
        "src=front%2fdoor%26%3f%25&repeat=a&repeat=b&empty=&encoded=%252f";
      assert.equal(
        await send(
          target.origin,
          scope + "api/%76erify?" + query,
          target.headers,
        ),
        200,
      );
      const httpSeen = received.http.at(-1);
      assert.equal(
        httpSeen.path,
        "/api/%76erify?" + query,
        target.name + ": exact encoded HTTP target",
      );
      assert.equal(
        httpSeen.host,
        target.headers.host ?? new URL(target.origin).host,
      );
      assert.equal(httpSeen.origin, target.headers.origin);
      assert.equal(
        await send(target.origin, scope + "go2rtc/api/ws?" + query, {
          ...target.headers,
          ...upgrade,
        }),
        401,
      );
      const wsSeen = received.ws.at(-1);
      assert.equal(
        wsSeen.path,
        "/go2rtc/api/ws?" + query,
        target.name + ": exact encoded WS target",
      );
      assert.equal(
        wsSeen.host,
        target.headers.host ?? new URL(target.origin).host,
      );
      assert.equal(wsSeen.origin, target.headers.origin);
    }
    assert.deepEqual(escaped, { http: 0, ws: 0, connections: 0 });
    console.log(
      JSON.stringify({
        authorityRegression: "passed",
        helpers: 2,
        casesPerHelper: cases.length + 1,
        protocols: ["HTTP", "WS"],
        encodedTargetsPreserved: true,
        trap: escaped,
      }),
    );
  } finally {
    await proof?.close();
    await router.close();
    await close(upstream);
    await close(trap);
  }
}

export async function ipv6Loopback() {
  const received = { http: [], ws: [] };
  const upstream = http.createServer((req, res) => {
    received.http.push(req.url);
    res.end("owned IPv6 upstream");
  });
  upstream.on("upgrade", (req, socket) => {
    received.ws.push(req.url);
    socket.end("HTTP/1.1 401 Rejected\r\nConnection: close\r\n\r\n");
  });
  try {
    await new Promise((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "::1", resolve);
    });
  } catch (error) {
    if (
      [
        "EAFNOSUPPORT",
        "EADDRNOTAVAIL",
        "EPROTONOSUPPORT",
        "ENETUNREACH",
      ].includes(error.code)
    ) {
      console.log(
        JSON.stringify({ ipv6Loopback: "unavailable", reason: error.code }),
      );
      return;
    }
    throw error;
  }
  const upstreamOrigin = `http://[::1]:${upstream.address().port}/`;
  const scope = "/lightnvr/front/";
  const router = createRouter({
    origins: ["https://ha.example.test"],
    trustedPeers: ["127.0.0.1"],
    scopes: [
      {
        prefix: scope,
        cookieName: "lnvr_front_session",
        upstream: upstreamOrigin,
      },
    ],
  });
  let proof;
  try {
    const origin = await listen(router.server);
    proof = await startProxy(upstreamOrigin);
    for (const target of [
      {
        origin,
        headers: {
          host: "ha.example.test",
          origin: "https://ha.example.test",
          "x-forwarded-host": "ha.example.test",
          "x-forwarded-proto": "https",
        },
      },
      { origin: proof.origin, headers: { origin: proof.origin } },
    ]) {
      assert.equal(
        await send(
          target.origin,
          scope + "api/%76erify?src=ipv6%2Fcase",
          target.headers,
        ),
        200,
      );
      assert.equal(received.http.at(-1), "/api/%76erify?src=ipv6%2Fcase");
      assert.equal(
        await send(target.origin, scope + "go2rtc/api/ws?src=ipv6%2Fcase", {
          ...target.headers,
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        }),
        401,
      );
      assert.equal(received.ws.at(-1), "/go2rtc/api/ws?src=ipv6%2Fcase");
    }
    assert.equal(received.http.length, 2);
    assert.equal(received.ws.length, 2);
    console.log(
      JSON.stringify({
        ipv6Loopback: "passed",
        helpers: 2,
        httpRequests: 2,
        wsRequests: 2,
      }),
    );
  } finally {
    await proof?.close();
    await router.close();
    await close(upstream);
  }
}

export async function tlsUpstreamIdentity() {
  const { default: https } = await import("node:https");
  const { spawn, execFileSync } = await import("node:child_process");
  const { mkdtemp, readFile, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { lookup } = await import("node:dns/promises");
  const dir = await mkdtemp(tmpdir() + "/lightnvr-T3-tls-");
  const seen = [];
  let child, routerPort, v4, v6;
  try {
    assert(
      (await lookup("localhost", { all: true })).every((a) =>
        ["127.0.0.1", "::1"].includes(a.address),
      ),
    );
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
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1",
        "-keyout",
        dir + "/key.pem",
        "-out",
        dir + "/cert.pem",
      ],
      { stdio: "ignore" },
    );
    const key = await readFile(dir + "/key.pem"),
      cert = await readFile(dir + "/cert.pem");
    function ownedTLS() {
      function observe(req, method) {
        const record = {
          method,
          host: req.headers.host,
          origin: req.headers.origin,
          forwardedHost: req.headers["x-forwarded-host"],
          forwardedProto: req.headers["x-forwarded-proto"],
          sni: req.socket.servername || "",
          path: req.url,
        };
        seen.push(record);
        // Model a remote hostname-routed HTTPS ingress and its same-origin gateway.
        return (
          !req.url.includes("external=1") ||
          (req.headers.host === `localhost:${req.socket.localPort}` &&
            req.headers.origin === `https://${req.headers.host}`)
        );
      }
      const server = https.createServer({ key, cert }, (req, res) => {
        res.statusCode = observe(req, "HTTP") ? 200 : 421;
        res.end("owned upstream TLS");
      });
      server.on("upgrade", (req, socket) => {
        const status = observe(req, "WS") ? 401 : 421;
        socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
      });
      return server;
    }
    v4 = ownedTLS();
    const v4Origin = (await listen(v4)).replace("http:", "https:");
    const targets = [
      {
        scope: "dns",
        upstream: v4Origin.replace("127.0.0.1", "localhost") + "/",
        sni: "localhost",
      },
      { scope: "ipv4", upstream: v4Origin + "/", sni: "" },
      {
        scope: "external",
        upstream: v4Origin.replace("127.0.0.1", "localhost") + "/",
        sni: "localhost",
        forwardAuthority: "upstream",
      },
    ];
    v6 = ownedTLS();
    try {
      await new Promise((resolve, reject) => {
        v6.once("error", reject);
        v6.listen(0, "::1", resolve);
      });
      targets.push({
        scope: "ipv6",
        upstream: `https://[::1]:${v6.address().port}/`,
        sni: "",
      });
    } catch (error) {
      if (
        ![
          "EAFNOSUPPORT",
          "EADDRNOTAVAIL",
          "EPROTONOSUPPORT",
          "ENETUNREACH",
        ].includes(error.code)
      )
        throw error;
      v6 = undefined;
    }
    // Trust the actual generated CA on every HTTPS client request; a different owned
    // server certificate must still be rejected as an untrusted issuer.
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
        "/CN=untrusted",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-keyout",
        dir + "/other-key.pem",
        "-out",
        dir + "/other-cert.pem",
      ],
      { stdio: "ignore" },
    );
    const other = https.createServer(
      {
        key: await readFile(dir + "/other-key.pem"),
        cert: await readFile(dir + "/other-cert.pem"),
      },
      (_req, res) => res.end(),
    );
    const otherOrigin = (await listen(other)).replace("http:", "https:");
    try {
      await assert.rejects(
        new Promise((resolve, reject) => {
          const req = https.get(otherOrigin, { ca: cert }, (res) => {
            res.resume();
            resolve();
          });
          req.on("error", reject);
        }),
        { code: "DEPTH_ZERO_SELF_SIGNED_CERT" },
      );
    } finally {
      await close(other);
    }
    const reserve = http.createServer();
    const reserveOrigin = await listen(reserve);
    routerPort = Number(new URL(reserveOrigin).port);
    await close(reserve);
    await writeFile(
      dir + "/router.json",
      JSON.stringify({
        bind: "127.0.0.1",
        port: routerPort,
        origins: ["https://ha.example.test"],
        trustedPeers: ["127.0.0.1"],
        scopes: targets.map((t) => ({
          prefix: `/lightnvr/${t.scope}/`,
          cookieName: `lnvr_${t.scope}`,
          upstream: t.upstream,
          forwardAuthority: t.forwardAuthority,
        })),
      }),
    );
    // Existing Node CA support only; no added proxy CA option or global host/DNS changes.
    child = spawn(
      process.execPath,
      [
        "--dns-result-order=ipv4first",
        new URL("../../examples/proxy/router.mjs", import.meta.url).pathname,
      ],
      {
        env: {
          ...process.env,
          LIGHTNVR_ROUTER_CONFIG: dir + "/router.json",
          NODE_EXTRA_CA_CERTS: dir + "/cert.pem",
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let childError = "";
    child.stderr.on("data", (data) => {
      childError += data.toString();
    });
    const origin = `http://127.0.0.1:${routerPort}`;
    for (let i = 0; i < 50; i++) {
      if (child.exitCode !== null)
        throw Error("Owned TLS router fixture exited: " + childError);
      try {
        if ((await send(origin, "/not-routed", {})) === 403) break;
      } catch {
        /* startup */
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const headers = {
      host: "ha.example.test",
      origin: "https://ha.example.test",
      "x-forwarded-host": "ha.example.test",
      "x-forwarded-proto": "https",
    };
    for (const target of targets) {
      const external = target.forwardAuthority === "upstream";
      const upstream = new URL(target.upstream);
      const expectedAuthority = external ? upstream : new URL(headers.origin);
      const query = external ? "x=%2f&external=1" : "x=%2f";
      assert.equal(
        await send(
          origin,
          `/lightnvr/${target.scope}/api/%76erify?${query}`,
          headers,
        ),
        200,
        target.scope + " HTTPS",
      );
      assert.deepEqual(seen.at(-1), {
        method: "HTTP",
        host: expectedAuthority.host,
        origin: expectedAuthority.origin,
        forwardedHost: expectedAuthority.host,
        forwardedProto: "https",
        sni: target.sni,
        path: `/api/%76erify?${query}`,
      });
      assert.equal(
        await send(origin, `/lightnvr/${target.scope}/go2rtc/api/ws?${query}`, {
          ...headers,
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        }),
        401,
        target.scope + " WS over upstream TLS",
      );
      assert.deepEqual(seen.at(-1), {
        method: "WS",
        host: expectedAuthority.host,
        origin: expectedAuthority.origin,
        forwardedHost: expectedAuthority.host,
        forwardedProto: "https",
        sni: target.sni,
        path: `/go2rtc/api/ws?${query}`,
      });
    }
    assert.equal(seen.length, targets.length * 2);
    const beforeDenials = seen.length;
    for (const badOrigin of [
      "https://hostile.example.test",
      "null",
      targets[2].upstream.slice(0, -1),
    ]) {
      for (const path of ["api/verify", "go2rtc/api/ws"]) {
        assert.equal(
          await send(origin, `/lightnvr/external/${path}`, {
            ...headers,
            origin: badOrigin,
            ...(path.endsWith("ws")
              ? {
                  Connection: "Upgrade",
                  Upgrade: "websocket",
                  "Sec-WebSocket-Version": "13",
                  "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
                }
              : {}),
          }),
          403,
        );
      }
    }
    assert.equal(
      seen.length,
      beforeDenials,
      "hostile Origins must never be translated upstream",
    );
    console.log(
      JSON.stringify({
        upstreamTLS: "passed",
        authorities: targets.map((t) => t.scope),
        requests: seen.length,
        publicHostPreserved: true,
        externalAuthorityTranslated: true,
        hostileOriginsRejectedBeforeForwarding: true,
        untrustedIssuerRejected: true,
        dnsSNI: "localhost",
        ipSNI: "absent",
      }),
    );
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }
    if (v4) await close(v4);
    if (v6) await close(v6);
    await rm(dir, { recursive: true, force: true });
  }
}
