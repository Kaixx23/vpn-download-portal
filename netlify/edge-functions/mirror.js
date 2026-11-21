/**
 * Netlify Edge Function for downloads.
 *
 * Rather than always sending users to one GitHub CDN/proxy route, race a small
 * byte-range read against the available origins from the Netlify edge closest
 * to the user. Redirect the browser to the first origin that actually returns
 * bytes, so the installer itself is never streamed through the Edge Function.
 */
const RANGE_BYTES = 512 * 1024;
const PROBE_TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 5;

const TRUSTED_HOSTS = new Set([
  "github.com",
  "gh-proxy.com",
  "ghproxy.net",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-production-release-asset.s3.amazonaws.com",
  "github-production-release-asset-2e65be.s3.amazonaws.com",
]);

const FULL_ASSET_RE = /^\/m\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/releases\/download\/([^/]+)\/(.+)$/;

function isTrustedHost(hostname) {
  if (TRUSTED_HOSTS.has(hostname)) return true;
  return hostname.endsWith(".github.com") || hostname.endsWith(".githubusercontent.com") ||
    (hostname.startsWith("github-production-release-asset") && hostname.endsWith(".s3.amazonaws.com"));
}

async function probeOrigin(candidate, controller) {
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const started = Date.now();
  let current = candidate.url;

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": "SP-VPN-Download-Resolver/1.0",
          "accept-encoding": "identity",
          "range": `bytes=0-${RANGE_BYTES - 1}`,
          "cache-control": "no-cache",
        },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error("Redirect missing Location");
        const next = new URL(location, current);
        if (!isTrustedHost(next.hostname)) throw new Error("Untrusted asset redirect");
        current = next.toString();
        continue;
      }

      // A real partial response confirms both that this origin is alive and
      // that it can serve resumable downloads. Don't call an HTTP error a win.
      if (response.status !== 206 || !response.body) {
        await response.body?.cancel();
        throw new Error(`Range probe returned HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      let received = 0;
      while (received < RANGE_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
      }
      await reader.cancel();
      if (received < RANGE_BYTES) throw new Error("Range probe ended early");

      // Use the final URL when redirects resolve GitHub to its signed asset CDN.
      const resolvedUrl = response.url || current;
      if (!isTrustedHost(new URL(resolvedUrl).hostname)) throw new Error("Untrusted resolved asset host");
      return { source: candidate.id, url: resolvedUrl, elapsed: Date.now() - started };
    }
    throw new Error("Too many asset redirects");
  } finally {
    clearTimeout(timeout);
  }
}

export default async (request) => {
  const url = new URL(request.url);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname).replace(/\/{2,}/g, "/");
  } catch {
    return new Response("Invalid download path", { status: 400 });
  }
  const match = pathname.match(FULL_ASSET_RE);
  if (!match || (request.method !== "GET" && request.method !== "HEAD")) {
    return new Response("Not found - expected /m/<owner>/<repo>/releases/download/<tag>/<file>", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const [, repo, tag, file] = match;
  const upstream = `https://github.com/${repo}/releases/download/${tag}/${file}`;
  const candidates = [
    { id: "github-cdn", url: upstream },
    { id: "alternate-1", url: `https://gh-proxy.com/${upstream}` },
    { id: "alternate-2", url: `https://ghproxy.net/${upstream}` },
  ];
  const controllers = [];

  // Promise.any returns the first origin to deliver the full sample. Once a
  // winner exists, stop the remaining probes so they don't waste bandwidth.
  const probes = candidates.map((candidate) => {
    const controller = new AbortController();
    controllers.push(controller);
    return probeOrigin(candidate, controller);
  });

  try {
    const winner = await Promise.any(probes);
    for (const controller of controllers) controller.abort();
    return new Response(null, {
      status: 302,
      headers: {
        "location": winner.url,
        "cache-control": "no-store",
        "x-mirror-mode": "adaptive-edge-redirect",
        "x-download-source": winner.source,
        "x-probe-ms": String(winner.elapsed),
      },
    });
  } catch {
    return new Response("All tested download origins are unavailable. Please try another download line or retry shortly.", {
      status: 503,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "retry-after": "5",
        "x-mirror-mode": "all-origins-failed",
      },
    });
  }
};

export const config = {
  path: "/m/*",
};
