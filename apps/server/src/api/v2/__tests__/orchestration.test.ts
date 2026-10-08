/** HTTP 编排回归：使用真实路由/仓储与显式 LLM fixture，不依赖正在运行的工作台。 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import { v2Router } from "../index";
import { readSeries, listEpisodes } from "../seriesStore";
import { repoRoot } from "../../../../../../packages/core/src/paths";
import { ProviderError } from "../../../../../../packages/providers/src/core/errors";
import { installLlmFixture, scriptFixture } from "./fixtures/llmFixture";

let server: http.Server;
let base = "";
let slug = "";
let episodeId = "";
let model: ReturnType<typeof installLlmFixture>;
async function post(endpoint: string, payload: unknown) {
  const response = await fetch(`${base}${endpoint}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

describe("Phase 5A Orchestration API — isolated contracts", () => {
  before(async () => {
    model = installLlmFixture();
    const app = express();
    app.use(express.json()); app.use("/api/v2", v2Router);
    app.use(((error, _req, res, _next) => {
      res.status(error.status ?? 500).json({ error: { code: error.code ?? "InternalError", message: error.message } });
    }) as express.ErrorRequestHandler);
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api/v2`;
        resolve();
      });
      server.once("error", reject);
    });
    const created = await post("/series", { title: "离线编排回归", synopsis: "自动测试，不是用户作品",
      defaults: { platform: "bilibili", content_type: "knowledge_card", visual_style: "cinematic", llm_provider_id: model.id } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    slug = created.body.series.slug;
  });
  after(async () => {
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it("rejects an empty inspiration without creating episodes", async () => {
    const result = await post(`/series/${slug}/expand-script`, {});
    assert.equal(result.status, 400);
    assert.equal((await listEpisodes(slug)).length, 0);
  });
  it("returns 404 for an unknown series", async () => {
    assert.equal((await post("/series/unknown-fixture/expand-script", { raw_inspiration: "机器人搬运的故事" })).status, 404);
  });
  it("reports missing credentials rather than writing a fake script", async () => {
    const result = await post(`/series/${slug}/expand-script`, { raw_inspiration: "机器人搬运的故事",
      overrides: { llm_provider_id: "ikuncode_gpt55" } });
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(result.body.error.code, "MissingKey");
    assert.equal((await listEpisodes(slug)).length, 0);
  });
  it("expands with the fixture, persists the script and returns a real snapshot", async () => {
    const result = await post(`/series/${slug}/expand-script`, { raw_inspiration: "机器人搬运的故事" });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.ok, true);
    episodeId = result.body.episode_id;
    assert.ok(episodeId);
    assert.ok(result.body.prompt_snapshot);
    assert.ok((await fs.readFile(path.join(repoRoot, result.body.script_path), "utf8")).includes(scriptFixture.full_script));
    assert.equal((await listEpisodes(slug)).length, 1);
    assert.equal((await readSeries(slug))?.script_version, 1);
    assert.ok(model.requests.length > 0);
  });
  it("sends the user's edited prompt unchanged and advances the script version", async () => {
    const prompt = "这段是用户审核后最终发送的完整提示词，不允许重新编译替换。";
    const result = await post(`/series/${slug}/expand-script`, { raw_inspiration: "机器人搬运的故事", prompt_override: prompt });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(model.requests.at(-1)?.prompt, prompt);
    assert.equal(result.body.episode_id, episodeId);
    assert.equal((await readSeries(slug))?.script_version, 2);
  });
  it("does not overwrite an accepted script when model output is invalid JSON", async () => {
    const beforeState = await readSeries(slug);
    model.reply("this is not a valid script response");
    const result = await post(`/series/${slug}/expand-script`, { raw_inspiration: "不应污染已有版本" });
    model.reply(scriptFixture);
    assert.equal(result.status, 502, JSON.stringify(result.body));
    assert.equal((await readSeries(slug))?.script_md, beforeState?.script_md);
    assert.equal((await readSeries(slug))?.script_version, beforeState?.script_version);
  });
  it("does not report expansion success when the provider fails", async () => {
    const beforeVersion = (await readSeries(slug))?.script_version;
    model.fail(new ProviderError({ message: "fixture provider failure", code: "server", provider_id: model.id, retriable: true }));
    const result = await post(`/series/${slug}/expand-script`, { raw_inspiration: "失败回归用例" });
    model.reply(scriptFixture);
    assert.equal(result.status, 502, JSON.stringify(result.body));
    assert.equal((await readSeries(slug))?.script_version, beforeVersion);
  });
  it("extracts entities from the latest saved edits instead of the old disk snapshot", async () => {
    const edited = "# 最新保存的剧本\n\n蓝色纸船穿过雨后的石桥，这是用户刚改写的内容。";
    const saved = await fetch(`${base}/series/${slug}/episodes/${episodeId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ script_md: edited }),
    });
    assert.equal(saved.status, 200);
    model.reply({ characters: [], scenes: [], relationships: [] });
    const result = await post(`/series/${slug}/episodes/${episodeId}/extract-entities`, {});
    model.reply(scriptFixture);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.ok(model.requests.at(-1)?.prompt.includes("蓝色纸船穿过雨后的石桥"));
    assert.ok(!model.requests.at(-1)?.prompt.includes(scriptFixture.full_script));
  });
  it("entity extraction rejects an unknown episode", async () => {
    assert.equal((await post(`/series/${slug}/episodes/no-such-episode/extract-entities`, {})).status, 404);
  });
  it("plans a real stored shot using the fixture model", async () => {
    const requestsBefore = model.requests.length;
    model.reply([{ shot_id: "shot_fixture", shot_type: "wide", scene_id: "scene_fixture", characters: [],
      action: "机器人安全行驶", camera_movement: "static", duration_sec: 3, prompt_img: "A robot on a track" }]);
    const result = await post(`/series/${slug}/episodes/${episodeId}/plan-storyboard`, {});
    model.reply(scriptFixture);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.ok(model.requests.slice(requestsBefore).some(request => request.prompt.includes("蓝色纸船穿过雨后的石桥")), "storyboard planning must receive the latest editor save");
    const shots = await (await fetch(`${base}/series/${slug}/episodes/${episodeId}/shots`)).json();
    assert.equal(shots.shots.length, 1);
  });
  it("storyboard planning rejects an unknown series", async () => {
    assert.equal((await post("/series/unknown-fixture/episodes/none/plan-storyboard", {})).status, 404);
  });
  it("storyboard planning rejects an unknown episode", async () => {
    assert.equal((await post(`/series/${slug}/episodes/no-such-episode/plan-storyboard`, {})).status, 404);
  });
  it("compose rejects invalid options without starting a generation task", async () => {
    assert.equal((await post(`/series/${slug}/episodes/${episodeId}/compose`, { aspect_ratio: "invalid-ratio" })).status, 400);
  });
  it("compose rejects an unknown episode", async () => {
    assert.equal((await post(`/series/${slug}/episodes/no-such-episode/compose`, {})).status, 404);
  });
  it("export rejects an unknown episode instead of inventing an output path", async () => {
    assert.equal((await post(`/series/${slug}/episodes/no-such-episode/export`, {})).status, 404);
  });
});
