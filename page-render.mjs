// Executes the portal's REAL page module against a DOM + the real catalog, so
// the render path (tabs, app cards, mirror download URLs, device guides)
// actually runs instead of merely parsing. This is the only test that drives
// the UI logic that ships inside index.html.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.existsSync(path.join(here, "index.html")) ? here : path.join(here, "..");
const staticDir = fs.existsSync(path.join(root, "static", "index.html"))
  ? path.join(root, "static")
  : root;
const qrPath = fs.existsSync(path.join(staticDir, "vendor", "qrcode.mjs"))
  ? path.join(staticDir, "vendor", "qrcode.mjs")
  : path.join(staticDir, "qrcode.mjs");

// Run the shipped page module against a fresh DOM with the given query string.
// Returns the DOM + helpers so each test can assert on what actually rendered.
async function bootPage({ userAgent, catalog }) {
  const html = fs.readFileSync(path.join(staticDir, "index.html"), "utf8");
  const { window, document } = parseHTML(html);
  const pageJs = html
    .match(/<script type="module">([\s\S]*?)<\/script>/)[1]
    .replace(
      "import('/vendor/qrcode.mjs')",
      `import('${pathToFileURL(qrPath).href}')`,
    )
    .replace(
      "from '/vendor/qrcode.mjs'",
      `from '${pathToFileURL(qrPath).href}'`,
    );
  const tmpModule = path.join(root, `.page-test-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(tmpModule, pageJs);

  globalThis.window = window;
  globalThis.document = document;
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent, platform: "Win32", maxTouchPoints: 0 },
    configurable: true,
    writable: true,
  });
  globalThis.location = { search: "", origin: "https://dl.example.com", protocol: "https:", host: "dl.example.com", href: "https://dl.example.com/" };
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  globalThis.performance = { now: () => Date.now() };
  globalThis.CSS = { escape: (s) => s };
  globalThis.AbortController = class { constructor() { this.signal = {}; } abort() {} };
  globalThis.fetch = async (url) =>
    String(url).includes("/api/manifest")
      ? { ok: true, status: 200, json: async () => catalog }
      : { ok: true, status: 200, text: async () => "ok", then: (f) => f({ ok: true }) };

  await import(pathToFileURL(tmpModule).href + `?t=${Date.now()}`);
  await new Promise((r) => setTimeout(r, 250));
  return {
    window,
    document,
    q: (s) => document.querySelector(s),
    qa: (s) => [...document.querySelectorAll(s)],
    cleanup: () => fs.rmSync(tmpModule, { force: true }),
  };
}

test("portal page renders English, links to the mirror, and swaps per device", async () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(staticDir, "catalog.json"), "utf8"));
  const { window, document, q, qa, cleanup } = await bootPage({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    catalog,
  });
  try {
    const checks = [];
    const check = (name, cond, extra = "") => checks.push([name, !!cond, extra]);

    // Page lock checks: starts locked on every load, rejects wrong PIN, unlocks with 123456, re-locks on demand
    check("page starts locked on load", document.body.classList.contains("is-locked"));
    q("#lockInput").value = "wrong-pin";
    q("#lockForm").dispatchEvent(new window.Event("submit", { cancelable: true }));
    check("wrong password keeps page locked", document.body.classList.contains("is-locked"));
    check("wrong password shows error", q("#lockErr").classList.contains("on"));

    q("#lockInput").value = "200324";
    q("#lockForm").dispatchEvent(new window.Event("submit", { cancelable: true }));
    check("correct password (200324) unlocks page", !document.body.classList.contains("is-locked"));

    q("#btnLockPage").dispatchEvent(new window.Event("click"));
    check("Lock Page button locks page again", document.body.classList.contains("is-locked"));

    q("#lockInput").value = "200324";
    q("#lockForm").dispatchEvent(new window.Event("submit", { cancelable: true }));
    check("re-entering password unlocks page again", !document.body.classList.contains("is-locked"));

    check("five device tabs", qa("#tabs .tab").length === 5, `${qa("#tabs .tab").length}`);
    check("auto-detected Windows", /Windows/.test(q("#tabs .tab.on")?.textContent || ""), q("#tabs .tab.on")?.textContent);
    check("Windows app cards rendered", qa("#apps .app").length >= 2, `${qa("#apps .app").length}`);
    check("downloads point at the /m/ mirror", qa("#apps a.f").length && qa("#apps a.f").every((a) => a.getAttribute("href").startsWith("/m/")), qa("#apps a.f")[0]?.getAttribute("href"));
    check("a recommended file is flagged", qa("#apps .f.pri").length >= 1);
    check("download sources rendered", qa("#srcs .src").length === catalog.sources.length, `${qa("#srcs .src").length}`);
    check("install guide rendered", /paste|import|Profiles|System Proxy/i.test(q("#guide")?.innerHTML || ""));
    check("footer shows catalog freshness", /Catalog updated/.test(q("#meta")?.textContent || ""));
    check("no external CDN in rendered page", !/https:\/\/(cdn\.|cdnjs\.|unpkg\.|fonts\.googleapis)/.test(document.documentElement.outerHTML));

    // The page must be fully English now — no CJK characters anywhere in the
    // rendered document (the catalog used to carry Chinese labels).
    const rendered = document.documentElement.textContent || "";
    const cjk = rendered.match(/[\u4e00-\u9fff]/g);
    check("no Chinese text left in the rendered page", !cjk, cjk ? `found ${cjk.length}: ${cjk.slice(0,8).join("")}` : "");

    // Removed features must be gone: subscription box, config warning, offline export.
    check("subscription section removed", q("#subUrl") === null);
    check("config-warning box removed", q("#cfgWarn") === null);
    check("offline-export button removed", q("#btnOffline") === null);

    // Android tab must list only .apk, through the mirror
    qa("#tabs .tab").find((t) => /Android/.test(t.textContent)).dispatchEvent(new window.Event("click"));
    await new Promise((r) => setTimeout(r, 30));
    const apk = qa("#apps a.f").map((a) => a.getAttribute("href"));
    check("Android lists only .apk", apk.length && apk.every((h) => /\.apk$/.test(decodeURIComponent(h))), apk[0]);
    check("Android guide swapped in", /\.apk|unknown source|Import subscription/i.test(q("#guide")?.innerHTML || ""));

    // iOS must offer App Store links, never /m/ binaries
    qa("#tabs .tab").find((t) => /iPhone|iPad/.test(t.textContent)).dispatchEvent(new window.Event("click"));
    await new Promise((r) => setTimeout(r, 30));
    const ios = qa("#iosBox a").map((a) => a.getAttribute("href"));
    check("iOS offers App Store links", ios.length >= 5 && ios.every((h) => /apps\.apple\.com\/app\/id\d+/.test(h)), ios[0]);

    const failed = checks.filter(([, ok]) => !ok);
    for (const [name, ok, extra] of checks) console.log(`    ${ok ? "✓" : "✗"} ${name}${extra ? `  (${extra})` : ""}`);
    assert.equal(failed.length, 0, failed.map(([n, , e]) => `${n}${e ? ` [${e}]` : ""}`).join("; "));
  } finally {
    cleanup();
  }
});
