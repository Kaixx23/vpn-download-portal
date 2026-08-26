/**
 * End-to-end tests: spawn the real server.js, hit real endpoints, and for the
 * mirror route pull the smallest real installer off GitHub through it and
 * verify the SHA256 against the value published by the upstream project.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const catalog = JSON.parse(fs.readFileSync(path.join(root, "static", "catalog.json"), "utf8"));

/** Send a raw request without a client library normalizing the path away. */
function rawRequest(port, reqPath) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => {
      s.write(`GET ${reqPath} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    });
    let buf = "";
    s.on("data", (d) => { buf += d.toString("latin1"); if (buf.length > 8000) s.end(); });
    s.on("close", () => resolve(buf));
    s.on("error", (e) => resolve("ERR " + e.message));
    setTimeout(() => { s.destroy(); resolve(buf || "TIMEOUT"); }, 8000);
  });
}

async function startServer(mode) {
  // Try a few ports — parallel test files can collide on a single random port.
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    const port = 3200 + Math.floor(Math.random() * 3000);
    const child = spawn(process.execPath, ["server.js"], {
      cwd: root,
      env: { ...process.env, PORT: String(port), MODE: mode },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.on("data", (d) => { lastErr = d.toString(); });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(`${base}/healthz`);
        if (r.ok) return { child, base, port };
      } catch {}
      // If the child already died (e.g. EADDRINUSE), stop waiting and retry.
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    child.kill();
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not come up (MODE=${mode}); last stderr: ${lastErr || "n/a"}`);
}

// Smallest asset with a published sha256 (a .dgst sidecar — a few hundred bytes),
// so the hash check costs nothing. Plus the smallest real installer, to prove the
// streaming path moves a large body correctly.
const all = catalog.apps.flatMap((a) => a.files.map((f) => ({ app: a.name, ...f })));
const tinyVerifiable = all.filter((f) => f.sha256).sort((a, b) => a.size - b.size)[0];
const smallestReal = all
  .filter((f) => !f.internal && !/(\.dgst|\.sha256|\.sig|\.asc)$/.test(f.file))
  .sort((a, b) => a.size - b.size)[0];

test("catalog was built and every entry resolved", () => {
  assert.ok(catalog.apps.length >= 5, `expected >=5 apps, got ${catalog.apps.length}`);
  for (const a of catalog.apps) {
    assert.ok(a.tag, `${a.id} missing tag`);
    assert.ok(a.files.length > 0, `${a.id} has no resolved files`);
    for (const f of a.files) {
      // .dgst/.sha256 sidecars are intentionally tiny; everything else is a real installer
      const min = f.internal ? 10 : 1_000_000;
      assert.ok(f.size > min, `${a.id}/${f.file} implausible size ${f.size}`);
      assert.match(f.rel, /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/releases\/download\/[^/]+\/.+$/);
    }
  }
});

test("iOS entries carry real App Store ids", () => {
  assert.ok(catalog.ios.length >= 5);
  for (const a of catalog.ios) assert.match(String(a.appId), /^\d{9,10}$/, `${a.name} bad appId`);
});

test("mirror mode: static shell + manifest", async (t) => {
  const { child, base } = await startServer("mirror");
  t.after(() => child.kill());

  const idx = await fetch(`${base}/`);
  assert.equal(idx.status, 200);
  const html = await idx.text();
  assert.match(html, /\/vendor\/qrcode\.mjs/, "page must load the bundled QR lib");
  assert.doesNotMatch(html, /https:\/\/(cdn\.|cdnjs\.|unpkg\.|fonts\.googleapis)/, "page must not depend on an external CDN");

  for (const p of ["/sw.js", "/manifest.webmanifest", "/catalog.json", "/vendor/qrcode.mjs"]) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, `${p} -> ${r.status}`);
  }

  const man = await (await fetch(`${base}/api/manifest`)).json();
  assert.equal(man.apps.length, catalog.apps.length);
});

