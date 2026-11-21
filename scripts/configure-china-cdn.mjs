#!/usr/bin/env node
/** Inject the public mainland CDN URL into the static catalog at Netlify build time. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(root, "catalog.json");
const htmlPath = path.join(root, "index.html");
const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const baseValue = (process.env.CN_DOWNLOAD_BASE_URL || "").trim();
catalog.sources = (catalog.sources || []).filter((source) => source.id !== "china-cdn");

if (baseValue) {
  const base = new URL(baseValue);
  if (base.protocol !== "https:" || base.search || base.hash) {
    throw new Error("CN_DOWNLOAD_BASE_URL must be an https URL without query or fragment");
  }
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  catalog.sources.unshift({
    id: "china-cdn",
    label: "China Mainland CDN",
    base: base.toString().replace(/\/$/, ""),
    mode: "mirror",
    default: true,
  });
  console.log(`Enabled direct China CDN downloads at ${base.origin}`);
} else {
  console.log("CN_DOWNLOAD_BASE_URL is not set; keeping the configured GitHub sources");
}

const compact = JSON.stringify(catalog).replace(/<\//g, "<\\/");
fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
const html = fs.readFileSync(htmlPath, "utf8");
const updated = html.replace(
  /<script id="inlineCatalog" type="application\/json">[\s\S]*?<\/script>/,
  `<script id="inlineCatalog" type="application/json">${compact}</script>`,
);
if (updated === html && !html.includes(`<script id="inlineCatalog" type="application/json">${compact}</script>`)) {
  throw new Error("Could not find inlineCatalog in index.html");
}
fs.writeFileSync(htmlPath, updated);
