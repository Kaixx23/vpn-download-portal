# VPN Downloads / China-reachable VPN client download portal

A download portal whose whole job is: **a client in mainland China, with no VPN running, can get the installer.**

The naive version of this — "put a link to the GitHub release on a webpage" — fails twice:
GitHub release assets are throttled/blocked, and the webpage's own domain gets blocked once it
circulates. This repo fixes both.

```
static/index.html              the portal (zero external dependencies — no CDN, no Google Fonts)
static/catalog.json            generated: every client, version, file, size, sha256
static/vendor/qrcode.mjs       MIT QR encoder, bundled locally so a blocked CDN can't break QR codes
static/sw.js                   service worker: the page still opens on a flaky connection
static/manifest.webmanifest    PWA manifest: "install this page as an app"
server.js                      Node 18+, zero runtime deps. Static serving + the /m/ mirror route
scripts/catalog.config.json    what you offer — edit this
scripts/build-catalog.mjs      resolves it against live release data
scripts/gh-release.mjs         the Atom/HTML release parsers (exported so they're testable)
test/server.test.mjs           e2e: spawns the server, pulls a real file through the mirror, checks its hash
test/page-render.mjs           drives the shipped page JS against a DOM and asserts the rendered UI
test/parsers.test.mjs          unit tests for the release-name/tag parsing that broke during development
Dockerfile                     runtime-only image (no npm install — ships committed catalog)
.dockerignore                  keeps the build context to server.js + static/
Caddyfile                      multi-domain auto-TLS reverse proxy (verified with caddy validate)
render.yaml                    one-click Render deploy
.github/workflows/…            daily catalog refresh
SETUP-GUIDE.md                   the per-device setup guide you send customers
```

---

## Why this works when a link doesn't

| Problem | What this does |
|---|---|
| `github.com/.../releases/download/...` is blocked/throttled | `/m/<owner>/<repo>/releases/download/<tag>/<file>` streams the installer **through your own domain**. The client never touches GitHub. |
| The page's domain gets blocked once customers pass it around | `CFG.fallbacks` — several domains on the same app. The page probes each one's `/healthz` and shows live "OK / unreachable" + latency, so the customer can switch without asking you. |
| A CDN (jsdelivr, cdnjs, Google Fonts) is blocked → page renders broken | Nothing external. Styles inline, QR lib vendored, fonts are system CJK fonts. |
| Old client → node timeouts → support tickets | `npm run build:catalog` re-resolves `/releases/latest` for every project; the page only ever offers the newest build, with the version stamped on the card. |
| "Is the exe tampered with?" | Where the project publishes SHA256 (e.g. Clash Party), it's fetched and displayed. The e2e test downloads a real file through the mirror and asserts the hash. |

---

## Deploy

### The mode that actually matters

`MODE=mirror` (default) proxies the bytes. `MODE=redirect` 307s to GitHub.

**Redirect mode does not solve your problem** — it puts the client right back on
`github.com`. It exists so you can run this on a free tier without burning egress quota.
For the real deployment you want **`MODE=mirror` on a host with cheap egress**.

Installers are 15–250 MB. If you have 500 customers, assume ~50 GB/month of egress in the
first month and far less after that (people download once). On Render free (100 GB/mo) that
dies fast; on a €4 VPS with 1–4 TB included it's nothing.

### Recommended: your own VPS + 2–3 domains + Cloudflare

This is the only setup that survives a domain getting blocked. The repo ships a
`Dockerfile` and a `Caddyfile` for exactly this. Both are verified: the Dockerfile's
copied file set boots and serves on its own, and the Caddyfile passes
`caddy validate` and was run in front of the portal to confirm the proxy, the
`/m/` matcher, and the headers behave.

