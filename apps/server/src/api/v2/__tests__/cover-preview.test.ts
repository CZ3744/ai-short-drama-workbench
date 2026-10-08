import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import sharp from "sharp";
import { v2Router } from "../index";
import { createSeries, createEpisode, readSeries, readEpisode, addShot, updateShot } from "../seriesStore";
import { getRegistry } from "../orchestration/_shared/registry";
import { DATA_ROOT } from "../../../../../../packages/core/src/paths";
import { saveToVault, getVaultAbsolutePath } from "../../../../../../packages/library/src/assetVault";
import type { ImageGenerateRequest } from "../../../../../../packages/providers/src/core/types";
import type { GenerationRecord } from "../../../../../../packages/drama/src/types";

describe("cover prompt review and generation", () => {
  let server: Server;
  let base: string;
  let slug: string;
  let episodeId: string;
  let shotId: string;
  let referenceId: string;
  let referencePath: string;
  let png: Buffer;
  let generation: GenerationRecord;
  let failGeneration = false;
  const providerId = `fixture_cover_${randomUUID().replaceAll("-", "")}`;
  const requests: ImageGenerateRequest[] = [];
  const endpoints = () => [`/series/${slug}/generate-cover`, `/series/${slug}/episodes/${episodeId}/generate-cover`];
  async function post(endpoint: string, body: unknown) {
    const response = await fetch(`${base}${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  before(async () => {
    if (process.env.NODE_ENV !== "test" || !process.env.VIDEO_GENERATE_TEST_FIXTURE) throw new Error("Use isolated test runner");
    png = await sharp({ create: { width: 16, height: 24, channels: 3, background: "#947667" } }).png().toBuffer();
    getRegistry().register("image", providerId, () => ({
      id: providerId,
      async generate(request) {
        requests.push(request);
        return { images: failGeneration ? [] : [{ buffer: png, mime: "image/png", width: 16, height: 24 }] };
      },
      async healthCheck() { return { ok: true }; },
    }));
    const series = await createSeries({ title: "封面审核隔离测试", synopsis: "只用离线素材", defaults: { image_provider_id: providerId } });
    slug = series.slug;
    episodeId = (await createEpisode(slug, { title: "雨中相遇" })).id;
    shotId = (await addShot(slug, episodeId, { title: "窗边", index: 1 })).id;
    const vault = await saveToVault({ buffer: png, kind: "image", mime: "image/png", width: 16, height: 24, provider_id: providerId,
      context: { kind: "mood_board", series_slug: slug, prompt_digest_sha256: "" }, tags: ["isolated-test"] });
    referenceId = vault.vault_id;
    referencePath = getVaultAbsolutePath(vault);
    generation = { generation_id: "reference-generation", type: "first_frame", status: "done", provider: providerId,
      vault_id: referenceId, created_at: new Date().toISOString() };
    await updateShot(slug, episodeId, shotId, { picked_first_frame_generation_id: generation.generation_id, active_generations: [generation], generations: [generation] });
    const app = express(); app.use(express.json()); app.use("/api/v2", v2Router);
    app.use(((error, _req, res, _next) => { res.status(error.status ?? 500).json({ error: { message: error.message } }); }) as express.ErrorRequestHandler);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v2`;
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  it("previews both covers without provider calls, snapshots or cover mutation", async () => {
    const beforeSeries = await readSeries(slug);
    const beforeEpisode = await readEpisode(slug, episodeId);
    for (const endpoint of endpoints()) {
      const result = await post(`${endpoint}/preview`, { style: "水彩", title_text: "审核标题" });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.ok(result.body.prompt.includes("审核标题"));
      assert.ok(result.body.prompt.includes("水彩"));
      assert.ok(result.body.prompt.includes("封面审核隔离测试"));
      assert.ok(result.body.prompt.includes("只用离线素材"));
      assert.equal(result.body.prompt.includes("JSON"), false);
      assert.deepEqual(result.body.reference_images, []);
    }
    assert.equal(requests.length, 0);
    assert.deepEqual(await readSeries(slug), beforeSeries);
    assert.deepEqual(await readEpisode(slug, episodeId), beforeEpisode);
    await assert.rejects(fs.access(path.join(DATA_ROOT, "series", slug, "prompts")), { code: "ENOENT" });
    await assert.rejects(fs.access(path.join(DATA_ROOT, "series", slug, "episodes", episodeId, "_prompts")), { code: "ENOENT" });
  });
  it("shows the exact selected reference and sends the edited prompt with that image", async () => {
    const endpoint = endpoints()[1];
    const options = { style: "海报", reference_shot_id: shotId };
    const preview = await post(`${endpoint}/preview`, options);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.reference_asset_id, referenceId);
    assert.equal(preview.body.reference_images.length, 1);
    const downloaded = await fetch(new URL(preview.body.reference_images[0].url, base));
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png);
    const edited = "用户审核后的封面：只有窗边人物，不添加文字。";
    const result = await post(endpoint, { ...options, prompt_override: edited, reference_asset_id: preview.body.reference_asset_id });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(requests.at(-1)?.prompt, edited);
    assert.equal(requests.at(-1)?.reference_images?.length, 1);
    assert.equal(requests.at(-1)?.reference_images?.[0].asset_id, referencePath);
    const snapshot = JSON.parse(await fs.readFile(path.join(DATA_ROOT, "series", slug, "episodes", episodeId, "_prompts", result.body.prompt_snapshot), "utf8"));
    assert.equal(snapshot.prompt, edited);
    assert.equal((await readEpisode(slug, episodeId))?.cover_vault_id, result.body.asset_id);
  });
  it("sends reviewed series text unchanged and persists its actual cover", async () => {
    const edited = "用户改写的系列海报提示词。";
    const modelRef = `${providerId}:reviewed_model`;
    const preview = await post(`${endpoints()[0]}/preview`, { provider_override: modelRef });
    assert.equal(preview.body.provider_id, modelRef);
    const result = await post(endpoints()[0], { prompt_override: edited, provider_override: modelRef });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(requests.at(-1)?.prompt, edited);
    assert.equal(requests.at(-1)?.model_id, "reviewed_model");
    assert.equal((await readSeries(slug))?.cover_vault_id, result.body.vault_id);
  });
  it("rejects blank edited prompts without calling a provider", async () => {
    const count = requests.length;
    for (const endpoint of endpoints()) assert.equal((await post(endpoint, { prompt_override: "   " })).status, 400);
    assert.equal(requests.length, count);
  });
  it("rejects unavailable or discarded selected references instead of generating without them", async () => {
    const count = requests.length;
    assert.equal((await post(endpoints()[1], { reference_shot_id: "missing" })).status, 400);
    await updateShot(slug, episodeId, shotId, { active_generations: [], generations: [generation], trashed_generations: [generation] });
    assert.equal((await post(`${endpoints()[1]}/preview`, { reference_shot_id: shotId })).status, 400);
    assert.equal((await post(endpoints()[1], { reference_shot_id: shotId })).status, 400);
    assert.equal(requests.length, count);
    await updateShot(slug, episodeId, shotId, { active_generations: [generation], generations: [generation], trashed_generations: [] });
  });
  it("requires a new review if the image selection differs from the reviewed reference", async () => {
    const count = requests.length;
    const result = await post(endpoints()[1], { reference_shot_id: shotId, reference_asset_id: "old-reference" });
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, "ReferenceChanged");
    assert.equal(requests.length, count);
  });
  it("returns a real failure without placeholder assets and preserves the previous covers", async () => {
    const seriesCover = (await readSeries(slug))?.cover_vault_id;
    const episodeCover = (await readEpisode(slug, episodeId))?.cover_vault_id;
    failGeneration = true;
    try {
      for (const endpoint of endpoints()) {
        const result = await post(endpoint, {});
        assert.equal(result.status, 502);
        assert.equal(result.body.error.code, "GenerationFailed");
        assert.equal(result.body.asset, undefined);
      }
      assert.equal((await readSeries(slug))?.cover_vault_id, seriesCover);
      assert.equal((await readEpisode(slug, episodeId))?.cover_vault_id, episodeCover);
    } finally { failGeneration = false; }
  });
});
