#!/usr/bin/env node
/**
 * build-catalog.mjs
 *
 * Resolves every app in catalog.config.json to its CURRENT release and writes
 * static/catalog.json.
 *
 * It deliberately does NOT use the GitHub REST API:
 *   - /releases/latest is rate limited to 60/hr per IP, unauthenticated. On a
 *     shared IP that limit is gone before you start.
 *   - worse, it only reports the newest release *marked stable*. Several of
 *     these projects ship real fixes in releases the API doesn't surface —
 *     at the time of writing it reported Xray-core v26.3.27 while v26.7.28
 *     was already published, and v2rayNG 2.2.6 while 2.3.5 was out. Sending
 *     a client a four-month-old core is exactly the "node times out" bug this
 *     portal exists to prevent.
 *
 * So: /releases.atom for the newest tag, /releases/expanded_assets/<tag> for
 * the asset list, and a HEAD request per asset for its exact byte length.
 *
 * Run:  npm run build:catalog
 * Cron: 20 4 * * *
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tagsFromAtom, parseAssets, pickAsset } from "./gh-release.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const CACHE_DIR = path.join(root, ".cache", "build");
const TTL_MS = 60 * 60 * 1000;

const cfg = JSON.parse(fs.readFileSync(path.join(here, "catalog.config.json"), "utf8"));

const UA = { "user-agent": "vpn-download-portal/1.0 (catalog builder)" };

/* ------------------------------------------------------------------ fetch */

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
  } catch {
    /* best effort */
  }
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

/** Exact content length of a release asset, following GitHub's redirect. */
async function contentLength(downloadUrl) {
  const key = "len:" + downloadUrl;
  const hit = await cacheGet(key);
  if (hit !== null) return Number(hit);
  const res = await fetch(downloadUrl, { method: "HEAD", headers: UA, redirect: "follow" });
  const len = Number(res.headers.get("content-length") || 0);
  if (!len) throw new Error(`no content-length for ${downloadUrl} (HTTP ${res.status})`);
  await cachePut(key, String(len));
  return len;
}

/* ------------------------------------------------------------------- main */

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

  // Walk newest -> older until a tag actually ships binaries we want.
  // Projects push bare tags with no attached files (hiddify/hiddify-app
  // published v4.1.2 with only source code; the real installers are on
  // v4.1.1). Serving such a tag would leave customers with nothing to
  // download, so it must be skipped, not reported as "latest".
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
  const { tag, assets, matched } = chosen;
  if (tag !== tags[0]) {
    console.error(`  ! ${app.repo}: newest tag ${tags[0]} has no binaries, using ${tag}`);
  }

  // Optional published checksums, best effort.
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
    } catch {
      /* no such file — normal */
    }
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
      console.error(`  ✗ ${app.repo}@${tag} ${hit.file}: ${e.message}`);
      failures++;
      continue;
    }
    let sha256 = checksums.get(hit.file) || null;
    if (!sha256 && /\.(pkg|7z|exe|deb|rpm|zip|AppImage)$/.test(hit.file)) {
      try {
        const t = (await getText(`${hit.upstream}.sha256`)).trim();
        const mm = t.match(/([a-f0-9]{64})/i);
        if (mm) sha256 = mm[1].toLowerCase();
      } catch {
        /* not published */
      }
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

const dest = path.join(root, "static", "catalog.json");
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
console.log(`\nwrote ${path.relative(root, dest)}  (${(fs.statSync(dest).size / 1024).toFixed(1)} KB)`);
if (failures) {
  console.error(`\n${failures} problem(s) — see above`);
  process.exit(1);
}
