import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AssetStore } from "../assetStore.js";
import { compact } from "../maintenance.js";
import { CURRENT_SCHEMA_VERSION, readOps } from "../jsonlIndex.js";

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "library-test-"));
  return dir;
}

// A tiny 1x1 red PNG (67 bytes)
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64"
);

describe("AssetStore", () => {
  let tmpDir: string;
  let store: AssetStore;

  before(async () => {
    tmpDir = await makeTmpDir();
    store = new AssetStore("test-series", tmpDir);
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("add returns an asset with correct fields", async () => {
    const asset = await store.add({
      buffer: TINY_PNG,
      kind: "image",
      mime: "image/png",
      tags: ["character:hero", "scene:opening"],
      source: { type: "provider", provider_id: "test-provider" },
      meta: { width: 1, height: 1 },
    });

    assert.ok(asset.id, "should have id");
    assert.equal(asset.kind, "image");
    assert.equal(asset.mime, "image/png");
    assert.ok(asset.sha256, "should have sha256");
    assert.ok(asset.file_path.startsWith("images/"), "file_path should be in images/");
    assert.ok(asset.file_size_bytes > 0);
    assert.ok(asset.created_at);
    assert.equal(asset.deleted_at, null);
  });

  it("add same buffer twice returns same asset (dedup)", async () => {
    const a1 = await store.add({
      buffer: TINY_PNG,
      kind: "image",
      mime: "image/png",
      tags: ["character:hero"],
      source: { type: "upload" },
    });
    const a2 = await store.add({
      buffer: TINY_PNG,
      kind: "image",
      mime: "image/png",
      tags: ["character:villain"],
      source: { type: "upload" },
    });

    assert.equal(a2.id, a1.id, "second add should return first asset's id");
    // Verify only one file exists on disk
    const imagesDir = path.join(store.assetsRoot, "images");
    const files = await fs.readdir(imagesDir);
    const pngFiles = files.filter((f) => f.endsWith(".png"));
    assert.equal(pngFiles.length, 1, "only one PNG file should exist on disk");
  });

  it("delete makes asset invisible in list but tombstone visible in jsonl", async () => {
    const asset = await store.add({
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]),
      kind: "image",
      mime: "image/png",
      tags: ["character:temp"],
      source: { type: "upload" },
    });
    const id = asset.id;

    await store.delete(id);

    const listed = await store.list();
    assert.ok(!listed.some((a) => a.id === id), "deleted asset should not appear in list");

    const gotten = await store.get(id);
    assert.equal(gotten, null, "deleted asset should not be returned by get");

    // Check tombstone in JSONL
    const jsonlPath = path.join(store.assetsRoot, "index.jsonl");
    const ops = await readOps(jsonlPath);
    const tombstone = ops.find((o) => o.op === "tombstone" && o.id === id);
    assert.ok(tombstone, "tombstone op should be in jsonl");
  });

  it("restart re-loads state from index consistently", async () => {
    // Create a fresh store pointing to the same directory
    const store2 = new AssetStore("test-series", tmpDir);
    const all = await store2.list();
    // Should see the add ops that were not tombstoned
    assert.ok(all.length > 0, "reloaded store should see assets");
    // Verify a specific live asset
    const livePng = all.find((a) => a.tags.includes("character:hero"));
    assert.ok(livePng, "should find the hero asset after restart");
  });

  it("200 adds + compact produces correct index.json", async () => {
    const tmpDir2 = await makeTmpDir();
    try {
      const storeBulk = new AssetStore("bulk-test", tmpDir2);
      for (let i = 0; i < 200; i++) {
        // Use unique buffers so each gets its own entry
        const buf = Buffer.alloc(16);
        buf.writeUInt32BE(i, 0);
        await storeBulk.add({
          buffer: buf,
          kind: i % 2 === 0 ? "image" : "video",
          mime: i % 2 === 0 ? "image/png" : "video/mp4",
          tags: [`scene:${i % 10}`],
          source: { type: "upload" },
        });
      }

      const assetsRoot = storeBulk.assetsRoot;
      const { assetCount, shaCount } = await compact(assetsRoot);

      assert.equal(assetCount, 200, "compact should report 200 assets");
      assert.equal(shaCount, 200, "compact should report 200 sha entries");

      // Verify index.json exists and is valid
      const snapRaw = await fs.readFile(path.join(assetsRoot, "index.json"), "utf-8");
      const snap = JSON.parse(snapRaw);
      assert.equal(snap.schema_version, CURRENT_SCHEMA_VERSION);
      assert.ok(snap.generated_at);
      assert.equal(Object.keys(snap.assets).length, 200);
      assert.equal(Object.keys(snap.sha256_to_id).length, 200);

      // Verify new store can load from compacted snapshot
      const storeBulk2 = new AssetStore("bulk-test", tmpDir2);
      const list = await storeBulk2.list();
      assert.equal(list.length, 200, "reloaded store should have 200 assets");
    } finally {
      await fs.rm(tmpDir2, { recursive: true, force: true });
    }
  });

  it("thumbnail generates 256 and 64 webp for a PNG", async () => {
    // Create a small but valid PNG for sharp to process (4x4 red square)
    const sharp = (await import("sharp")).default;
    const pngBuf = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 255, g: 0, b: 0 } },
    }).png().toBuffer();

    const tmpDir3 = await makeTmpDir();
    try {
      const storeThumb = new AssetStore("thumb-test", tmpDir3);
      const asset = await storeThumb.add({
        buffer: pngBuf,
        kind: "image",
        mime: "image/png",
        tags: ["scene:test-thumb"],
        source: { type: "upload" },
      });

      const path256 = await storeThumb.thumbnail(asset.id, 256);
      const path64 = await storeThumb.thumbnail(asset.id, 64);

      assert.ok(path256.endsWith(".webp"), "256 thumb should be webp");
      assert.ok(path64.endsWith(".webp"), "64 thumb should be webp");

      // Verify files exist
      const stat256 = await fs.stat(path256);
      const stat64 = await fs.stat(path64);
      assert.ok(stat256.isFile(), "256 thumb file should exist");
      assert.ok(stat64.isFile(), "64 thumb file should exist");
      assert.ok(stat256.size > 0, "256 thumb should not be empty");
      assert.ok(stat64.size > 0, "64 thumb should not be empty");
    } finally {
      await fs.rm(tmpDir3, { recursive: true, force: true });
    }
  });

  it("stats returns correct counts", async () => {
    const st = await store.stats();
    assert.ok(typeof st.images === "number");
    assert.ok(typeof st.videos === "number");
    assert.ok(typeof st.bytes_total === "number");
    assert.ok(typeof st.dedup_hit_rate === "number");
  });
});
