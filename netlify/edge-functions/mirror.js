/**
 * Netlify Edge Function for true mirror mode (MODE=mirror equivalent)
 * 
 * This proxies /m/<owner>/<repo>/releases/download/<tag>/<file> through Netlify's
 * edge, so clients never hit github.com directly.
 * 
 * HOW TO ENABLE:
 * 1. In netlify.toml, comment out the [[redirects]] from "/m/*" to "https://github.com/:splat"
 * 2. Uncomment the [[edge_functions]] path = "/m/*" function = "mirror"
 * 3. Deploy
 * 
 * NOTES:
 * - Edge Functions support streaming, so large APKs (50MB+) should work,
 *   but Netlify free tier has 100GB bandwidth limit.
 * - For production China deployment, a VPS with Caddy + cheap egress is still
 *   more reliable than Netlify.
 * - This follows redirects only to trusted GitHub hosts (same allowlist as server.js).
 */

const TRUSTED_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-production-release-asset.s3.amazonaws.com",
  "github-production-release-asset-2e65be.s3.amazonaws.com",
  "github-production-release-asset-2e65be.s3.amazonaws.com",
]);

const ASSET_RE = /^\/m\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/releases\/download\/([^/]+)\/(.+)$/;
const SIGNED_URL_CACHE = new Map();
const SIGNED_TTL_MS = 3 * 60 * 1000;

function isTrustedHost(hostname) {
  if (TRUSTED_HOSTS.has(hostname)) return true;
  if (hostname.endsWith(".github.com") || hostname.endsWith(".githubusercontent.com")) return true;
  if (hostname.startsWith("github-production-release-asset") && hostname.endsWith(".s3.amazonaws.com")) return true;
  return false;
}

export default async (request) => {
  const url = new URL(request.url);
  const pathname = decodeURIComponent(url.pathname).replace(/\/{2,}/g, "/");

  const m = pathname.match(ASSET_RE);
  if (!m) {
    return new Response("Not found - expected /m/<owner>/<repo>/releases/download/<tag>/<file>", {
      status: 404,
      headers: { "content-type": "text/plain" },
    });
  }

  const [, repo, tag, file] = m;
  const upstream = `https://github.com/${repo}/releases/download/${tag}/${file}`;
  const range = request.headers.get("range");
  const method = request.method === "HEAD" ? "HEAD" : "GET";

  const cached = SIGNED_URL_CACHE.get(upstream);
  let targetUrl = cached && Date.now() - cached.ts < SIGNED_TTL_MS ? cached.url : upstream;

  try {
    let upstreamRes = null;
    for (let hop = 0; hop < 6; hop++) {
      upstreamRes = await fetch(targetUrl, {
        method,
        redirect: "manual",
        headers: {
          "user-agent": "vpn-mirror/1.0 (netlify edge)",
          ...(range ? { range } : {}),
        },
      });
      if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
        const loc = upstreamRes.headers.get("location");
        if (!loc) break;
        const next = new URL(loc, targetUrl);
        if (!isTrustedHost(next.hostname)) {
          return new Response("Untrusted upstream redirect host", { status: 502 });
        }
        targetUrl = next.toString();
        SIGNED_URL_CACHE.set(upstream, { url: targetUrl, ts: Date.now() });
        continue;
      }
      break;
    }

    if (!upstreamRes || (!upstreamRes.ok && upstreamRes.status !== 206)) {
      return new Response(`Upstream returned ${upstreamRes ? upstreamRes.status : 502}`, {
        status: upstreamRes ? upstreamRes.status : 502,
        headers: { "content-type": "text/plain" },
      });
    }

    const headers = new Headers();
    const contentLength = upstreamRes.headers.get("content-length");
    const contentRange = upstreamRes.headers.get("content-range");

    headers.set("content-type", "application/octet-stream");
    headers.set("content-disposition", `attachment; filename="${decodeURIComponent(file).replace(/"/g, "")}"`);
    headers.set("cache-control", "public, max-age=604800, immutable");
    headers.set("x-mirror-mode", "mirror");
    headers.set("x-upstream-host", new URL(targetUrl).hostname);
    headers.set("accept-ranges", "bytes");
    if (contentLength) headers.set("content-length", contentLength);
    if (contentRange) headers.set("content-range", contentRange);

    return new Response(method === "HEAD" ? null : upstreamRes.body, {
      status: upstreamRes.status === 206 ? 206 : 200,
      headers,
    });
  } catch (e) {
    return new Response(`Mirror error: ${e.message}`, {
      status: 502,
      headers: { "content-type": "text/plain" },
    });
  }
};

export const config = {
  path: "/m/*",
};
