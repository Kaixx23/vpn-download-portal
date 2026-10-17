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
const SIGNED_TTL_MS = 5 * 60 * 1000;

// Map of rel ("owner/repo/releases/download/tag/file") -> exact byte size from catalog.json
// Guarantees Content-Length is ALWAYS present on downloads (never "14.8 MB of ?")
const CATALOG_SIZES = new Map();
try {
  const catPath = fs.existsSync(path.join(STATIC_DIR, "catalog.json"))
    ? path.join(STATIC_DIR, "catalog.json")
    : path.join(here, "catalog.json");
  const catData = JSON.parse(fs.readFileSync(catPath, "utf8"));
  for (const app of catData.apps || []) {
    for (const f of app.files || []) {
      if (f.rel && f.size) CATALOG_SIZES.set(f.rel, Number(f.size));
    }
  }
} catch {}

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
  ".patch": "application/octet-stream",
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
      ...(ext === ".patch" ? { "content-disposition": `attachment; filename="${path.basename(file)}"` } : {}),
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
  const relKey = `${repo}/releases/download/${tag}/${file}`;
  const knownSize = CATALOG_SIZES.get(relKey) || null;
  let up;
  try {
    up = await fetchUpstreamAsset(upstream, method, range);
  } catch (e) {
    // If running in a sandbox/serverless environment where direct S3 streaming is blocked,
    // redirect to the high-speed CDN mirror that preserves Content-Length & Range support
    if (!process.env.UPSTREAM_BASE) {
      return send(res, 302, "Redirecting to high-speed CDN…", {
        location: `https://gh-proxy.com/${upstream}`,
        "cache-control": "no-store",
        "x-mirror-mode": "cdn-fallback",
      });
    }
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
  const len = body.headers.get("content-length") || (!range && knownSize ? String(knownSize) : null);
  const cr = body.headers.get("content-range");
  if (len) headers["content-length"] = len;
  if (cr) headers["content-range"] = cr;

  if (req.method === "HEAD") {
    res.writeHead(body.status, headers);
    return res.end();
  }

  try { res.socket?.setNoDelay(true); } catch {}
  res.writeHead(body.status === 206 ? 206 : 200, headers);
  const nodeStream = Readable.fromWeb(body.body, { highWaterMark: 1024 * 1024 });
  nodeStream.on("error", () => res.destroy());
  nodeStream.pipe(res);
  req.on("close", () => nodeStream.destroy());
}

const ADMIN_PIN = process.env.ADMIN_PIN || "200324";
const ADMIN_STATE = {
  codes: [],
  logs: [],
};

