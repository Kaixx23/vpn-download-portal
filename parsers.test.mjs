import { test } from "node:test";
import assert from "node:assert/strict";
import { newestTag, parseAssets, pickAsset } from "../scripts/gh-release.mjs";

// Real shapes captured from github.com — these are the cases that actually
// broke during development.
const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>https://github.com/XTLS/Xray-core/releases</id>
  <link rel="alternate" href="https://github.com/XTLS/Xray-core/releases"/>
  <entry>
    <id>tag:github.com,2008:Repository/311315731/v26.7.28</id>
    <title>Xray-core v26.7.28</title>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/311315731/v26.7.11</id>
    <title>Xray-core v26.7.11</title>
  </entry>
</feed>`;

test("newestTag reads the tag entry, not the feed's own id", () => {
  // Regression: a looser regex returned "releases" from the <id> above.
  assert.equal(newestTag(ATOM), "v26.7.28");
});

test("newestTag throws on a feed with no releases", () => {
  assert.throws(() => newestTag(`<feed><id>https://github.com/a/b/releases</id></feed>`));
});

test("parseAssets extracts deduped download links", () => {
  const html = `
    <a href="/XTLS/Xray-core/releases/download/v26.7.28/Xray-linux-64.zip">Xray-linux-64.zip</a>
    <a href="/XTLS/Xray-core/releases/download/v26.7.28/Xray-linux-64.zip.dgst">dgst</a>
    <a href="/XTLS/Xray-core/releases/download/v26.7.28/Xray-linux-64.zip">duplicate</a>
    <a href="/XTLS/Xray-core/releases/tag/v26.7.28">not an asset</a>`;
  const assets = parseAssets(html);
  assert.equal(assets.length, 2);
  assert.equal(assets[0].file, "Xray-linux-64.zip");
  assert.equal(
    assets[0].upstream,
    "https://github.com/XTLS/Xray-core/releases/download/v26.7.28/Xray-linux-64.zip",
  );
  assert.equal(assets[0].rel, "XTLS/Xray-core/releases/download/v26.7.28/Xray-linux-64.zip");
});

test("parseAssets decodes percent-encoded filenames", () => {
  const html = `<a href="/a/b/releases/download/v1/My%20App%20Setup.exe">x</a>`;
  assert.equal(parseAssets(html)[0].file, "My App Setup.exe");
});

test("pickAsset matches the pattern and skips .sig sidecars", () => {
  const assets = parseAssets(`
    <a href="/a/b/releases/download/v1/app-1.0-x64.rpm.sig">sig</a>
    <a href="/a/b/releases/download/v1/app-1.0-x64.rpm">rpm</a>`);
  assert.equal(pickAsset(assets, "^app-[0-9.]+-x64\\.rpm$").file, "app-1.0-x64.rpm");
  assert.equal(pickAsset(assets, "^nope-.*"), null);
});

test("pickAsset distinguishes the hyphenated rpm from the underscored deb", () => {
  // The real Clash Verge Rev names: Clash.Verge_2.5.2_amd64.deb vs
  // Clash.Verge-2.5.2-1.x86_64.rpm. An underscore pattern must not grab the rpm.
  const assets = parseAssets(`
    <a href="/c/v/releases/download/v2.5.2/Clash.Verge_2.5.2_amd64.deb">deb</a>
    <a href="/c/v/releases/download/v2.5.2/Clash.Verge-2.5.2-1.x86_64.rpm">rpm</a>`);
  assert.equal(pickAsset(assets, "^Clash\\.Verge_[0-9.]+_amd64\\.deb$").file, "Clash.Verge_2.5.2_amd64.deb");
  assert.equal(pickAsset(assets, "^Clash\\.Verge-[0-9.]+-1\\.x86_64\\.rpm$").file, "Clash.Verge-2.5.2-1.x86_64.rpm");
});
