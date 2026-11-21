# Fast mainland-China downloads (Netlify portal + Alibaba OSS/CDN)

## The recommended architecture

Keep `sp-vpn-guide.netlify.app` for the portal UI. Store installer binaries in an Alibaba Cloud OSS bucket in a mainland China region, put an Alibaba Cloud CDN domain in front of that bucket, and have the portal link directly to that CDN. This removes GitHub, public GitHub proxies, and Netlify from the installer-byte path.

A mainland CDN custom domain normally requires an ICP filing. The public `netlify.app` hostname cannot be used as that CDN domain. Alibaba Cloud's console will guide you through domain filing and CDN setup; eligibility and timing depend on the account and domain. Do not expect a reliable mainland-China speedup from a Hong Kong bucket or an unfiled domain.

## One-time cloud setup

1. Register or choose a domain you control, for example `downloads.example.cn`, and complete the ICP filing needed for mainland hosting/CDN. Follow the requirements shown in Alibaba Cloud's ICP console.
2. Create an OSS bucket in a mainland China region. Use a dedicated download bucket; allow public **read** only for installer objects, do not enable public writes or bucket listing, and keep the OSS access keys private.
3. Create an Alibaba Cloud CDN accelerated domain such as `dl.example.cn`, configure the OSS bucket as its origin, attach HTTPS, and add the CDN-provided CNAME record at your DNS provider.
4. Configure byte-range requests and cache immutable release files for a long time. Configure `Access-Control-Allow-Origin: *` on the CDN if you want the portal's optional speed probe to measure the CDN from the browser. Downloads themselves do not need browser CORS.
5. Install Alibaba's `ossutil` on a machine or CI runner that can reach GitHub, then configure its credentials locally using Alibaba's official instructions. **Never commit or paste access keys into chat or source files.**

## Upload the catalog's installers

The uploader downloads each non-internal file from the `upstream` URL in `catalog.json`, checks its catalog size and published SHA-256 when present, and only then uploads it to OSS using the same key as `file.rel`.

```sh
export OSS_BUCKET_URI=oss://your-download-bucket
npm run sync:oss-assets
```

The bucket keys will look like:

```text
MetaCubeX/ClashMetaForAndroid/releases/download/v2.11.35/cmfa-2.11.35-meta-arm64-v8a-release.apk
```

The script needs `ossutil` on PATH and configured credentials, downloads files to a temporary directory, and removes them when finished. It does not put installer binaries in Git or in the Netlify site bundle.

## Point the Netlify portal at the CDN

In Netlify → Site configuration → Environment variables, set this **public URL** for the build environment:

```text
CN_DOWNLOAD_BASE_URL=https://dl.example.cn
```

Redeploy the site. The Netlify build step injects a “China Mainland CDN” download line into the catalog and makes it the default for visitors who have not saved a different line. Portal pages remain on Netlify; installer links go directly to the China CDN.

Verify from mainland China without a VPN: open one installer link, confirm its final host is `dl.example.cn`, check that the response is `200` (or `206` for a resumed/range request), and test on China Telecom, China Unicom, and China Mobile if those are your customers' networks. Keep the GitHub/proxy lines as fallbacks until the CDN is proven on customer networks.

## Updating releases

Refresh the catalog on a machine that can reach GitHub, then upload the refreshed assets and redeploy Netlify:

```sh
npm run build:catalog
export OSS_BUCKET_URI=oss://your-download-bucket
npm run sync:oss-assets
```

The CDN URL is a configuration value, not a secret. OSS credentials are secrets and should stay in `ossutil`'s local config or a protected CI secret store. OSS storage and CDN delivery are billed by the provider; check the current regional rates and set budget alerts before sharing the links broadly.

## If you cannot complete an ICP filing

Do not upload the large binaries to the Git repository or assume Netlify will become a mainland CDN. A Hong Kong storage/CDN endpoint can be used as an interim source, but mainland routes vary by carrier and time; it cannot promise normal-speed downloads without a VPN. The durable fix for users inside mainland China is a compliant mainland CDN domain and tested carrier routes.