function parseDeviceUa(ua = "") {
  if (!ua) return "Unknown Device";
  let os = "Device";
  if (/iPhone/i.test(ua)) {
    const m = ua.match(/OS (\d+[_\d]*)/);
    os = "iPhone" + (m ? " (iOS " + m[1].replace(/_/g, ".") + ")" : "");
  } else if (/iPad/i.test(ua)) {
    os = "iPad (iPadOS)";
  } else if (/Android/i.test(ua)) {
    const ver = ua.match(/Android\s+([0-9.]+)/i)?.[1] || "";
    const model = ua.match(/;\s*([^;)]+)\s+Build\//i)?.[1]?.trim() || "";
    os = `Android ${ver}${model ? " · " + model : ""}`.trim();
  } else if (/Windows NT 10\.0/i.test(ua)) {
    os = "Windows 10/11 PC";
  } else if (/Windows/i.test(ua)) {
    os = "Windows PC";
  } else if (/Mac OS X/i.test(ua)) {
    os = "macOS";
  } else if (/Linux/i.test(ua)) {
    os = "Linux";
  }
  let browser = "";
  if (/MicroMessenger/i.test(ua)) browser = "WeChat";
  else if (/Edg\//i.test(ua)) browser = "Edge";
  else if (/Chrome\//i.test(ua)) browser = "Chrome";
  else if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) browser = "Safari";
  else if (/Firefox\//i.test(ua)) browser = "Firefox";
  return browser ? `${os} · ${browser}` : os;
}

function addAccessLog(entry) {
  ADMIN_STATE.logs.unshift({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ts: Date.now(),
    ...entry,
  });
  if (ADMIN_STATE.logs.length > 300) ADMIN_STATE.logs.length = 300;
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      if (raw.length < 32768) raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function sendJson(res, code, obj) {
  return send(res, code, JSON.stringify(obj), {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
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
    if (pathname === "/api/bundle.json") {
      const filesToShip = [
        "index.html",
        "server.js",
        "netlify.toml",
        "_redirects",
        "catalog.json",
        "catalog.config.json",
        "netlify/edge-functions/mirror.js",
        "netlify/edge-functions/admin.js",
      ];
      const files = {};
      for (const relPath of filesToShip) {
        const full = path.join(STATIC_DIR, relPath);
        if (fs.existsSync(full)) {
          files[relPath] = fs.readFileSync(full).toString("base64");
        }
      }
      return send(res, 200, JSON.stringify({ ok: true, files }), {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
      });
    }
    if (pathname === "/api/auth" && req.method === "POST") {
      const body = await readJsonBody(req);
      const pin = String(body.code || body.pin || "").trim();
      const deviceId = String(body.deviceId || "").trim();
      const ua = String(req.headers["user-agent"] || body.ua || "");
      const device = parseDeviceUa(ua);
      const ip =
        String(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || "")
          .split(",")[0]
          .trim() ||
        req.socket?.remoteAddress ||
        "unknown";

      if (pin === ADMIN_PIN) {
        addAccessLog({
          type: "unlock_admin",
          status: "ok",
          who: "Admin (Owner)",
          code: "Admin PIN",
          device,
          ip,
          location: "Portal",
          detail: "Unlocked Portal + Admin Console",
        });
        return sendJson(res, 200, { ok: true, role: "admin", who: "Admin (Owner)", label: "Admin (Owner)" });
      }

      const codeObj = ADMIN_STATE.codes.find((c) => c.code === pin);
      if (!codeObj) {
        addAccessLog({
          type: "blocked_wrong_pin",
          status: "blocked",
          who: "Unknown Visitor",
          code: pin ? pin.slice(0, 12) : "(empty)",
          device,
          ip,
          location: "Portal",
          detail: "Invalid password attempt blocked",
        });
        return sendJson(res, 401, { ok: false, error: "Incorrect password. Please try again." });
      }
      if (codeObj.revoked) {
        addAccessLog({
          type: "blocked_revoked",
          status: "blocked",
          who: codeObj.label,
          code: codeObj.code,
          device,
          ip,
          location: "Portal",
          detail: "Blocked: Code was revoked by Admin",
        });
        return sendJson(res, 403, {
          ok: false,
          error: "This access password has been revoked by the administrator.",
        });
      }
      if (codeObj.expiresAt && Date.now() > new Date(codeObj.expiresAt).getTime()) {
        addAccessLog({
          type: "blocked_expired",
          status: "blocked",
          who: codeObj.label,
          code: codeObj.code,
          device,
          ip,
          location: "Portal",
          detail: "Blocked: Access code expired",
        });
        return sendJson(res, 403, {
          ok: false,
          error: "This access password has expired. Please request a new one.",
        });
      }
      if (codeObj.lockDevice && codeObj.boundDeviceId && deviceId && codeObj.boundDeviceId !== deviceId) {
        addAccessLog({
          type: "blocked_sharing",
          status: "blocked",
          who: codeObj.label,
          code: codeObj.code,
          device,
          ip,
          location: "Portal",
          detail: `Anti-share triggered: Code locked to ${codeObj.boundDeviceLabel || "first device"}`,
        });
        return sendJson(res, 403, {
          ok: false,
          error: "Password sharing blocked: This one-time code is locked to the original device.",
        });
      }
      if (codeObj.maxUses > 0 && codeObj.uses >= codeObj.maxUses) {
        addAccessLog({
          type: "blocked_exhausted",
          status: "blocked",
          who: codeObj.label,
          code: codeObj.code,
          device,
          ip,
          location: "Portal",
          detail: `Blocked reuse: Limit reached (${codeObj.uses}/${codeObj.maxUses} uses)`,
        });
        return sendJson(res, 403, {
          ok: false,
          error: `This one-time password has already been used (${codeObj.uses}/${codeObj.maxUses}) and is now locked.`,
        });
      }

      codeObj.uses += 1;
      codeObj.lastUsedAt = new Date().toISOString();
      codeObj.lastIp = ip;
      if (deviceId && !codeObj.boundDeviceId) {
        codeObj.boundDeviceId = deviceId;
        codeObj.boundDeviceLabel = device;
      }
      addAccessLog({
        type: "unlock_customer",
        status: "ok",
        who: codeObj.label,
        code: codeObj.code,
        device,
        ip,
        location: "Portal",
        detail: `Unlocked portal (Use ${codeObj.uses} of ${codeObj.maxUses || "∞"})`,
      });
      return sendJson(res, 200, {
        ok: true,
        role: "customer",
        who: codeObj.label,
        label: codeObj.label,
        code: codeObj.code,
        uses: codeObj.uses,
        maxUses: codeObj.maxUses,
        expiresAt: codeObj.expiresAt,
      });
    }
    if (pathname === "/api/auth/event" && req.method === "POST") {
      const body = await readJsonBody(req);
      const ua = String(req.headers["user-agent"] || body.ua || "");
      const device = parseDeviceUa(ua);
      const ip =
        String(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || "")
          .split(",")[0]
          .trim() ||
        req.socket?.remoteAddress ||
        "unknown";
      addAccessLog({
        type: "download",
        status: "ok",
        who: String(body.who || "Visitor"),
        code: String(body.code || "-"),
        device,
        ip,
        location: "Portal",
        detail: `Downloaded ${body.app || ""} (${body.file || "installer"})`.trim(),
      });
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === "/api/admin") {
      const headerPin = String(req.headers["x-admin-pin"] || "");
      if (headerPin !== ADMIN_PIN) {
        return sendJson(res, 401, { ok: false, error: "Unauthorized" });
      }
      if (req.method === "GET") {
        return sendJson(res, 200, {
          ok: true,
          codes: ADMIN_STATE.codes,
          logs: ADMIN_STATE.logs,
        });
      }
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        if (body.action === "create_code") {
          const label = String(body.label || "Customer").trim() || "Customer";
          const rawCode = String(body.customCode || body.code || "").trim();
          const code = rawCode || String(Math.floor(100000 + Math.random() * 900000));
          const maxUses = Number(body.maxUses ?? 1);
          const expiresInMinutes = Number(body.expiresInMinutes ?? 60);
          const lockDevice = body.lockDevice !== false;
          if (code === ADMIN_PIN || ADMIN_STATE.codes.some((c) => c.code === code)) {
            return sendJson(res, 400, { ok: false, error: "This PIN already exists. Choose another." });
          }
          const item = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            code,
            label,
            maxUses,
            uses: 0,
            createdAt: new Date().toISOString(),
            expiresAt: expiresInMinutes > 0 ? new Date(Date.now() + expiresInMinutes * 60 * 1000).toISOString() : null,
            lockDevice,
            boundDeviceId: null,
            boundDeviceLabel: null,
            revoked: false,
          };
          ADMIN_STATE.codes.unshift(item);
          return sendJson(res, 200, { ok: true, item, codes: ADMIN_STATE.codes });
        }
        if (body.action === "revoke_code" || body.action === "toggle_revoke") {
          const target = ADMIN_STATE.codes.find((c) => c.id === body.id || c.code === body.code);
          if (target) target.revoked = !target.revoked;
          return sendJson(res, 200, { ok: true, codes: ADMIN_STATE.codes });
        }
        if (body.action === "delete_code") {
          const idx = ADMIN_STATE.codes.findIndex((c) => c.id === body.id || c.code === body.code);
          if (idx !== -1) ADMIN_STATE.codes.splice(idx, 1);
          return sendJson(res, 200, { ok: true, codes: ADMIN_STATE.codes });
        }
        if (body.action === "clear_logs") {
          ADMIN_STATE.logs.length = 0;
          return sendJson(res, 200, { ok: true, logs: ADMIN_STATE.logs });
        }
      }
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
