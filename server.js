/**
 * server.js — zero-dependency Node 18+ server.
 * Patched to support both original static/ layout and flat root layout.
 */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let STATIC_DIR = path.join(here, "static");
if (!fs.existsSync(STATIC_DIR)) {
  STATIC_DIR = here; // flat layout
}
const PORT = Number(process.env.PORT || 3000);
const MODE = process.env.MODE || "mirror";
const TRUSTED_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-production-release-asset.s3.amazonaws.com",
]);

function isTrustedHost(hostname) {
  if (TRUSTED_HOSTS.has(hostname)) return true;
  if (hostname.endsWith(".githubusercontent.com") || hostname.endsWith(".github.com")) return true;
  if (
    hostname.startsWith("github-production-release-asset") &&
    hostname.endsWith(".s3.amazonaws.com")
  ) {
    return true;
  }
  return false;
}

const SIGNED_URL_CACHE = new Map();
const SIGNED_TTL_MS = 3 * 60 * 1000;

const COMPRESSIBLE = new Set([".html", ".json", ".js", ".mjs", ".css", ".svg", ".webmanifest", ".txt"]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const ASSET_RE =
  /^\/m\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/releases\/download\/([^/]+)\/(.+)$/;

function send(res, code, body, headers = {}) {
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
}

function safeJoin(base, target) {
  const p = path.normalize(path.join(base, target));
  return p.startsWith(base) ? p : null;
}

function sendCompressedBuffer(req, res, code, buf, headers = {}) {
  const ae = String(req.headers["accept-encoding"] || "");
  if (req.method !== "HEAD" && buf.length > 512 && /\bgzip\b/i.test(ae)) {
    const gz = zlib.gzipSync(buf, { level: 6 });
    res.writeHead(code, {
      ...headers,
      "content-encoding": "gzip",
      vary: "Accept-Encoding",
      "content-length": gz.length,
    });
    return res.end(gz);
  }
  res.writeHead(code, { ...headers, "content-length": buf.length });
  if (req.method === "HEAD") return res.end();
  return res.end(buf);
}

async function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "index.html" : pathname.slice(1);
  // vendor/ -> root for flat layout (index.html imports /vendor/qrcode.mjs)
  if (rel.startsWith("vendor/")) {
    rel = rel.replace(/^vendor\//, "");
  }
  let file = safeJoin(STATIC_DIR, rel);
  if (!file) return send(res, 403, "Forbidden");
  try {
    const st = await fsp.stat(file);
    if (st.isDirectory()) return serveStatic(req, res, path.join(pathname, "index.html"));
    const ext = path.extname(file).toLowerCase();
    const headers = {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    };
    if (COMPRESSIBLE.has(ext) && st.size < 2 * 1024 * 1024) {
      const buf = await fsp.readFile(file);
      return sendCompressedBuffer(req, res, 200, buf, headers);
    }
    if (req.method === "HEAD") {
      res.writeHead(200, { ...headers, "content-length": st.size });
      return res.end();
    }
    res.writeHead(200, { ...headers, "content-length": st.size });
    fs.createReadStream(file).pipe(res);
  } catch {
    // fallback to index.html for SPA-like behavior
    if (pathname !== "/index.html" && pathname !== "/") {
      const idx = safeJoin(STATIC_DIR, "index.html");
      try {
        const buf = await fsp.readFile(idx);
        return sendCompressedBuffer(req, res, 200, buf, {
          "content-type": MIME[".html"],
          "cache-control": "no-cache",
        });
      } catch {}
    }
    return send(res, 404, "Not found");
  }
}

async function fetchUpstreamAsset(upstream, method, range) {
  const cached = SIGNED_URL_CACHE.get(upstream);
  let url = cached && Date.now() - cached.ts < SIGNED_TTL_MS ? cached.url : upstream;
  for (let i = 0; i < 6; i++) {
    const res = await fetch(url, {
      method,
      redirect: "manual",
      headers: {
        "user-agent": "vpn-mirror/1.0",
        "accept-encoding": "identity",
        ...(range ? { range } : {}),
      },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) break;
      const next = new URL(loc, url);
      if (!isTrustedHost(next.hostname)) break;
      url = next.toString();
      SIGNED_URL_CACHE.set(upstream, { url, ts: Date.now() });
      continue;
    }
    return { url, res };
  }
  return { url: null, res: null };
}

async function handleMirror(req, res, m) {
  const [, repo, tag, file] = m;
  if (!isTrustedHost("github.com") || repo.includes("..")) {
    return send(res, 403, "Forbidden");
  }
  const upstream = `https://github.com/${repo}/releases/download/${tag}/${file}`;
  const disposition = `attachment; filename="${decodeURIComponent(file).replace(/"/g, "")}"`;

  if (MODE === "redirect") {
    return send(res, 307, "Redirecting…", {
      location: upstream,
      "cache-control": "no-store",
      "x-mirror-mode": "redirect",
    });
  }

  const range = req.headers.range || null;
  const method = req.method === "HEAD" ? "HEAD" : "GET";
  let up;
  try {
    up = await fetchUpstreamAsset(upstream, method, range);
  } catch (e) {
    return send(res, 502, `Upstream unreachable: ${e.message}`);
  }
  if (!up.url || !up.res) return send(res, 502, "Could not resolve upstream release asset");

  const body = up.res;
  if (!body.ok && body.status !== 206) {
    return send(res, body.status, `Upstream returned ${body.status}`);
  }

  const headers = {
    "content-disposition": disposition,
    "content-type": "application/octet-stream",
    "cache-control": "public, max-age=604800, immutable",
    "x-mirror-mode": "mirror",
    "x-upstream-host": new URL(up.url).hostname,
    "accept-ranges": "bytes",
  };
  const len = body.headers.get("content-length");
  const cr = body.headers.get("content-range");
  if (len) headers["content-length"] = len;
  if (cr) headers["content-range"] = cr;

  if (req.method === "HEAD") {
    res.writeHead(body.status, headers);
    return res.end();
  }

  try { res.socket?.setNoDelay(true); } catch {}
  res.writeHead(body.status === 206 ? 206 : 200, headers);
  const nodeStream = Readable.fromWeb(body.body, { highWaterMark: 256 * 1024 });
  nodeStream.on("error", () => res.destroy());
  nodeStream.pipe(res);
  req.on("close", () => nodeStream.destroy());
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname).replace(/\/{2,}/g, "/");

  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");

  try {
    if (pathname === "/healthz") {
      return send(res, 200, JSON.stringify({ ok: true, mode: MODE, ts: Date.now() }), {
        "content-type": "application/json; charset=utf-8",
      });
    }
    if (pathname === "/api/manifest") {
      // try static/catalog.json then root catalog.json
      const candidates = [path.join(STATIC_DIR, "catalog.json"), path.join(here, "catalog.json")];
      for (const file of candidates) {
        try {
          const buf = await fsp.readFile(file);
          return sendCompressedBuffer(req, res, 200, buf, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=300",
          });
        } catch {}
      }
      return send(res, 404, JSON.stringify({ error: "catalog not built" }), {
        "content-type": "application/json; charset=utf-8",
      });
    }
    const m = pathname.match(ASSET_RE);
    if (m) return await handleMirror(req, res, m);
    return await serveStatic(req, res, pathname);
  } catch (e) {
    return send(res, 500, `Server error: ${e.message}`);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`portal listening on 0.0.0.0:${PORT} (MODE=${MODE}) dir=${STATIC_DIR}`);
});
