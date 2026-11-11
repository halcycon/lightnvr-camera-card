// Owned TLS origins + actual lightNVR; no production addresses or credentials.
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, X509Certificate } from "node:crypto";
import { build } from "vite";
import { chromium } from "@playwright/test";
import { createRouter } from "../../examples/proxy/router.mjs";
import { assertOwnedFixture } from "../e2e/ha-edge.mjs";

export async function crossOriginGateway() {
  if (!process.env.LIGHTNVR_PROBE_FIXTURE)
    throw Error("INCOMPLETE: isolated owned lightNVR fixture required");
  const fixture = JSON.parse(
    await readFile(process.env.LIGHTNVR_PROBE_FIXTURE, "utf8"),
  );
  assertOwnedFixture(fixture, "T1");
  const dir = await mkdtemp(join(tmpdir(), "lightnvr-cross-origin-"));
  const sockets = new Set();
  const observations = [];
  let edge, router, browser;
  try {
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
        "/CN=nvr.example.test",
        "-addext",
        "subjectAltName=DNS:ha.example.test,DNS:nvr.example.test,DNS:evil.example.test,DNS:outside.example.invalid",
        "-keyout",
        join(dir, "key"),
        "-out",
        join(dir, "cert"),
      ],
      { stdio: "ignore" },
    );
    const cert = await readFile(join(dir, "cert"));
    const key = await readFile(join(dir, "key"));
    const spki = createHash("sha256")
      .update(
        new X509Certificate(cert).publicKey.export({
          type: "spki",
          format: "der",
        }),
      )
      .digest("base64");
    await build({ logLevel: "silent", build: { outDir: join(dir, "build") } });
    const bundle = await readFile(join(dir, "build/lightnvr-camera-card.js"));
    let helper;
    function forwardHeaders(req) {
      return {
        ...req.headers,
        "x-forwarded-host": req.headers.host,
        "x-forwarded-proto": "https",
      };
    }
    edge = https.createServer({ key, cert }, (req, res) => {
      const host = req.headers.host.split(":")[0];
      if (
        [
          "ha.example.test",
          "evil.example.test",
          "outside.example.invalid",
        ].includes(host)
      ) {
        if (req.url === "/card.js") {
          res.writeHead(200, { "Content-Type": "text/javascript" }).end(bundle);
        } else if (req.url === "/" || req.url === "/alive") {
          res
            .writeHead(200, { "Content-Type": "text/html" })
            .end(
              '<!doctype html><button id="alive">HA independent</button><script type="module" src="/card.js"></script>',
            );
        } else res.writeHead(404).end();
        return;
      }
      if (host !== "nvr.example.test") {
        res.writeHead(403).end();
        return;
      }
      const target = new URL(helper);
      const upstream = http.request(
        {
          hostname: target.hostname,
          port: target.port,
          path: req.url,
          method: req.method,
          headers: forwardHeaders(req),
        },
        (response) => {
          observations.push({
            method: req.method,
            origin: req.headers.origin,
            status: response.statusCode,
          });
          res.writeHead(response.statusCode, response.headers);
          response.pipe(res);
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    });
    edge.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    edge.on("upgrade", (req, socket, head) => {
      if (!req.headers.host.startsWith("nvr.example.test:")) {
        socket.destroy();
        return;
      }
      const target = new URL(helper);
      const upstream = http.request({
        hostname: target.hostname,
        port: target.port,
        path: req.url,
        headers: forwardHeaders(req),
      });
      upstream.on("upgrade", (response, remote, remoteHead) => {
        observations.push({
          method: "WS",
          origin: req.headers.origin,
          status: 101,
        });
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            Object.entries(response.headers)
              .map(([name, value]) => `${name}: ${value}\r\n`)
              .join("") +
            "\r\n",
        );
        if (head.length) remote.write(head);
        if (remoteHead.length) socket.write(remoteHead);
        socket.pipe(remote);
        remote.pipe(socket);
        socket.on("close", () => remote.destroy());
        remote.on("error", () => socket.destroy());
      });
      upstream.on("response", (response) => {
        observations.push({
          method: "WS",
          origin: req.headers.origin,
          status: response.statusCode,
        });
        response.resume();
        socket.end(
          `HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\n\r\n`,
        );
      });
      upstream.on("error", () => socket.destroy());
      upstream.end();
    });
    await new Promise((resolve) => edge.listen(0, "127.0.0.1", resolve));
    const port = edge.address().port;
    const haOrigin = `https://ha.example.test:${port}`;
    const nvrOrigin = `https://nvr.example.test:${port}`;
    const outsideOrigin = `https://outside.example.invalid:${port}`;
    router = createRouter({
      trustedPeers: ["127.0.0.1"],
      origins: [nvrOrigin],
      clientOrigins: [haOrigin, outsideOrigin],
      scopes: [
        {
          prefix: "/ha-card/",
          cookieName: "lnvr_card",
          upstream: fixture.origin,
          forwardAuthority: "upstream",
        },
      ],
    });
    await new Promise((resolve) =>
      router.server.listen(0, "127.0.0.1", resolve),
    );
    helper = `http://127.0.0.1:${router.server.address().port}`;
    browser = await chromium.launch({
      executablePath:
        process.env.LIGHTNVR_CHROMIUM ?? "/usr/bin/chromium-browser",
      args: [
        `--ignore-certificate-errors-spki-list=${spki}`,
        "--no-proxy-server",
        "--host-resolver-rules=MAP ha.example.test 127.0.0.1,MAP nvr.example.test 127.0.0.1,MAP evil.example.test 127.0.0.1,MAP outside.example.invalid 127.0.0.1",
      ],
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(haOrigin);
    await page.waitForFunction(() =>
      customElements.get("lightnvr-camera-card"),
    );
    const frames = {};
    let abortedVerify = false;
    for (const transport of ["mse", "hls"]) {
      if (transport === "hls")
        await page.route(
          nvrOrigin + "/ha-card/api/auth/verify",
          async (route) => {
            if (!abortedVerify) {
              abortedVerify = true;
              await route.abort("failed");
            } else await route.continue();
          },
        );
      await page.evaluate(
        ({ f, gateway, transport }) => {
          const card = document.createElement("lightnvr-camera-card");
          card.setConfig({
            type: "custom:lightnvr-camera-card",
            server: gateway,
            stream: f.source,
            source: f.source,
            ...(transport === "mse"
              ? { username: f.username, password: f.password }
              : {}),
            credential_storage: transport === "mse" ? "dashboard" : "session",
            transports: [transport],
            controls: { style: transport === "mse" ? "overlay" : "standard" },
            audio: { listen: false, muted: true, microphone: false },
          });
          document.body.append(card);
        },
        { f: fixture, gateway: nvrOrigin + "/ha-card/", transport },
      );
      try {
        await page.waitForFunction(
          () => {
            const video = document
              .querySelector("lightnvr-camera-card")
              ?.shadowRoot?.querySelector("video");
            return (
              video &&
              video.videoWidth > 0 &&
              video.currentTime > 0 &&
              video.readyState >= 2
            );
          },
          null,
          { timeout: 45000 },
        );
      } catch {
        const status = await page.evaluate(
          () =>
            document
              .querySelector("lightnvr-camera-card")
              ?.shadowRoot?.querySelector(".status")?.textContent,
        );
        throw Error(
          "Cross-origin " +
            transport +
            " did not decode generated media: " +
            status +
            " " +
            JSON.stringify(
              observations.map(({ method, status }) => ({ method, status })),
            ),
        );
      }
      frames[transport] = await page.evaluate(
        () =>
          document
            .querySelector("lightnvr-camera-card")
            .shadowRoot.querySelector("video").videoWidth,
      );
      if (transport === "hls") {
        const diagnostics = await page
          .locator("lightnvr-camera-card .diagnostics pre")
          .textContent();
        const parsed = JSON.parse(diagnostics);
        assert(
          parsed.recentFailures.some(
            (item) =>
              item.failure.operation === "auth.verify" &&
              item.failure.phase === "api-request" &&
              item.failure.browserError === "TypeError",
          ),
        );
        assert(
          !diagnostics.includes(fixture.password) &&
            !diagnostics.includes("nvr.example.test"),
        );
        await page.unroute(nvrOrigin + "/ha-card/api/auth/verify");
      }
      if (transport === "mse") {
        await page
          .getByRole("button", { name: "Camera settings", exact: true })
          .click();
        await page.waitForFunction(
          () =>
            !document
              .querySelector("lightnvr-camera-card")
              .shadowRoot.querySelector(".advanced").hidden,
        );
        await page
          .getByRole("button", { name: "Camera settings", exact: true })
          .click();
        for (const width of [860, 320]) {
          await page.setViewportSize({ width: width + 32, height: 800 });
          await page.evaluate((width) => {
            document.body.style.cssText =
              "margin:16px;background:#131416;color:#eee;--primary-text-color:#eee;--secondary-text-color:#aaa;--ha-card-background:#202124;font-family:system-ui";
            document.querySelector("lightnvr-camera-card").style.width =
              `${width}px`;
          }, width);
          assert.equal(
            await page.evaluate(() => {
              const root = document.querySelector(
                "lightnvr-camera-card",
              ).shadowRoot;
              const bar = root
                .querySelector(".overlay-toolbar")
                .getBoundingClientRect();
              return [
                ...root.querySelectorAll(".overlay-toolbar button"),
              ].every((b) => {
                const r = b.getBoundingClientRect();
                return (
                  r.width >= 44 &&
                  r.height >= 44 &&
                  r.left >= bar.left &&
                  r.right <= bar.right
                );
              });
            }),
            true,
            "overlay buttons must retain touch targets and fit their card",
          );
          if (process.env.LIGHTNVR_UI_PREVIEW_DIR) {
            await mkdir(process.env.LIGHTNVR_UI_PREVIEW_DIR, {
              recursive: true,
            });
            await page.locator("lightnvr-camera-card").screenshot({
              path: join(
                process.env.LIGHTNVR_UI_PREVIEW_DIR,
                `overlay-${width}.png`,
              ),
            });
          }
        }
      }
      await page.evaluate(() =>
        document.querySelector("lightnvr-camera-card").remove(),
      );
      await page.waitForTimeout(100);
    }
    await page.evaluate(
      async ({ f, gateway }) => {
        const editor = await customElements
          .get("lightnvr-camera-card")
          .getConfigElement();
        editor.setConfig({
          type: "custom:lightnvr-camera-card",
          server: gateway,
          stream: f.source,
          username: f.username,
          password: f.password,
          credential_storage: "dashboard",
        });
        editor.addEventListener("config-changed", (event) => {
          window.sessionSavedConfig = event.detail.config;
          editor.setConfig(event.detail.config);
        });
        document.body.append(editor);
      },
      { f: fixture, gateway: nvrOrigin + "/ha-card/" },
    );
    await page
      .locator("lightnvr-camera-card-editor label")
      .filter({ hasText: "Credential storage" })
      .locator("select")
      .selectOption("session");
    await page
      .getByRole("button", { name: "2. Test connection", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector("lightnvr-camera-card-editor").model.tested ===
        true,
      null,
      { timeout: 30000 },
    );
    assert.equal(
      await page.evaluate(
        () =>
          window.sessionSavedConfig.credential_storage === "session" &&
          !("username" in window.sessionSavedConfig) &&
          !("password" in window.sessionSavedConfig),
      ),
      true,
    );
    await page.evaluate(() =>
      document.querySelector("lightnvr-camera-card-editor").remove(),
    );
    const loginPosts = observations.filter((o) => o.method === "POST").length;
    await page.reload();
    await page.waitForFunction(() =>
      customElements.get("lightnvr-camera-card"),
    );
    const mountSession = async () =>
      page.evaluate(
        ({ gateway, source }) => {
          const card = document.createElement("lightnvr-camera-card");
          card.setConfig({
            type: "custom:lightnvr-camera-card",
            server: gateway,
            stream: source,
            source,
            credential_storage: "session",
            transports: ["mse"],
            audio: { listen: false, muted: true, microphone: false },
          });
          document.body.append(card);
        },
        { gateway: nvrOrigin + "/ha-card/", source: fixture.source },
      );
    const waitSessionFrame = async () =>
      page.waitForFunction(
        () => {
          const v = document
            .querySelector("lightnvr-camera-card")
            ?.shadowRoot?.querySelector("video");
          return v && v.videoWidth > 0 && v.currentTime > 0;
        },
        null,
        { timeout: 45000 },
      );
    await mountSession();
    await waitSessionFrame();
    assert.equal(
      observations.filter((o) => o.method === "POST").length,
      loginPosts,
      "reload must reuse the cookie without saved credentials or a login POST",
    );
    await page.evaluate(() =>
      document.querySelector("lightnvr-camera-card").remove(),
    );
    await context.clearCookies();
    await mountSession();
    await page.getByLabel("Username", { exact: true }).fill(fixture.username);
    await page.getByLabel("Password", { exact: true }).fill(fixture.password);
    await page
      .getByRole("button", {
        name: "Authenticate for this session",
        exact: true,
      })
      .click();
    await waitSessionFrame();
    await page.evaluate(() =>
      document.querySelector("lightnvr-camera-card").remove(),
    );
    const sdp = await page.evaluate(
      async ({ gateway, source }) => {
        const pc = new RTCPeerConnection({ iceServers: [] });
        try {
          pc.addTransceiver("video", { direction: "recvonly" });
          await pc.setLocalDescription(await pc.createOffer());
          const response = await fetch(
            gateway + "go2rtc/api/webrtc?src=" + encodeURIComponent(source),
            {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/sdp" },
              body: pc.localDescription.sdp,
            },
          );
          await pc.setRemoteDescription({
            type: "answer",
            sdp: await response.text(),
          });
          return response.status;
        } finally {
          pc.close();
        }
      },
      { gateway: nvrOrigin + "/ha-card/", source: fixture.source },
    );
    assert.equal(sdp, 201);
    const wsWebrtc = await page.evaluate(
      async ({ gateway, source }) => {
        const pc = new RTCPeerConnection({ iceServers: [] });
        const ws = new WebSocket(
          gateway.replace("https:", "wss:") +
            "go2rtc/api/ws?src=" +
            encodeURIComponent(source),
        );
        try {
          return await new Promise((resolve) => {
            const finish = (value) => {
              clearTimeout(timer);
              resolve(value);
            };
            const timer = setTimeout(() => finish(false), 10000);
            pc.onicecandidate = (event) => {
              if (ws.readyState === WebSocket.OPEN)
                ws.send(
                  JSON.stringify({
                    type: "webrtc/candidate",
                    value: event.candidate?.candidate ?? "",
                  }),
                );
            };
            ws.onerror = () => finish(false);
            ws.onmessage = async (event) => {
              try {
                const message = JSON.parse(event.data);
                if (message.type === "webrtc/answer") {
                  await pc.setRemoteDescription({
                    type: "answer",
                    sdp: message.value,
                  });
                  finish(true);
                } else if (message.type === "webrtc/candidate" && message.value)
                  await pc.addIceCandidate({
                    candidate: message.value,
                    sdpMid: "0",
                  });
                else if (message.type === "error") finish(false);
              } catch {
                finish(false);
              }
            };
            ws.onopen = async () => {
              try {
                pc.addTransceiver("video", { direction: "recvonly" });
                await pc.setLocalDescription(await pc.createOffer());
                ws.send(
                  JSON.stringify({
                    type: "webrtc/offer",
                    value: pc.localDescription.sdp,
                  }),
                );
              } catch {
                finish(false);
              }
            };
          });
        } finally {
          pc.close();
          ws.close();
        }
      },
      { gateway: nvrOrigin + "/ha-card/", source: fixture.source },
    );
    assert.equal(
      wsWebrtc,
      true,
      "go2rtc WebSocket WebRTC signaling should return a valid answer",
    );
    assert.equal(
      await page.evaluate(
        async (gateway) =>
          (
            await fetch(gateway + "api/streams?summary=true&surface=live", {
              credentials: "omit",
            })
          ).status,
        nvrOrigin + "/ha-card/",
      ),
      401,
    );
    const postsBefore = observations.filter((o) => o.method === "POST").length;
    assert.equal(
      await page.evaluate(async (gateway) => {
        try {
          await fetch(gateway + "api/auth/login", {
            method: "POST",
            credentials: "include",
            headers: { "X-Forbidden": "1", "Content-Type": "application/json" },
            body: "{}",
          });
          return false;
        } catch {
          return true;
        }
      }, nvrOrigin + "/ha-card/"),
      true,
    );
    assert.equal(
      observations.filter((o) => o.method === "POST").length,
      postsBefore,
      "denied preflight must not forward a POST",
    );
    assert(
      observations.some((o) => o.method === "OPTIONS" && o.status === 204),
    );
    assert(
      observations.some(
        (o) => o.method === "WS" && o.status === 101 && o.origin === haOrigin,
      ),
    );
    for (const attacker of [
      `https://evil.example.test:${port}`,
      outsideOrigin,
    ]) {
      const hostile = await context.newPage();
      await hostile.goto(attacker);
      assert.equal(
        await hostile.evaluate(async (gateway) => {
          try {
            await fetch(gateway + "api/streams?summary=true&surface=live", {
              credentials: "include",
            });
            return false;
          } catch {
            return true;
          }
        }, nvrOrigin + "/ha-card/"),
        true,
      );
      assert(
        observations.some((o) => o.origin === attacker && o.status === 403),
      );
      assert.equal(
        await hostile.evaluate(
          async ({ gateway, source }) =>
            new Promise((resolve) => {
              const socket = new WebSocket(
                gateway.replace("https:", "wss:") +
                  "go2rtc/api/ws?src=" +
                  encodeURIComponent(source),
              );
              const timer = setTimeout(() => {
                socket.close();
                resolve(false);
              }, 5000);
              socket.onopen = () => {
                clearTimeout(timer);
                socket.close();
                resolve(true);
              };
              socket.onerror = () => {
                clearTimeout(timer);
                resolve(false);
              };
            }),
          { gateway: nvrOrigin + "/ha-card/", source: fixture.source },
        ),
        false,
      );
      assert(
        observations.some(
          (o) =>
            o.method === "WS" &&
            o.origin === attacker &&
            o.status >= 400 &&
            o.status < 500,
        ),
        "hostile WS must receive an explicit upstream/edge denial",
      );
      await hostile.close();
    }
    const cookies = await context.cookies();
    const session = cookies.find((c) => c.name === "lnvr_card");
    assert(
      session &&
        session.domain === "nvr.example.test" &&
        session.path === "/ha-card/" &&
        session.secure &&
        session.httpOnly,
    );
    assert.equal(
      (await context.cookies(haOrigin)).some((c) => c.name === "lnvr_card"),
      false,
    );
    await router.close();
    router = undefined;
    assert.equal(
      await page.evaluate(async (gateway) => {
        try {
          return (await fetch(gateway)).ok;
        } catch {
          return false;
        }
      }, nvrOrigin + "/ha-card/api/streams"),
      false,
    );
    assert.equal((await page.goto(haOrigin + "/alive")).status(), 200);
    console.log(
      JSON.stringify({
        crossOriginGateway: "passed",
        frames,
        sdp201: true,
        websocketWebRTCAnswer: true,
        overlayControlsAndTouchTargets: true,
        sessionSwitchAndEditorSave: true,
        sessionReloadWithoutSavedCredentials: true,
        missingSessionPromptsAndPlays: true,
        bootstrapFetchFailureRetriedAndDiagnosed: true,
        authenticatedWSS: true,
        artifactSHA256: createHash("sha256").update(bundle).digest("hex"),
        readableAuthDenial: true,
        deniedPreflightDoesNotForwardPost: true,
        hostileWebSocketsRejected: true,
        scopedNvrCookieOnly: true,
        hostileAndCrossSiteOriginsRejected: true,
        haOriginAliveWithGatewayStopped: true,
        boundary:
          "Owned HA-origin HTML fixture, actual lightNVR/card; not actual HA, Companion or physical talk acceptance",
      }),
    );
  } finally {
    if (browser) await browser.close();
    if (router) await router.close();
    for (const socket of sockets) socket.destroy();
    if (edge) await new Promise((resolve) => edge.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}
