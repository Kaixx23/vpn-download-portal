/** Parsers for the non-API GitHub release discovery, exported so they're testable. */

/** All tags in a /releases.atom body, newest first. */
export function tagsFromAtom(atomXml) {
  // Entry ids look like: tag:github.com,2008:Repository/311315731/v26.7.28
  // NB: the feed's own <id> is https://github.com/owner/repo/releases — the
  // tag: prefix is what separates a release entry from the feed header.
  const ids = [...atomXml.matchAll(/<id>tag:github\.com,\d+:Repository\/\d+\/([^<]+)<\/id>/g)].map(
    (m) => m[1],
  );
  if (!ids.length) throw new Error("no release entries in releases.atom");
  return ids;
}

/** Newest tag from a /releases.atom body. */
export function newestTag(atomXml) {
  return tagsFromAtom(atomXml)[0];
}

/** All downloadable assets on a /releases/expanded_assets/<tag> page. */
export function parseAssets(html) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/href="(\/[^"]+\/releases\/download\/[^"]+)"/g)) {
    const p = m[1];
    if (seen.has(p)) continue;
    seen.add(p);
    const rel = p.replace(/^\//, "");
    const file = decodeURIComponent(rel.split("/").pop());
    out.push({ file, rel, upstream: "https://github.com" + p });
  }
  return out;
}

/** First asset whose name matches, ignoring signature sidecars. */
export function pickAsset(assets, pattern) {
  const re = new RegExp(pattern);
  return assets.find((a) => re.test(a.file) && !/\.(sig|asc)$/.test(a.file)) || null;
}
