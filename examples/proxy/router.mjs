// Independently written routing helper. No media server or stored credentials.
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { pipeline } from "node:stream";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const MAX_PLAYLIST = 1024 * 1024;
const MAX_REQUEST = 2 * 1024 * 1024;
const hop = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];
function clean(headers) {
  const result = { ...headers };
  for (const name of String(headers.connection ?? "").split(","))
    delete result[name.trim().toLowerCase()];
  for (const name of hop) delete result[name];
  return result;
}
function fail(res, status) {
  if (res.writableEnded || res.destroyed) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain",
    Connection: "close",
  });
  res.end(`Routing request rejected (${status})`);
}
// Reject ambiguous path parsing before WHATWG URL normalization; query bytes are untouched.
function hasControl(value, includeSpace = false) {
  return [...value].some(
    (char) =>
      char.charCodeAt(0) <= (includeSpace ? 32 : 31) ||
      char.charCodeAt(0) === 127,
  );
}
export function safePath(path) {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    hasControl(path, true) ||
    path.includes("\\") ||
    path.includes("#")
  )
    return false;
  try {
    const decoded = decodeURIComponent(path);
    return (
      !hasControl(decoded) &&
      !decoded.includes("\\") &&
      !decoded.includes("%") &&
      !/%2f/i.test(path) &&
      !decoded.split("/").some((part) => part === "." || part === "..") &&
      !decoded.includes("//")
    );
  } catch {
    return false;
  }
}
function allowed(path) {
  return (
    path.startsWith("/api/") ||
    path.startsWith("/hls/") ||
    /^\/go2rtc\/api\/(?:ws|webrtc|stream\.m3u8|frame\.jpeg)$/.test(path) ||
    path.startsWith("/go2rtc/api/hls/")
  );
}
export function rewriteUri(value, requestPath, scope, media = false) {
  // Relative ../ children are legitimate when their resolved target remains in HLS.
  if (hasControl(value, true) || value.includes("\\") || value.startsWith("//"))
    throw Error("Unsafe URI");
  const target = new URL(scope.upstream);
  const url = new URL(value, new URL(requestPath, target));
  if (
    url.origin !== target.origin ||
    url.username ||
    url.password ||
    url.hash ||
    !safePath(url.pathname)
  )
    throw Error("Unsafe URI");
  if (
    media &&
    !url.pathname.startsWith("/go2rtc/api/hls/") &&
    !url.pathname.startsWith("/hls/")
  )
    throw Error("Unsafe media route");
  return scope.prefix + url.pathname.slice(1) + url.search;
}
export function rewritePlaylist(body, path, scope) {
  if (!body.startsWith("#EXTM3U")) throw Error("Invalid playlist");
  return body
    .split("\n")
    .map((line) => {
      if (!line.startsWith("#"))
        return line.trim() ? rewriteUri(line.trim(), path, scope, true) : line;
      // Fail closed on malformed/unquoted URI attributes that tolerant players might follow.
      const withoutUris = line.replace(/\b[A-Z-]*URI="[^"]*"/g, "");
      if (/\b[A-Z-]*URI\s*=/i.test(withoutUris))
        throw Error("Malformed URI attribute");
      return line.replace(
        /\bURI="([^"]*)"/g,
        (_, uri) => `URI="${rewriteUri(uri, path, scope, true)}"`,
      );
    })
    .join("\n");
}
function responseHeaders(response, scope, path) {
  const headers = clean(response.headers);
  delete headers["set-cookie"];
  const cookies = (response.headers["set-cookie"] ?? []).filter((cookie) =>
    cookie.startsWith("session="),
  );
  if (cookies.length > 1) throw Error("Ambiguous upstream cookie");
  if (cookies.length) {
    // Preserve expiry/deletion; enforce the security floor and exact scope even if upstream omits it.
    const parts = cookies[0].split(";").map((v) => v.trim());
    const attributes = parts
      .slice(1)
      .filter(
        (p) => !/^(?:domain|path|secure|httponly|samesite)(?:=|$)/i.test(p),
      );
    const sameSite = parts.some((p) => /^samesite=strict$/i.test(p))
      ? "Strict"
      : "Lax";
    headers["set-cookie"] = [
      `${scope.cookieName}=${parts[0].slice("session=".length)}; ${attributes.join("; ")}; Path=${scope.prefix}; Secure; HttpOnly; SameSite=${sameSite}`,
    ];
  }
  if (headers.location)
    headers.location = rewriteUri(headers.location, path, scope);
  // Never let an upstream response create browser-level bypasses or shared caches.
  for (const name of [
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "refresh",
    "alt-svc",
    "content-location",
    "link",
    "clear-site-data",
  ])
    delete headers[name];
  for (const name of Object.keys(headers))
    if (
      name.startsWith("access-control-") ||
      name === "x-lightnvr-card-gateway"
    )
      delete headers[name];
  headers["cache-control"] = "no-store";
  return headers;
}
export function createRouter(config) {
  if (
    !config.trustedPeers?.length ||
    !config.origins?.length ||
    !config.scopes?.length
  )
    throw Error("Explicit trust configuration required");
  const origins = config.origins.map((value) => {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.origin !== value ||
      url.username ||
      url.password
    )
      throw Error("HTTPS origins only");
    return url;
  });
  // Optional cross-origin access is for same-site HTTPS dashboard clients.
  // It is deliberately separate from the public Host allowlist above.
  const clientOrigins = (config.clientOrigins ?? []).map((value) => {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.origin !== value ||
      url.username ||
      url.password
    )
      throw Error("Exact HTTPS client origins only");
    return url.origin;
  });
  for (const scope of config.scopes) {
    const url = new URL(scope.upstream);
    if (
      !/^\/[a-zA-Z0-9_/-]+\/$/.test(scope.prefix) ||
      !safePath(scope.prefix) ||
      !/^lnvr_[a-zA-Z0-9_]+$/.test(scope.cookieName) ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      ![undefined, "public", "upstream"].includes(scope.forwardAuthority)
    )
      throw Error("Invalid scope");
  }
  for (let i = 0; i < config.scopes.length; i++)
    for (let j = i + 1; j < config.scopes.length; j++) {
      const a = config.scopes[i],
        b = config.scopes[j];
      if (
        a.prefix.startsWith(b.prefix) ||
        b.prefix.startsWith(a.prefix) ||
        a.cookieName === b.cookieName
      )
        throw Error("Overlapping scopes");
    }
  function authorize(req, upgrade) {
    const peer = req.socket.remoteAddress?.replace(/^::ffff:/, "");
    if (!config.trustedPeers.includes(peer)) throw 403;
    for (const name of [
      "host",
      "origin",
      "cookie",
      "x-forwarded-proto",
      "x-forwarded-host",
    ]) {
      if (
        req.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === name)
          .length > 1
      )
        throw 400;
    }
    const publicUrl = origins.find((url) => url.host === req.headers.host);
    if (
      !publicUrl ||
      !(upgrade ? ["https", "wss"] : ["https"]).includes(
        req.headers["x-forwarded-proto"],
      ) ||
      req.headers["x-forwarded-host"] !== publicUrl.host
    )
      throw 403;
    if (
      (req.headers.origin &&
        req.headers.origin !== publicUrl.origin &&
        !clientOrigins.includes(req.headers.origin)) ||
      (upgrade && !req.headers.origin) ||
      req.headers["sec-fetch-site"] === "cross-site"
    )
      throw 403;
    const rawPath = req.url.split("?")[0];
    if (!safePath(rawPath)) throw 400;
    const scope = config.scopes.find((s) => rawPath.startsWith(s.prefix));
    if (!scope) throw 404;
    const path = "/" + req.url.slice(scope.prefix.length);
    const upstreamPath = path.split("?")[0];
    if (
      !allowed(upstreamPath) ||
      (upgrade && upstreamPath !== "/go2rtc/api/ws")
    )
      throw 404;
    const selected = String(req.headers.cookie ?? "")
      .split(";")
      .map((v) => v.trim())
      .filter((v) => v.split("=")[0] === scope.cookieName);
    if (selected.length > 1) throw 400;
    const headers = clean(req.headers);
    for (const name of Object.keys(headers))
      if (
        name.startsWith("x-forwarded-") ||
        name === "forwarded" ||
        name.startsWith("x-auth-") ||
        name.startsWith("remote-")
      )
        delete headers[name];
    delete headers.cookie;
    if (selected.length)
      headers.cookie =
        "session=" + selected[0].slice(scope.cookieName.length + 1);
    // Only translate authority AFTER validating the edge peer, public Host/Origin,
    // scope and path. This lets a remote hostname-routed ingress receive its own
    // authority without turning arbitrary browser Origins into trusted requests.
    const authority =
      scope.forwardAuthority === "upstream"
        ? new URL(scope.upstream)
        : publicUrl;
    headers.host = authority.host;
    headers["x-forwarded-host"] = authority.host;
    headers["x-forwarded-proto"] = authority.protocol.slice(0, -1);
    if (req.headers.origin) headers.origin = authority.origin;
    headers["accept-encoding"] = "identity";
    // lightNVR remains the authentication/authorization authority in both modes.
    if (upgrade) {
      headers.connection = "Upgrade";
      headers.upgrade = "websocket";
    }
    const cors =
      req.headers.origin && req.headers.origin !== publicUrl.origin
        ? {
            "access-control-allow-origin": req.headers.origin,
            "access-control-allow-credentials": "true",
            "access-control-expose-headers":
              "X-LightNVR-Card-Gateway, Content-Range, Accept-Ranges, Retry-After",
            "x-lightnvr-card-gateway": "same-site-session-v1",
            vary: "Origin",
          }
        : {};
    return { scope, path, headers, cors };
  }
  const sockets = new Set();
  const server = http.createServer(
    { maxHeaderSize: 16384, requestTimeout: 30000, headersTimeout: 15000 },
    (req, res) => {
      let route;
      try {
        route = authorize(req, false);
      } catch (code) {
        fail(res, typeof code === "number" ? code : 400);
        return;
      }
      const { scope, path, headers, cors } = route;
      if (req.method === "OPTIONS" && cors["access-control-allow-origin"]) {
        const method = req.headers["access-control-request-method"];
        const requested = String(
          req.headers["access-control-request-headers"] ?? "",
        )
          .split(",")
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean);
        if (
          !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method) ||
          requested.some((name) => !["content-type", "range"].includes(name))
        ) {
          fail(res, 403);
          return;
        }
        res.writeHead(204, {
          ...cors,
          "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE",
          "access-control-allow-headers": "Content-Type, Range",
          "cache-control": "no-store",
        });
        res.end();
        return;
      }
      for (const [name, value] of Object.entries(cors))
        res.setHeader(name, value);
      if (Number(req.headers["content-length"] ?? 0) > MAX_REQUEST) {
        fail(res, 413);
        return;
      }
      // Destination authority comes only from configuration; the raw request target is a separate option.
      const target = new URL(scope.upstream);
      const hostname = target.hostname.replace(/^\[|\]$/g, "");
      const tlsIdentity =
        target.protocol === "https:"
          ? { servername: isIP(hostname) ? "" : hostname }
          : {};
      const request = (target.protocol === "https:" ? https : http).request(
        {
          protocol: target.protocol,
          hostname,
          port: target.port,
          ...tlsIdentity,
          path,
          method: req.method,
          headers,
        },
        (response) => {
          let outgoing;
          try {
            outgoing = responseHeaders(response, scope, path);
            if (cors["access-control-allow-origin"]) {
              const vary = outgoing.vary;
              Object.assign(outgoing, cors);
              outgoing.vary = [vary, "Origin"].filter(Boolean).join(", ");
            }
          } catch {
            response.destroy();
            fail(res, 502);
            return;
          }
          const playlist =
            /(?:mpegurl|vnd\.apple\.mpegurl)/i.test(
              String(outgoing["content-type"]),
            ) ||
            (/\.m3u8(?:\?|$)/.test(path) && response.statusCode === 200);
          if (
            playlist &&
            response.statusCode >= 200 &&
            response.statusCode < 300 &&
            response.statusCode !== 200
          ) {
            response.destroy();
            fail(res, 502);
            return;
          }
          if (
            !playlist ||
            response.statusCode !== 200 ||
            req.method === "HEAD"
          ) {
            res.writeHead(response.statusCode, outgoing);
            pipeline(response, res, () => {});
            return;
          }
          if (
            response.headers["content-encoding"] &&
            response.headers["content-encoding"] !== "identity"
          ) {
            response.destroy();
            fail(res, 502);
            return;
          }
          let size = 0;
          const chunks = [];
          response.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_PLAYLIST) {
              response.destroy();
              fail(res, 502);
            } else chunks.push(chunk);
          });
          response.on("error", () => fail(res, 502));
          response.on("end", () => {
            if (res.destroyed || res.writableEnded) return;
            try {
              const body = rewritePlaylist(
                Buffer.concat(chunks).toString("utf8"),
                path,
                scope,
              );
              for (const key of [
                "content-length",
                "content-encoding",
                "etag",
                "last-modified",
                "content-md5",
                "digest",
                "accept-ranges",
              ])
                delete outgoing[key];
              outgoing["content-type"] = "application/vnd.apple.mpegurl";
              res.writeHead(response.statusCode, outgoing);
              res.end(body);
            } catch {
              fail(res, 502);
            }
          });
        },
      );
      const deadline = setTimeout(() => {
        request.destroy();
        fail(res, 504);
      }, 30000);
      res.on("finish", () => clearTimeout(deadline));
      res.on("close", () => clearTimeout(deadline));
      request.setTimeout(30000, () => request.destroy());
      request.on("error", () => fail(res, 502));
      let bytes = 0;
      req.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_REQUEST) {
          fail(res, 413);
          request.destroy();
        }
      });
      req.on("aborted", () => request.destroy());
      res.on("close", () => request.destroy());
      pipeline(req, request, () => {});
    },
  );
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, socket, head) => {
    let route;
    try {
      route = authorize(req, true);
    } catch (code) {
      socket.end(
        `HTTP/1.1 ${typeof code === "number" ? code : 400} Rejected\r\nConnection: close\r\n\r\n`,
      );
      return;
    }
    const { scope, path, headers } = route;
    // Never resolve a client path as a URL: even authority-like paths cannot replace this destination.
    const target = new URL(scope.upstream);
    const hostname = target.hostname.replace(/^\[|\]$/g, "");
    const tlsIdentity =
      target.protocol === "https:"
        ? { servername: isIP(hostname) ? "" : hostname }
        : {};
    const remote = (target.protocol === "https:" ? https : http).request({
      protocol: target.protocol,
      hostname,
      port: target.port,
      ...tlsIdentity,
      path,
      headers,
    });
    const timeout = setTimeout(() => remote.destroy(), 30000);
    const finish = () => clearTimeout(timeout);
    socket.on("error", () => remote.destroy());
    socket.on("close", () => remote.destroy());
    remote.on("upgrade", (response, peer, remoteHead) => {
      finish();
      let outgoing;
      try {
        outgoing = responseHeaders(response, scope, path);
      } catch {
        peer.destroy();
        socket.destroy();
        return;
      }
      outgoing.connection = "Upgrade";
      outgoing.upgrade = "websocket";
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          Object.entries(outgoing)
            .flatMap(([k, v]) =>
              (Array.isArray(v) ? v : [v]).map((value) => `${k}: ${value}\r\n`),
            )
            .join("") +
          "\r\n",
      );
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) peer.write(head);
      socket.pipe(peer).pipe(socket);
      peer.on("error", () => socket.destroy());
      socket.on("close", () => peer.destroy());
      peer.on("close", () => socket.destroy());
    });
    remote.on("response", (response) => {
      finish();
      socket.end(
        `HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\n\r\n`,
      );
      response.resume();
    });
    remote.on("error", () => {
      finish();
      socket.destroy();
    });
    remote.end();
  });
  return {
    server,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const config = JSON.parse(
    await readFile(
      process.env.LIGHTNVR_ROUTER_CONFIG ?? "/config/router.json",
      "utf8",
    ),
  );
  const { server, close } = createRouter(config);
  server.listen(config.port ?? 8080, config.bind ?? "0.0.0.0");
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      void close();
    });
}
