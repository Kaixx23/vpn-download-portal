# Deploy to Netlify

This portal is now ready for Netlify (static hosting + redirects).

## Quick Deploy

### Option 1: One-click button

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/Kaixx23/vpn-download-portal)

### Option 2: Manual via Git

1. Fork this repo
2. Go to https://app.netlify.com/start
3. Connect your fork
4. Settings:
   - **Build command**: *(leave empty)* or `echo 'no build'`
   - **Publish directory**: `.` (root)
   - **Functions directory**: `netlify/functions` (optional, not needed for redirect mode)
5. Deploy — you get `https://your-site.netlify.app`

### Option 3: Netlify CLI

```bash
npm install -g netlify-cli
netlify login
netlify deploy --prod --dir=.
# Publish directory = .
```

## How it works on Netlify

| Path | What happens | File |
|------|--------------|------|
| `/` | Serves `index.html` | `index.html` |
| `/catalog.json` | Static file | `catalog.json` |
| `/api/manifest` | Redirects to `/catalog.json` (200) | `netlify.toml` |
| `/vendor/qrcode.mjs` | Redirects to `/qrcode.mjs` (flat layout compat) | `netlify.toml` |
| `/healthz` | Returns `{"ok":true}` JSON via Edge Function | `netlify/edge-functions/healthz.js` |
| `/m/*` | **Redirect mode** (default): 302 to `https://github.com/:splat` | `netlify.toml` |
| `/*` | SPA fallback to `/index.html` | `netlify.toml` |

### Redirect mode vs Mirror mode

**Current default (redirect mode)** - in `netlify.toml`:

```toml
[[redirects]]
  from = "/m/*"
  to = "https://github.com/:splat"
  status = 302
```

- ✅ Works on Netlify free tier (no bandwidth cost for large files)
- ✅ No function timeout issues
- ❌ Client hits `github.com` directly (may be throttled in China)
- ✅ But users can switch to **Mirror A/B/C** in the UI (gh-proxy.com etc) which *do* proxy

**True mirror mode** - proxy through Netlify Edge:

1. In `netlify.toml`, comment out the `/m/*` redirect
2. Uncomment:

```toml
[[edge_functions]]
  path = "/m/*"
  function = "mirror"
```

3. Deploy

- ✅ Client never touches GitHub (like VPS MODE=mirror)
- ❌ Large APKs (50MB+) may hit Netlify Edge limits on free tier
- ❌ 100GB/month bandwidth limit on free tier
- For production China use, VPS + Caddy is still recommended (see README.md)

## Updating the catalog

The catalog (`catalog.json`) is prebuilt and committed. To refresh to latest versions:

```bash
# On a machine that can reach GitHub
NODE_TLS_REJECT_UNAUTHORIZED=0 node build-catalog.mjs
# Or with proper certs:
node build-catalog.mjs

# Then commit and push - Netlify auto-deploys
git add catalog.json
git commit -m "chore: refresh catalog"
git push
```

Or enable the GitHub Action in `.github/workflows/refresh-catalog.yml` (if present) to refresh daily.

## Custom domain + fallback domains

1. In Netlify Dashboard → Domain settings → Add custom domain
2. Buy 2-3 domains from different registrars, point them all to Netlify (or to same site via alias)
3. In `index.html`, edit:

```js
const CFG = {
  brand: 'SP VPN Downloads',
  fallbacks: [
    'https://dl-2.yourdomain.com',
    'https://dl-3.yourdomain.com',
  ],
};
```

The page probes each `/healthz` and shows latency / reachable status, so users can switch if one domain gets blocked.

## Environment

No env vars needed for redirect mode.

For mirror mode, no env vars either - edge function uses same allowlist as `server.js`.

## Files added for Netlify

- `netlify.toml` - redirects, headers, edge function declarations
- `netlify/edge-functions/healthz.js` - returns JSON for /healthz probing
- `netlify/edge-functions/mirror.js` - optional true mirror (commented out by default)

## Why Netlify is not ideal for China

- Netlify's China routing is mediocre (no China Network on free tier)
- `github.com` is throttled in China, so redirect mode puts clients back on GitHub
- Mirror mode via Edge Functions helps, but bandwidth is expensive
- **Best setup**: Netlify as one of your fallback domains, plus a cheap VPS with Caddy for the main mirror (MODE=mirror) with 1-4TB egress.

See `DEPLOY.md` for VPS + Caddy setup.
