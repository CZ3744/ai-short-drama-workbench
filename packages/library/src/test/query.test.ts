import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AssetStore } from "../assetStore.js";
import { findByCharacter, findCandidatesByShot, findByEpisode } from "../query.js";

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "library-query-test-"));
}

// Unique buffer generator
let bufCounter = 0;
function makeBuf(n = 16): Buffer {
  const b = Buffer.alloc(n);
  b.writeUInt32BE(bufCounter++, 0);
  return b;
}

describe("Query functions", () => {
  let tmpDir: string;
  let store: AssetStore;

  before(async () => {
    tmpDir = await makeTmpDir();
    store = new AssetStore("query-test", tmpDir);

    // Seed with test data
    // Character images
    await store.add({
      buffer: makeBuf(), kind: "image", mime: "image/png",
      tags: ["character:alice", "scene:s1"],
      source: { type: "provider", provider_id: "p1" },
    });
    await store.add({
      buffer: makeBuf(), kind: "image", mime: "image/png",
      tags: ["character:alice", "scene:s2"],
      source: { type: "provider", provider_id: "p1" },
    });
    await store.add({
      buffer: makeBuf(), kind: "image", mime: "image/png",
      tags: ["character:bob", "scene:s1"],
      source: { type: "provider", provider_id: "p2" },
    });

    // Shot candidates
    await store.add({
      buffer: makeBuf(), kind: "image", mime: "image/png",
      tags: ["shot:shot-001", "character:alice"],
      source: { type: "provider", provider_id: "p1" },
    });
    await store.add({
      buffer: makeBuf(), kind: "video", mime: "video/mp4",
      tags: ["shot:shot-001", "character:alice"],
      source: { type: "provider", provider_id: "p1" },
    });
    await store.add({
      buffer: makeBuf(), kind: "video", mime: "video/mp4",
      tags: ["shot:shot-002", "character:bob"],
      source: { type: "provider", provider_id: "p2" },
    });

    // Episode assets
    await store.add({
      buffer: makeBuf(), kind: "audio", mime: "audio/m4a",
      tags: ["episode:ep01", "series:my-show"],
      source: { type: "derived" },
    });
    await store.add({
      buffer: makeBuf(), kind: "image", mime: "image/png",
      tags: ["episode:ep01", "scene:s1"],
      source: { type: "provider", provider_id: "p1" },
    });
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("findByCharacter returns images for a character", async () => {
    const aliceAssets = await findByCharacter(store, "alice");
    assert.equal(aliceAssets.length, 3); // 2 scene images + 1 shot candidate image
    assert.ok(aliceAssets.every((a) => a.kind === "image"));
    assert.ok(aliceAssets.every((a) => a.tags.includes("character:alice")));
  });

  it("findByCharacter returns empty for unknown character", async () => {
    const result = await findByCharacter(store, "nobody");
    assert.equal(result.length, 0);
  });

  it("findCandidatesByShot returns image candidates by default", async () => {
    const shot001Images = await findCandidatesByShot(store, "shot-001");
    assert.equal(shot001Images.length, 1);
    assert.equal(shot001Images[0].kind, "image");
  });

  it("findCandidatesByShot returns video candidates when kind=video", async () => {
    const shot001Videos = await findCandidatesByShot(store, "shot-001", "video");
    assert.equal(shot001Videos.length, 1);
    assert.equal(shot001Videos[0].kind, "video");
  });

  it("findByEpisode returns all kinds for an episode", async () => {
    const ep01 = await findByEpisode(store, "ep01");
    assert.equal(ep01.length, 2);
    const kinds = ep01.map((a) => a.kind).sort();
    assert.deepEqual(kinds, ["audio", "image"]);
  });

  it("findByEpisode returns empty for unknown episode", async () => {
    const result = await findByEpisode(store, "ep99");
    assert.equal(result.length, 0);
  });
});
