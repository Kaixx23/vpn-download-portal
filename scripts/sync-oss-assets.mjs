#!/usr/bin/env node
/**
 * Download every public installer listed in catalog.json, verify its published
 * size/SHA-256, then upload it to Alibaba OSS at the exact catalog `rel` key.
 *
 * OSS credentials are read by ossutil from its local config; no secrets belong
 * in this repository or in chat. Set OSS_BUCKET_URI=oss://your-bucket first.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Transform, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(fs.readFileSync(path.join(root, "catalog.json"), "utf8"));
const bucketUri = (process.env.OSS_BUCKET_URI || "").replace(/\/$/, "");
const ossutil = process.env.OSSUTIL || "ossutil";
if (!/^oss:\/\/[A-Za-z0-9.-]+$/.test(bucketUri)) {
  throw new Error("Set OSS_BUCKET_URI to the target bucket, e.g. oss://vpn-downloads");
}

const files = [...new Map((catalog.apps || [])
  .flatMap((app) => app.files || [])
  .filter((file) => !file.internal && file.rel && file.upstream)
  .map((file) => [file.rel, file])).values()];
if (!files.length) throw new Error("No public installers found in catalog.json");

const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vpn-cdn-sync-"));
let failed = 0;
try {
  for (const [index, file] of files.entries()) {
    const key = file.rel.replace(/^\/+/, "");
    if (key.split("/").some((part) => part === "..")) throw new Error(`Unsafe object key: ${key}`);
    const localPath = path.join(tempDir, `${index}-${path.basename(key)}`);
    const target = `${bucketUri}/${key}`;
    process.stdout.write(`[${index + 1}/${files.length}] ${key} ... `);

    try {
      const response = await fetch(file.upstream, {
        redirect: "follow",
        headers: { "user-agent": "vpn-download-portal-oss-sync/1.0", "accept-encoding": "identity" },
      });
      if (!response.ok || !response.body) throw new Error(`upstream HTTP ${response.status}`);

      const hash = createHash("sha256");
      let size = 0;
      const verifier = new Transform({
        transform(chunk, _encoding, callback) {
          size += chunk.length;
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body), verifier, fs.createWriteStream(localPath));

      if (file.size && size !== Number(file.size)) {
        throw new Error(`size mismatch: catalog ${file.size}, downloaded ${size}`);
      }
      const sha256 = hash.digest("hex");
      if (file.sha256 && sha256.toLowerCase() !== String(file.sha256).toLowerCase()) {
        throw new Error("SHA-256 mismatch; refusing to upload this file");
      }

      const upload = spawnSync(ossutil, ["cp", "--force", localPath, target], { stdio: "inherit" });
      if (upload.error) throw upload.error;
      if (upload.status !== 0) throw new Error(`ossutil exited ${upload.status}`);
      const verification = file.sha256 ? "size + SHA-256 verified" : "size verified (no catalog SHA-256)";
      console.log(`uploaded (${(size / 1024 / 1024).toFixed(1)} MiB, ${verification})`);
    } catch (error) {
      failed++;
      console.error(`FAILED: ${error.message}`);
    } finally {
      await fsp.rm(localPath, { force: true });
    }
  }
} finally {
  await fsp.rm(tempDir, { recursive: true, force: true });
}

if (failed) {
  console.error(`${failed} of ${files.length} uploads failed.`);
  process.exitCode = 1;
} else {
  console.log(`Uploaded and verified ${files.length} installers to ${bucketUri}.`);
}
