#!/usr/bin/env node
/**
 * build-catalog.mjs - patched for flat layout and resilient size fetching
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tagsFromAtom, parseAssets, pickAsset } from "./gh-release.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
let root = path.join(here, "..");
let cfgPath = path.join(here, "catalog.config.json");
if (!fs.existsSync(cfgPath)) cfgPath = path.join(root, "catalog.config.json");
if (!fs.existsSync(cfgPath)) {
  root = here;
  cfgPath = path.join(here, "catalog.config.json");
}
const CACHE_DIR = path.join(root, ".cache", "build");
const TTL_MS = 60 * 60 * 1000;

const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

const UA = { "user-agent": "vpn-download-portal/1.0 (catalog builder)" };

async function cacheGet(key) {
  const f = path.join(CACHE_DIR, createHash("sha256").update(key).digest("hex").slice(0, 24));
  try {
    const st = await fsp.stat(f);
    if (Date.now() - st.mtimeMs > TTL_MS) return null;
    return await fsp.readFile(f, "utf8");
  } catch {
    return null;
  }
}
async function cachePut(key, body) {
  try {
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    await fsp.writeFile(
      path.join(CACHE_DIR, createHash("sha256").update(key).digest("hex").slice(0, 24)),
      body,
    );
  } catch {}
}

async function getText(url, { cache = true } = {}) {
  if (cache) {
    const hit = await cacheGet(url);
    if (hit !== null) return hit;
  }
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: UA, redirect: "follow" });
      if (res.ok) {
        const body = await res.text();
        if (cache) await cachePut(url, body);
        return body;
      }
      lastErr = new Error(`${url} -> HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }
  throw lastErr;
}

async function contentLength(downloadUrl) {
  const key = "len:" + downloadUrl;
  const hit = await cacheGet(key);
  if (hit !== null) return Number(hit);
  // Try HEAD
  try {
    const res = await fetch(downloadUrl, { method: "HEAD", headers: UA, redirect: "follow" });
    const len = Number(res.headers.get("content-length") || 0);
    if (len) {
      await cachePut(key, String(len));
      return len;
    }
  } catch {}
  // Try range GET
  try {
    const res = await fetch(downloadUrl, { headers: { ...UA, Range: "bytes=0-0" }, redirect: "follow" });
    const cr = res.headers.get("content-range");
    if (cr) {
      const m = cr.match(/\/([0-9]+)$/);
      if (m) {
        const len = Number(m[1]);
        if (len) {
          await cachePut(key, String(len));
          return len;
        }
      }
    }
    const len = Number(res.headers.get("content-length") || 0);
    if (len) {
      await cachePut(key, String(len));
      return len;
    }
  } catch {}
  // Reuse size from previous catalog if available
  try {
    const prevPath = path.join(here, "catalog.json");
    if (fs.existsSync(prevPath)) {
      const prev = JSON.parse(fs.readFileSync(prevPath, "utf8"));
      for (const app of prev.apps || []) {
        for (const f of app.files || []) {
          if (f.file && downloadUrl.includes(f.file) && f.size) {
            console.error(`  · using cached size for ${f.file}: ${f.size}`);
            return f.size;
          }
        }
      }
    }
  } catch {}
  console.error(`  · warning: could not get size for ${downloadUrl}, using 0`);
  return 0;
}

const out = {
  updated: new Date().toISOString(),
  resolver: "releases.atom + expanded_assets (not the rate-limited REST API)",
  sources: cfg.sources,
  ios: cfg.ios,
  apps: [],
};

let failures = 0;

for (const app of cfg.apps) {
  let tags;
  try {
    tags = tagsFromAtom(await getText(`https://github.com/${app.repo}/releases.atom`));
  } catch (e) {
    console.error(`  ✗ ${app.repo}: ${e.message}`);
    failures++;
    continue;
  }

  let chosen = null;
  for (const tag of tags.slice(0, 6)) {
    let assets;
    try {
      assets = parseAssets(
        await getText(`https://github.com/${app.repo}/releases/expanded_assets/${tag}`),
      );
    } catch (e) {
      console.error(`  · ${app.repo}@${tag}: no asset list (${e.message}) — trying older tag`);
      continue;
    }
    const matched = app.files.filter((f) => pickAsset(assets, f.match));
    if (!matched.length) {
      console.error(`  · ${app.repo}@${tag}: ships no matching binaries — trying older tag`);
      continue;
    }
    chosen = { tag, assets, matched };
    break;
  }
  if (!chosen) {
    console.error(`  ✗ ${app.repo}: none of the ${Math.min(tags.length, 6)} newest tags ship binaries`);
    failures++;
    continue;
  }
  const { tag, assets } = chosen;
  if (tag !== tags[0]) {
    console.error(`  ! ${app.repo}: newest tag ${tags[0]} has no binaries, using ${tag}`);
  }

  const checksums = new Map();
  for (const name of ["sha256sum.txt", "sha256sums.txt", "SHA256SUMS", "checksums.txt"]) {
    try {
      const txt = await getText(
        `https://github.com/${app.repo}/releases/download/${tag}/${name}`,
      );
      for (const line of txt.split("\n")) {
        const mm = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
        if (mm) checksums.set(mm[2].trim(), mm[1].toLowerCase());
      }
      if (checksums.size) break;
    } catch {}
  }

  const resolved = [];
  for (const f of app.files) {
    const hit = pickAsset(assets, f.match);
    if (!hit) {
      console.error(`  ✗ ${app.repo}@${tag}  "${f.label}"\n      nothing matched ${f.match}`);
      failures++;
      continue;
    }
    let size;
    try {
      size = await contentLength(hit.upstream);
    } catch (e) {
      console.error(`  ✗ ${app.repo}@${tag} ${hit.file}: ${e.message} — using 0`);
      size = 0;
    }
    let sha256 = checksums.get(hit.file) || null;
    if (!sha256 && /\.(pkg|7z|exe|deb|rpm|zip|AppImage)$/.test(hit.file)) {
      try {
        const t = (await getText(`${hit.upstream}.sha256`)).trim();
        const mm = t.match(/([a-f0-9]{64})/i);
        if (mm) sha256 = mm[1].toLowerCase();
      } catch {}
    }
    resolved.push({
      os: f.os,
      label: f.label,
      primary: !!f.primary,
      internal: !!f.internal,
      file: hit.file,
      size,
      sha256,
      rel: hit.rel,
      upstream: hit.upstream,
    });
  }

  out.apps.push({
    id: app.id,
    name: app.name,
    tagline: app.tagline,
    why: app.why,
    repo: app.repo,
    tag,
    latestTag: tags[0],
    os: app.os,
    files: resolved,
  });
  const withSha = resolved.filter((f) => f.sha256).length;
  console.log(
    `✓ ${app.name.padEnd(22)} ${String(tag).padEnd(11)} ${resolved.length}/${app.files.length} assets, ${withSha} sha256`,
  );
}

let dest = path.join(root, "static", "catalog.json");
if (!fs.existsSync(path.join(root, "static"))) {
  dest = path.join(root, "catalog.json");
}
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
const flatDest = path.join(here, "catalog.json");
if (dest !== flatDest) {
  try { fs.writeFileSync(flatDest, JSON.stringify(out, null, 2) + "\n"); } catch {}
}
console.log(`\nwrote ${path.relative(root, dest)}  (${(fs.statSync(dest).size / 1024).toFixed(1)} KB)`);
if (failures) {
  console.error(`\n${failures} problem(s) — see above`);
  process.exit(1);
}
