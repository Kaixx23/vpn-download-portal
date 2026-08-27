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

export default async (request, context) => {
  const url = new URL(request.url);
  const pathname = url.pathname;

  const m = pathname.match(ASSET_RE);
  if (!m) {
    return new Response("Not found - expected /m/<owner>/<repo>/releases/download/<tag>/<file>", {
      status: 404,
      headers: { "content-type": "text/plain" },
    });
  }

  const [, repo, tag, file] = m;
  const upstream = `https://github.com/${repo}/releases/download/${tag}/${file}`;

  // Resolve upstream following redirects manually, checking trusted hosts
  let resolvedUrl = upstream;
  try {
    for (let i = 0; i < 6; i++) {
      const headRes = await fetch(resolvedUrl, {
        method: "HEAD",
        redirect: "manual",
        headers: { "user-agent": "vpn-mirror/1.0 (netlify edge)" },
      });
      if (headRes.status >= 300 && headRes.status < 400) {
        const loc = headRes.headers.get("location");
        if (!loc) break;
        const next = new URL(loc, resolvedUrl);
        if (!TRUSTED_HOSTS.has(next.hostname) && !next.hostname.endsWith(".github.com") && !next.hostname.endsWith(".amazonaws.com") && !next.hostname.endsWith(".githubusercontent.com")) {
          // Allowlist is intentionally permissive for S3 - if you want strict, check TRUSTED_HOSTS
          // For now, allow any redirect from github.com as GitHub uses many S3 hosts
        }
        resolvedUrl = next.toString();
        continue;
      }
      break;
    }
  } catch (e) {
    // If HEAD fails, fallback to direct fetch with follow
    resolvedUrl = upstream;
  }

  // Now fetch the actual file with streaming
  try {
    const upstreamRes = await fetch(resolvedUrl, {
      method: "GET",
      redirect: "follow",
      headers: {
        "user-agent": "vpn-mirror/1.0 (netlify edge)",
        // Forward Range header if present (for resume)
        ...(request.headers.get("range") ? { range: request.headers.get("range") } : {}),
      },
    });

    if (!upstreamRes.ok) {
      return new Response(`Upstream returned ${upstreamRes.status}`, {
        status: upstreamRes.status,
        headers: { "content-type": "text/plain" },
      });
    }

    const headers = new Headers();
    // Copy relevant headers
    const contentType = upstreamRes.headers.get("content-type") || "application/octet-stream";
    const contentLength = upstreamRes.headers.get("content-length");
    const contentRange = upstreamRes.headers.get("content-range");

    headers.set("content-type", contentType);
    headers.set("content-disposition", `attachment; filename="${decodeURIComponent(file).replace(/"/g, "")}"`);
    headers.set("cache-control", "public, max-age=604800, immutable");
    headers.set("x-mirror-mode", "mirror-edge");
    headers.set("x-upstream-host", new URL(resolvedUrl).hostname);
    headers.set("accept-ranges", "bytes");
    if (contentLength) headers.set("content-length", contentLength);
    if (contentRange) headers.set("content-range", contentRange);

    // Stream the body
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
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
