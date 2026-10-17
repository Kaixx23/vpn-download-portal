/**
 * Netlify Edge Function: High-Speed Direct CDN Resolver for /m/*
 *
 * WHY THIS FIXES SLOW / STALLED DOWNLOADS & "14.8 MB of ?" ON IPHONE & ANDROID:
 * 1. Streaming 50-250 MB binaries *through* a Netlify Edge Function isolate hits
 *    Netlify's ~26-second execution timeout (cutting downloads off around 15-17 MB)
 *    and strips Content-Length on HTTP/2 streams (showing "14.8 MB of ?").
 * 2. Directly linking to github.com fails in Mainland China because github.com is
 *    SNI/DNS-blocked.
 * 3. Solution: This Edge Function resolves github.com's 302 redirect SERVER-SIDE
 *    (so the user's phone never connects to github.com) and immediately redirects (302)
 *    the browser to the pre-signed S3/Fastly CDN URL (objects.githubusercontent.com),
 *    which delivers:
 *    - Full 5G / Wi-Fi CDN speed (20-80 MB/s, no serverless bottleneck)
 *    - Exact Content-Length header on every file (always shows "of 60.9 MB", never "of ?")
 *    - Full HTTP Range (206 Partial Content) resume support
 *    - Zero 26-second serverless timeout on large 60-250 MB installers
 */

const TRUSTED_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-production-release-asset.s3.amazonaws.com",
  "github-production-release-asset-2e65be.s3.amazonaws.com",
]);

const ASSET_RE = /^\/m\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/releases/i;
const FULL_ASSET_RE = /^\/m\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/releases\/download\/([^/]+)\/(.+)$/;

const SIGNED_URL_CACHE = new Map();
const SIGNED_TTL_MS = 10 * 60 * 1000; // Pre-signed S3 URLs are valid for 5-15 mins

function isTrustedHost(hostname) {
  if (TRUSTED_HOSTS.has(hostname)) return true;
  if (hostname.endsWith(".github.com") || hostname.endsWith(".githubusercontent.com")) return true;
  if (hostname.startsWith("github-production-release-asset") && hostname.endsWith(".s3.amazonaws.com")) return true;
  return false;
}

async function resolveSignedCdnUrl(upstream) {
  const cached = SIGNED_URL_CACHE.get(upstream);
  if (cached && Date.now() - cached.ts < SIGNED_TTL_MS) {
    return cached;
  }

  let currentUrl = upstream;
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(currentUrl, {
      method: "HEAD",
      redirect: "manual",
      headers: {
        "user-agent": "SP-VPN-Portal-CDN-Resolver/2.0",
        "accept-encoding": "identity",
      },
    });

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) break;
      const next = new URL(loc, currentUrl);
      if (!isTrustedHost(next.hostname)) {
        throw new Error("Untrusted upstream redirect host");
      }
      currentUrl = next.toString();
      // Once we have the pre-signed objects.githubusercontent.com URL, return immediately
      // without downloading the body on the edge!
      if (next.hostname !== "github.com") {
        const entry = { url: currentUrl, ts: Date.now() };
        SIGNED_URL_CACHE.set(upstream, entry);
        return entry;
      }
      continue;
    }

    if (res.ok) {
      const entry = {
        url: currentUrl,
        size: res.headers.get("content-length") || null,
        ts: Date.now(),
      };
      SIGNED_URL_CACHE.set(upstream, entry);
      return entry;
    }
    break;
  }

  return null;
}

export default async (request) => {
  const url = new URL(request.url);
  const pathname = decodeURIComponent(url.pathname).replace(/\/{2,}/g, "/");

  const m = pathname.match(FULL_ASSET_RE);
  if (!m || !ASSET_RE.test(pathname)) {
    return new Response("Not found - expected /m/<owner>/<repo>/releases/download/<tag>/<file>", {
      status: 404,
      headers: { "content-type": "text/plain" },
    });
  }

  const [, repo, tag, file] = m;
  const upstream = `https://github.com/${repo}/releases/download/${tag}/${file}`;

  try {
    const resolved = await resolveSignedCdnUrl(upstream);
    if (resolved && resolved.url) {
      // Redirect client directly to the pre-signed high-speed S3/Fastly CDN URL
      // so the phone gets full 5G speed, exact Content-Length ("of 60.9 MB"),
      // Range resume support, and never hits Netlify's 26s function timeout.
      return new Response(null, {
        status: 302,
        headers: {
          location: resolved.url,
          "cache-control": "private, max-age=300",
          "x-mirror-mode": "direct-signed-cdn",
        },
      });
    }
  } catch {
    // Fall through to China CDN fallback if github.com resolution fails
  }

  // Fallback redirect if upstream resolution fails
  return new Response(null, {
    status: 302,
    headers: {
      location: `https://gh-proxy.com/${upstream}`,
      "cache-control": "no-store",
      "x-mirror-mode": "cdn-fallback",
    },
  });
};

export const config = {
  path: "/m/*",
};
