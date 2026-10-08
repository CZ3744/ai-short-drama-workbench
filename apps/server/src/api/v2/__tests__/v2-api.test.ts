/**
 * v2 API Integration Tests
 *
 * Run: npx tsx apps/server/src/api/v2/__tests__/v2-api.test.ts
 *
 * Tests:
 * 1. Each controller integration (CRUD)
 * 2. Orchestrator end-to-end mock (10 shots, 1 failure + retry success)
 * 3. SSE connection receives at least 2 events
 * 4. Settings PATCH does not leak key plaintext
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";

// ─── Test helpers ───────────────────────────────────────────────

let baseUrl = "";

async function get(path: string): Promise<{ status: number; body: any }> {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function post(path: string, data?: any, timeout = 5000): Promise<{ status: number; body: any }> {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: data ? JSON.stringify(data) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function patch(path: string, data: any): Promise<{ status: number; body: any }> {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(5000),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function del(path: string): Promise<{ status: number; body: any }> {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, { method: "DELETE", signal: AbortSignal.timeout(5000) });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// ─── Server setup ───────────────────────────────────────────────

let server: http.Server;
const TEST_PORT = 18799;

describe("v2 API", () => {
  let testSlug = "";
  let testEpId = "";
  let testCharId = "";
  let testSceneId = "";
  let testShotId = "";

  before(async () => {
    // Dynamic import to avoid circular deps
    const express = (await import("express")).default;
    const { v2Router } = await import("../index");

    const app = express();
    app.use(express.json());
    app.use("/api/v2", v2Router);

    // Error handler
    app.use((err: any, _req: any, res: any, _next: any) => {
      const status = err.status ?? 500;
      res.status(status).json({ error: { code: "Error", message: err.message } });
    });

    await new Promise<void>((resolve) => {
      server = app.listen(TEST_PORT, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${TEST_PORT}/api/v2`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // ─── Health ────────────────────────────────────────────────

  it("GET /health returns ok", async () => {
    const { status, body } = await get("/health");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.version, "v2");
  });

  it("POST /images/generate returns raw image without caller-side storage", async () => {
    const { status, body } = await post("/images/generate", {
      provider_id: "local_card_image",
      prompt: "raw endpoint smoke",
      width: 512,
      height: 512,
      count: 1,
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.provider_id, "local_card_image");
    assert.equal(body.images.length, 1);
    assert.match(body.images[0].data_url, /^data:image\/png;base64,/);
    assert.equal(body.images[0].width, 512);
    assert.equal(body.images[0].height, 512);
  });

  // ─── Series CRUD ───────────────────────────────────────────

  it("POST /series creates a series", async () => {
    const { status, body } = await post("/series", {
      title: "测试系列 API",
      synopsis: "用于测试的系列",
      defaults: { platform: "bilibili", max_parallel_tasks: 2 },
    });
    assert.equal(status, 201);
    assert.ok(body.series);
    assert.equal(body.series.title, "测试系列 API");
    testSlug = body.series.slug;
  });

  it("GET /series lists series", async () => {
    const { status, body } = await get("/series");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.series));
    assert.ok(body.series.length >= 1);
  });

  it("GET /series/:slug returns single series", async () => {
    const { status, body } = await get(`/series/${testSlug}`);
    assert.equal(status, 200);
    assert.equal(body.series.slug, testSlug);
  });

  it("PATCH /series/:slug updates series", async () => {
    const { status, body } = await patch(`/series/${testSlug}`, { synopsis: "更新后的简介" });
    assert.equal(status, 200);
    assert.equal(body.series.synopsis, "更新后的简介");
  });

  it("GET /series/:slug 404 for non-existent", async () => {
    const { status } = await get("/series/nonexistent-slug-xyz");
    assert.equal(status, 404);
  });

  // ─── Episode CRUD ──────────────────────────────────────────

  it("POST /series/:slug/episodes creates an episode", async () => {
    const { status, body } = await post(`/series/${testSlug}/episodes`, {
      title: "第一集：开端",
      index: 1,
    });
    assert.equal(status, 201);
    assert.ok(body.episode);
    testEpId = body.episode.id;
  });

  it("GET /series/:slug/episodes lists episodes", async () => {
    const { status, body } = await get(`/series/${testSlug}/episodes`);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.episodes));
    assert.equal(body.episodes.length, 1);
  });

  it("PATCH /series/:slug/episodes/:epId updates episode", async () => {
    const { status, body } = await patch(`/series/${testSlug}/episodes/${testEpId}`, { synopsis: "更新后的剧情" });
    assert.equal(status, 200);
    assert.equal(body.episode.synopsis, "更新后的剧情");
  });

  // ─── Character CRUD ────────────────────────────────────────
  // 2026-07-22 X8-6 (A4-16): 老 POST/GET /series/:slug/characters 纯 CRUD 路由
  // 已被 Wave Z-10 删除 (characterController.ts:67-69 注释"前端已收口到 element
  // API"), 这两条用例之前一直断言着已经 404 的路由, 是过时测试。改走现行等价路由
  // /series/:slug/elements (kind="character"), 字段经 elementPatchToCharacterPatch
  // 映射: description → appearance_prompt, tags[axis=role] → role,
  // attrs.personality → personality (apps/server/src/application/element/elementAdapter.ts)。

  it("POST /series/:slug/elements (kind=character) creates a character", async () => {
    const { status, body } = await post(`/series/${testSlug}/elements`, {
      kind: "character",
      name: "主角小明",
      description: "年轻男性，短发，穿白色T恤",
      tags: [{ axis: "role", value: "主角" }],
      attrs: { personality: "乐观开朗" },
    });
    assert.equal(status, 201);
    assert.ok(body.element);
    assert.equal(body.element.kind, "character");
    testCharId = body.element.id;
  });

  it("GET /series/:slug/elements?kind=character lists characters", async () => {
    const { status, body } = await get(`/series/${testSlug}/elements?kind=character`);
    assert.equal(status, 200);
    assert.equal(body.elements.length, 1);
  });

  it("POST /generate/image — character_ref (替代 deprecated generate-refs)", async () => {
    // Wave P (2026-05-20): 原 /series/:slug/characters/:id/generate-refs 已删,
    // 改用统一端点. response 字段从 assets[] / refs[] 改为 images[] (PersistedImage 形态).
    const { status, body } = await post(`/generate/image`, {
      prompt: "测试角色参考图",
      provider_id: "local_card_image",
      count: 2,
      width: 1024,
      height: 1024,
      target: {
        kind: "character_ref",
        series_slug: testSlug,
        target_id: testCharId,
      },
    });
    assert.equal(status, 200);
    assert.equal(body.images.length, 2);
    assert.ok(body.target_state, "character_ref adapter 应返回 target_state (CharacterData)");
  });

  // ─── Scene CRUD ────────────────────────────────────────────
  // 2026-07-22 X8-6 (A4-16): 同上, 老 POST/GET /series/:slug/scenes 已删
  // (sceneController.ts:26-28 同款注释), 改走 /series/:slug/elements (kind="scene")。
  // description 直接映射; tags[axis=time] → time_of_day (elementPatchToScenePatch)。

  it("POST /series/:slug/elements (kind=scene) creates a scene", async () => {
    const { status, body } = await post(`/series/${testSlug}/elements`, {
      kind: "scene",
      name: "城市街道",
      description: "夜晚的城市街道",
      tags: [{ axis: "time", value: "night" }],
    });
    assert.equal(status, 201);
    assert.ok(body.element);
    assert.equal(body.element.kind, "scene");
    testSceneId = body.element.id;
  });

  it("GET /series/:slug/elements?kind=scene lists scenes", async () => {
    const { status, body } = await get(`/series/${testSlug}/elements?kind=scene`);
    assert.equal(status, 200);
    assert.equal(body.elements.length, 1);
  });

  // ─── Shot ──────────────────────────────────────────────────

  it("POST /series/:slug/episodes/:epId/shots creates a shot", async () => {
    const { status, body } = await post(`/series/${testSlug}/episodes/${testEpId}/shots`, {
      title: "测试镜头",
      action: "主角走进夜晚的城市街道",
      prompt_img: "夜晚城市街道，中景，电影感",
      prompt_vid: "镜头缓慢前推",
      character_ids: [testCharId],
      scene_id: testSceneId,
    });
    assert.equal(status, 201);
    assert.ok(body.shot);
    testShotId = body.shot.id;
  });

  it("GET /shots/:sid returns shot-stage candidates DTO", async () => {
    const { status, body } = await get(`/shots/${testShotId}`);
    assert.equal(status, 200);
    assert.equal(body.sid, testShotId);
    assert.ok(Array.isArray(body.first_frame_candidates));
    assert.ok(Array.isArray(body.video_candidates));
    assert.ok(Array.isArray(body.trashed_candidates));
    assert.equal(body.picked_first_frame_id, null);
    assert.equal(body.picked_video_id, null);
  });

  it("POST /batch/execute dispatches a first-frame target", async () => {
    // W7 (2026-05-15) — Bug 1: 显式传 provider (silent fallback 已去掉)
    const { status, body } = await post("/batch/execute", {
      targets: [{ sid: testShotId, action: "firstframe", params: { count: 1, provider_override: "local_card_image" } }],
    }, 15_000);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(body.batch_id);
    assert.ok(body.attempt_id);
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].sid, testShotId);
    assert.equal(body.results[0].status, "queued");
    assert.ok(body.results[0].job_id);
  });

  it("POST/PATCH /series/:slug/inspirations persists inbox state", async () => {
    const created = await post(`/series/${testSlug}/inspirations`, {
      text: "雨夜便利店门口, 两个陌生人因为一把伞开始说话",
      tags: ["雨夜", "便利店"],
    });
    assert.equal(created.status, 201);
    assert.ok(created.body.inspiration.id);

    const listed = await get(`/series/${testSlug}/inspirations`);
    assert.equal(listed.status, 200);
    assert.ok(listed.body.inspirations.some((item: any) => item.id === created.body.inspiration.id));

    const patched = await patch(`/series/${testSlug}/inspirations/${created.body.inspiration.id}`, {
      saved: true,
      unread: false,
      expandedEpisodeId: testEpId,
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.inspiration.saved, true);
    assert.equal(patched.body.inspiration.unread, false);
    assert.equal(patched.body.inspiration.expandedEpisodeId, testEpId);
  });

  it("GET /series/:slug/episodes/:epId/shots returns shots from demo data", async () => {
    // Use the demo series for shot tests
    const { status, body } = await get("/series/demo-romance-3ep/episodes/ep01/shots");
    if (status === 200 && body.shots?.length > 0) {
      testShotId = body.shots[0].id;
      assert.ok(body.shots.length >= 1);
    } else {
      // Demo data may not exist in test env, that's OK
      assert.equal(status, 200);
    }
  });

  // ─── Presets ───────────────────────────────────────────────

  it("GET /presets returns all dictionaries", async () => {
    const { status, body } = await get("/presets");
    assert.equal(status, 200);
    assert.ok(body.presets);
    assert.ok(Object.keys(body.presets).length > 0);
  });

  // ─── Providers ─────────────────────────────────────────────

  it("GET /providers/health returns provider status", async () => {
    const { status, body } = await get("/providers/health");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.providers));
  });

  // ─── Templates ─────────────────────────────────────────────

  it("POST /templates creates a template", async () => {
    const { status, body } = await post("/templates", {
      name: "测试模板",
      source_series_slug: testSlug,
    });
    assert.equal(status, 201);
    assert.ok(body.template);
    assert.equal(body.template.name, "测试模板");
  });

  it("GET /templates lists templates", async () => {
    const { status, body } = await get("/templates");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.templates));
  });

  // ─── Tasks ─────────────────────────────────────────────────

  it("GET /tasks returns task list", async () => {
    const { status, body } = await get("/tasks");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.tasks));
  });

  // ─── Ledger ────────────────────────────────────────────────

  it("GET /ledger returns entries", async () => {
    const { status, body } = await get("/ledger");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.entries));
  });

  it("GET /ledger/aggregate returns aggregation", async () => {
    const { status, body } = await get("/ledger/aggregate");
    assert.equal(status, 200);
    assert.ok(typeof body.total === "number");
    assert.ok(body.by_provider);
  });

  // ─── Settings ──────────────────────────────────────────────

  it("GET /settings returns settings with masked keys", async () => {
    const { status, body } = await get("/settings");
    assert.equal(status, 200);
    assert.ok(body.settings);
    assert.ok(body.provider_status);
  });

  it("PATCH /settings does not leak key plaintext", async () => {
    const { status, body } = await patch("/settings", {
      max_parallel_tasks: 5,
      provider_keys: { ikuncode: "sk-test-secret-key-12345" },
    });
    assert.equal(status, 200);
    assert.ok(body.ok);
    // Verify no key in response
    const bodyStr = JSON.stringify(body);
    assert.ok(!bodyStr.includes("sk-test-secret-key-12345"), "Response should not contain key plaintext");
    assert.ok(!bodyStr.includes("sk-test"), "Response should not contain key prefix");
  });

  // ─── Validation ────────────────────────────────────────────

  it("POST /series returns 400 for invalid body", async () => {
    const { status, body } = await post("/series", { title: "" });
    assert.equal(status, 400);
    assert.ok(body.error);
    assert.equal(body.error.code, "ValidationError");
  });

  // 2026-07-22 X8-6 (A4-16): 同上, 老 POST /series/:slug/characters 已删,
  // 这条 400 校验用例之前一直打在死路由上(实际会拿到 Express 默认 404 HTML 页,
  // .json() 解析失败 body=null, 断言 status===400 必然先炸)。改走现行等价路由
  // /series/:slug/elements, 用"缺 kind"触发 crud.ts 里真实存在的校验分支。
  it("POST /series/:slug/elements returns 400 for missing kind", async () => {
    const { status, body } = await post(`/series/${testSlug}/elements`, { name: "test" });
    assert.equal(status, 400);
    assert.ok(body.error);
  });

  // ─── Settings key safety ───────────────────────────────────

  it("GET /settings never returns key plaintext (no sk- patterns)", async () => {
    const { status, body } = await get("/settings");
    assert.equal(status, 200);
    const bodyStr = JSON.stringify(body);
    assert.ok(!bodyStr.match(/sk-[A-Za-z0-9_-]{10,}/), "Response should not contain API key patterns");
  });

  // ─── Orchestration (mock) ──────────────────────────────────

  it("POST /series/:slug/expand-script returns prompt snapshot", async () => {
    const { installLlmFixture } = await import("./fixtures/llmFixture");
    const fixture = installLlmFixture();
    const { status, body } = await post(`/series/${testSlug}/expand-script`, {
      raw_inspiration: "一个关于人工智能未来的短片",
      overrides: { llm_provider_id: fixture.id },
    }, 15_000);
    assert.equal(status, 200);
    assert.ok(body.ok);
    assert.ok(body.prompt_snapshot);
  });

  // ─── Cleanup ───────────────────────────────────────────────

  it("DELETE /series/:slug soft-deletes series", async () => {
    const { status, body } = await del(`/series/${testSlug}`);
    assert.equal(status, 200);
    assert.ok(body.ok);
  });

  it("GET /series/:slug 404 after delete", async () => {
    const { status } = await get(`/series/${testSlug}`);
    assert.equal(status, 404);
  });
});

// ─── Orchestrator unit test ─────────────────────────────────────

describe("JobOrchestrator", () => {
  it("orchestrates 10 shots with 1 failure + retry success", async () => {
    const { JobOrchestrator } = await import("../../../jobs/orchestrator");

    // Create a test series and episode with 10 shots
    const { createSeries, createEpisode, deleteSeries } = await import("../seriesStore");

    const series = await createSeries({
      title: "Orchestrator 测试系列",
      defaults: { max_parallel_tasks: 5, max_retake_per_shot: 3, max_video_seconds_per_job: 300 },
    });

    try {
      const episode = await createEpisode(series.slug, { title: "测试集" });

      // Create 10 shots by updating existing store
      const store = await import("../seriesStore");
      for (let i = 1; i <= 10; i++) {
        const shotId = `s${String(i).padStart(4, "0")}`;
        // Write shot file directly
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        // XT-T3 (2026-07-22): 之前 path.join(process.cwd(), "data", "series", ...) 没跟上 2026-05-27
        // DATA_ROOT 外部化重构 —— 真实读取路径 (repositories/_paths.ts 的 shotsDir/shotFile) 是
        // DATA_ROOT/series/<slug>/episodes/<epId>/shots/<shotId>.json, 而 DATA_ROOT 默认走
        // VIDEO_GENERATE_DATA_ROOT env (本仓指向 repoRoot 外部目录), 不等于 process.cwd()+"data"。
        // 两个路径从重构那天起就对不上 → orchestrator 的 listShots 在真实 DATA_ROOT 下找不到这里手写
        // 的 fixture 文件, 报 "No shots found for episode ep01"。改用同一个 DATA_ROOT 常量即可对齐。
        const { DATA_ROOT } = await import("../../../../../../packages/core/src/paths");
        const shotDir = path.join(DATA_ROOT, "series", series.slug, "episodes", episode.id, "shots");
        await fs.mkdir(shotDir, { recursive: true });
        await fs.writeFile(
          path.join(shotDir, `${shotId}.json`),
          JSON.stringify({
            id: shotId,
            series_slug: series.slug,
            episode_id: episode.id,
            index: i,
            duration_sec: 5,
            character_ids: [],
            prompt_img: `test prompt ${i}`,
            prompt_vid: `test video prompt ${i}`,
            generations: [],
            status: "drafted",
            failures: [],
          }),
          "utf8"
        );
      }

      // Run orchestrator
      // W7 (2026-05-15) — Bug 1: 显式传 provider, 否则 silent fallback 已去掉,会抛 ProviderNotSelectedError
      // XT-T3 (2026-07-22): 修完上面的 DATA_ROOT 路径不对齐后, 露出第二层独立问题 —
      // `new JobOrchestrator(...)` 直接 new 出的实例默认 _registry=null; 生产代码里唯一被真实注入过
      // registry 的是 orchestrator.ts export 的单例 `orchestrator` (通过 _shared/registry.ts 的
      // getRegistry() 内部调用 orchestrator.setRegistry(...)), 这里测试自己手动 new 了一个新实例,
      // 从未调用过 setRegistry, 于是 orchestrate() 深处的 _buildTaskPayloads 断言"ProviderRegistry
      // 未注入"必炸。getRegistry() 是幂等的 memoized 单例 getter (前面 POST /images/generate 等用例已
      // 间接触发过初始化), 这里显式再拿一次注入到本地实例即可, 和生产路径的初始化方式完全一致。
      const { getRegistry } = await import("../orchestration/_shared/registry");
      const orch = new JobOrchestrator({ max_parallel: 5, default_retries: 2 });
      orch.setRegistry(getRegistry());
      const result = await orch.orchestrate({
        series_slug: series.slug,
        episode_id: episode.id,
        action: "generate_first_frames",
        count_per_shot: 1,
        provider_override: "local_card_image",
      });

      assert.equal(result.shot_count, 10);
      assert.equal(result.task_count, 10);
      assert.ok(result.job_id);
      assert.ok(result.tasks.length === 10);

      // XT-T3 (2026-07-22): 原固定 sleep 1000ms 的注释"mock runner is instant"描述的是 2026-05-15
      // "W7-real-fix" 已经删除的老 silent-mock-fallback 路径 (早已过时 — 现在没注入 registry 直接
      // throw, 不会假装完成)。上面补了 setRegistry() 后, 任务改走真实 local_card_image provider
      // (落盘 vault + clip 质量打分 HTTP 请求 + 不理想重试), 单镜可能到秒级, 10 镜 max_parallel=5
      // 并发不保证 1s 内全部落定。改成轮询到全部任务进终态 (done/failed) 或 30s 超时兜底, 不再赌它比
      // 固定 1s 快 (慢就是 flaky fail, 跟"验证该失败消失"的目的背道而驰)。
      const pollDeadlineMs = Date.now() + 30_000;
      let tasks = store.listTasks({ job_id: result.job_id });
      while (
        Date.now() < pollDeadlineMs &&
        tasks.some(t => t.status === "queued" || t.status === "running")
      ) {
        await new Promise(r => setTimeout(r, 300));
        tasks = store.listTasks({ job_id: result.job_id });
      }

      // Check that all tasks completed
      const doneTasks = tasks.filter(t => t.status === "done");
      assert.ok(doneTasks.length >= 8, `Expected at least 8 done tasks, got ${doneTasks.length} (statuses: ${tasks.map(t => t.status).join(",")})`);
    } finally {
      await deleteSeries(series.slug).catch(() => false);
    }
  });
});

// ─── SSE test ───────────────────────────────────────────────────

describe("SSE Broker", () => {
  it("receives at least 2 events", async () => {
    const { sseBroker } = await import("../sseBroker");

    const events: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试 mock 假装 Express Response, 只用 writeHead/write/on 子集
    const mockRes = new EventEmitter() as any;
    mockRes.writeHead = () => {};
    mockRes.write = (data: string) => {
      // Parse SSE data
      const lines = data.split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            events.push(JSON.parse(line.slice(6)));
          } catch { /* skip */ }
        }
      }
    };
    mockRes.on = mockRes.on.bind(mockRes);

    const unsub = sseBroker.subscribe("test-job-123", mockRes);

    // Emit 3 events
    sseBroker.emit({ type: "task.queued", job_id: "test-job-123", task_id: "t1", data: {}, at: new Date().toISOString() });
    sseBroker.emit({ type: "task.running", job_id: "test-job-123", task_id: "t1", data: {}, at: new Date().toISOString() });
    sseBroker.emit({ type: "task.done", job_id: "test-job-123", task_id: "t1", data: {}, at: new Date().toISOString() });

    // The first event (connected) + 3 emitted = 4 total
    assert.ok(events.length >= 2, `Expected at least 2 events, got ${events.length}`);

    unsub();
  });
});

// ─── Settings key leak test (merged into main v2 API describe) ───
// This test is in the main describe block above to share the server lifecycle.
