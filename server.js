/**
 * server.js — zero-dependency Node 18+ server.
 *
 *   1. serves the portal (static/)
 *   2. /m/<owner>/<repo>/releases/download/<tag>/<file>
 *        mirrors the installer through YOUR domain, so a client in China
 *        never has to reach github.com at all.
 *
 * MODE=mirror  (default)  stream the bytes through this server. Use on a VPS
 *                         with cheap egress — this is the mode that actually
 *                         survives the GFW.
 * MODE=redirect 307 the client to GitHub. Use on Render/Vercel free tiers so
 *                         you don't burn bandwidth quota.
 */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(here, "static");
const PORT = Number(process.env.PORT || 3000);
const MODE = process.env.MODE || "mirror";
const TRUSTED_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-production-release-asset.s3.amazonaws.com",
]);

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

// Only allow paths that look like a GitHub release asset. No traversal.
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

async function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = safeJoin(STATIC_DIR, rel);
  if (!file) return send(res, 403, "Forbidden");
  try {
    const st = await fsp.stat(file);
    if (st.isDirectory()) return serveStatic(req, res, path.join(pathname, "index.html"));
    const ext = path.extname(file).toLowerCase();
    const headers = {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    };
    if (req.method === "HEAD") {
      res.writeHead(200, { ...headers, "content-length": st.size });
      return res.end();
    }
    res.writeHead(200, { ...headers, "content-length": st.size });
    fs.createReadStream(file).pipe(res);
  } catch {
    // Any unknown path falls back to the portal (client-side routing).
    return serveStatic(req, res, "/index.html");
  }
}

/** Resolve a github.com release URL, following redirects, into {url, length}. */
async function resolveUpstream(upstream, range) {
  let url = upstream;
  for (let i = 0; i < 6; i++) {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      headers: { "user-agent": "vpn-mirror/1.0", ...(range ? { range } : {}) },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) break;
      const next = new URL(loc, url);
      if (!TRUSTED_HOSTS.has(next.hostname)) break; // never follow off-list
      url = next.toString();
      continue;
    }
    return { url, status: res.status, length: res.headers.get("content-length"), range: res.headers.get("content-range") };
  }
  return { url: null, status: 502 };
}

async function handleMirror(req, res, m) {
  const [, repo, tag, file] = m;
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
  let up;
  try {
    up = await resolveUpstream(upstream, range);
  } catch (e) {
    return send(res, 502, `Upstream unreachable: ${e.message}`);
  }
  if (!up.url) return send(res, 502, "Could not resolve upstream release asset");

  const headers = {
    "content-disposition": disposition,
    "content-type": "application/octet-stream",
    // Versioned tags are immutable → safe to cache aggressively at any CDN.
    "cache-control": "public, max-age=604800, immutable",
    "x-mirror-mode": "mirror",
    "x-upstream-host": new URL(up.url).hostname,
  };
  if (up.length) headers["content-length"] = up.length;
  if (up.range) headers["content-range"] = up.range;
  if (req.headers["if-none-match"]) headers["accept-ranges"] = "bytes";
  else headers["accept-ranges"] = "bytes";

  if (req.method === "HEAD") {
    res.writeHead(up.status, headers);
    return res.end();
  }

  const body = await fetch(up.url, {
    redirect: "manual",
    headers: { "user-agent": "vpn-mirror/1.0", ...(range ? { range } : {}) },
  });
  if (!body.ok) return send(res, body.status, `Upstream returned ${body.status}`);

  res.writeHead(body.status === 206 ? 206 : 200, {
    ...headers,
    "content-length": body.headers.get("content-length") || headers["content-length"],
  });
  const nodeStream = Readable.fromWeb(body.body);
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
      const file = path.join(STATIC_DIR, "catalog.json");
      try {
        const buf = await fsp.readFile(file);
        return send(res, 200, buf, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=300",
        });
      } catch {
        return send(res, 404, JSON.stringify({ error: "catalog not built" }), {
          "content-type": "application/json; charset=utf-8",
        });
      }
    }
    const m = pathname.match(ASSET_RE);
    if (m) return await handleMirror(req, res, m);
    return await serveStatic(req, res, pathname);
  } catch (e) {
    return send(res, 500, `Server error: ${e.message}`);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`portal listening on 0.0.0.0:${PORT} (MODE=${MODE})`);
});