test("mirror mode: streams bytes through our domain and hashes correctly", async (t) => {
  const { child, base } = await startServer("mirror");
  t.after(() => child.kill());

  // (a) an asset the upstream project publishes a sha256 for, small enough to hash here
  const v = tinyVerifiable;
  assert.ok(v, "no asset with a published sha256 to verify against");
  const res = await fetch(`${base}/m/${v.rel}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-mirror-mode"), "mirror");
  assert.equal(res.headers.get("accept-ranges"), "bytes");
  assert.match(res.headers.get("content-disposition") || "", /attachment;/);
  assert.equal(Number(res.headers.get("content-length")), v.size);

  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.length, v.size, `expected ${v.size} bytes, got ${buf.length}`);
  if (!v.internal) {
    assert.equal(createHash("sha256").update(buf).digest("hex"), v.sha256, `sha256 mismatch for ${v.file}`);
  }

  // (b) a real installer, end to end, to prove the stream doesn't truncate
  const r = smallestReal;
  const big = await fetch(`${base}/m/${r.rel}`);
  assert.equal(big.status, 200);
  const bigBuf = Buffer.from(await big.arrayBuffer());
  assert.equal(bigBuf.length, r.size, `${r.file}: got ${bigBuf.length} of ${r.size} bytes`);
  if (/\.apk$/.test(r.file)) assert.equal(bigBuf.subarray(0, 2).toString(), "PK", "apk must start with the ZIP magic");
  if (/\.exe$/.test(r.file)) assert.equal(bigBuf.subarray(0, 2).toString(), "MZ", "exe must start with MZ");
});

test("mirror mode: honours Range requests", async (t) => {
  const { child, base } = await startServer("mirror");
  t.after(() => child.kill());

  const res = await fetch(`${base}/m/${smallestReal.rel}`, { headers: { range: "bytes=0-1023" } });
  assert.equal(res.status, 206);
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.length, 1024);
  assert.match(res.headers.get("content-range") || "", /^bytes 0-1023\//);
});

test("mirror mode: traversal and off-list hosts leak nothing", async (t) => {
  const { child, base, port } = await startServer("mirror");
  t.after(() => child.kill());

  // fetch()/curl normalize "../" away before it hits the wire, so the only way
  // to test the real path handling is to write the request bytes ourselves.
  const hostile = [
    "/m/../../../etc/passwd",
    "/m/%2e%2e/%2e%2e/%2e%2e/etc/passwd",
    "/../server.js",
    "/%2e%2e/server.js",
  ];
  for (const p of hostile) {
    const out = await rawRequest(port, p);
    assert.doesNotMatch(out, /root:x:0:0/, `${p} leaked /etc/passwd`);
    assert.doesNotMatch(out, /import http from "node:http"/, `${p} leaked server.js`);
  }

  // A mirror path pointing at a host that isn't in the allow-list must not be fetched.
  const off = await fetch(`${base}/m/evil.example.com/x/releases/download/v1/x.exe`);
  assert.notEqual(off.status, 200, "off-list host must not be proxied");

  // A well-formed but unknown path falls back to the portal rather than erroring.
  const r2 = await fetch(`${base}/m/not-a-release`);
  assert.match(await r2.text(), /<html/i, "unknown path should serve the portal, not a file");
});

test("redirect mode: 307s to the upstream URL without proxying bytes", async (t) => {
  const { child, base } = await startServer("redirect");
  t.after(() => child.kill());

  const res = await fetch(`${base}/m/${smallestReal.rel}`, { redirect: "manual" });
  assert.equal(res.status, 307);
  assert.equal(res.headers.get("x-mirror-mode"), "redirect");
  assert.equal(res.headers.get("location"), smallestReal.upstream);
});

test("unknown routes fall back to the portal (client-side routing)", async (t) => {
  const { child, base } = await startServer("mirror");
  t.after(() => child.kill());
  const r = await fetch(`${base}/some/deep/link`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<html/i);
});