```bash
# on the VPS
git clone <your fork> && cd vpn-download-portal

# 1. Build the catalog on a machine that can reach GitHub, then commit it.
#    (The runtime image has no npm install and no build step — it ships the
#    committed static/catalog.json. Refresh it here or in CI, not in the image.)
GITHUB_TOKEN=ghp_xxx npm run build:catalog

# 2. Run the portal. Either directly:
MODE=mirror PORT=3000 node server.js
#    …or as a container (runtime is zero-dependency, no build stage needed):
docker build -t vpn-portal .
docker run -d --name vpn-portal --restart unless-stopped \
  -e MODE=mirror -p 127.0.0.1:3000:3000 vpn-portal
```

Then put **Caddy** in front for automatic TLS across all your domains — that's what
makes "one domain gets blocked, the customer clicks the next" work without you
touching a certificate:

```bash
# edit Caddyfile: replace the three example domains with yours (DNS must point
# at this server first — Caddy can't issue a cert for a name that won't resolve)
caddy validate --config Caddyfile --adapter caddyfile
caddy run      --config Caddyfile --adapter caddyfile
```

Then:
1. Buy **3 domains** from different registrars. Point all three at the VPS.
2. Put all three in the `Caddyfile` site block **and** in `CFG.fallbacks` in
   `static/index.html` — the page probes each one's `/healthz` and shows the
   customer which are up, so they can switch without asking you.
3. Give customers only **one** URL. The other two are the escape hatches listed
   at the bottom of the page.

**On caching:** `server.js` sets `Cache-Control: public, max-age=604800, immutable`
on `/m/` (the version tag is immutable), so a CDN in front — or the client's own
browser — caches each installer. Stock Caddy does **not** cache response bodies;
it streams. If you want the edge to hold the bytes so GitHub is hit once per
release, put Cloudflare in front (it honours that header), or add a caching
plugin to Caddy. Don't re-set `Cache-Control` in Caddy — it emits a duplicate
header that CDNs handle inconsistently (this bit me; the Caddyfile comments say so).

### Alternatives

- **Cloudflare Pages** for the page + **Cloudflare Worker** for `/m/`. Free, but Workers'
  China Network is a paid enterprise add-on, and CF's free China routing is mediocre.
- **Vercel**: `vercel deploy` the repo, set `MODE=redirect`. Reachable from China more often
  than not, and it's a decent second door.
- **ICP-filed domain + domestic CDN** is the only way to get genuinely *fast* downloads inside
  China. It also means real-name registration and takedown exposure — decide deliberately.
  *(This is a factual trade-off, not a recommendation; make sure the way you operate is one
  you're comfortable defending.)*

### Keep the catalog fresh

```bash
GITHUB_TOKEN=ghp_xxx npm run build:catalog   # 60/hr unauthenticated, 5000/hr with a token
```

`.github/workflows/refresh-catalog.yml` does this daily and commits the result. Without a
token you will hit the rate limit — I did, while building this.

---

## Configuration

Three things in `static/index.html`:

```js
const CFG = {
  brand: 'SP VPN Downloads',
  subUrl: 'https://sp-vpn-cn.onrender.com/all/SP%20VPN?t=YOUR_TOKEN_HERE',
  fallbacks: ['https://dl-2.example.com', 'https://dl-3.example.net'],
};
```

Per-customer links: `?sub=<url>` overrides `subUrl`, so
`https://dl.example.com/?sub=https%3A%2F%2F…%2Fall%2F%E5%AE%A2%E6%88%B7A%3Ft%3D…`
gives that customer their own link and their own QR code. URL-encode it.

To change which clients you offer, edit `scripts/catalog.config.json` and rebuild. Each entry
is a regex over the release's asset list — if a project renames its files, **the build fails
loudly** instead of silently dropping the button.

---

## What I could not verify from here

This sandbox is outside China. I verified every version, filename, size, SHA256 and App Store
ID against live upstream APIs, and I verified the mirror by pulling a real file through it —
but **I cannot test reachability from inside the GFW.** No domain choice in this README is
measured; they're all judgment calls. Test from a China-side network before you send it to
customers.
