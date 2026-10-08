/** 浏览器验收只允许 run-safe-tests --browser 的临时副本；绝不启动用户数据恢复队列。 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { chromium, type Browser, type Page, type Locator } from "playwright";
import express, { type Response as ExpressResponse } from "express";
import { router } from "../apps/server/src/api/routes";
import { v2Router } from "../apps/server/src/api/v2";
import { requestLogging } from "../apps/server/src/middleware/requestLogging";
import { localRequestGuard } from "../apps/server/src/middleware/localRequestGuard";
import { createEpisode, addShot, createCharacter, updateCharacter } from "../apps/server/src/api/v2/seriesStore";
import { addAsset } from "../apps/server/src/repositories/assetRepo";
import { writeLocalSettings } from "../packages/core/src/localSettings";
import sharp from "sharp";
import { createTaskRecord, updateTaskRecord } from "../apps/server/src/repositories/taskRepo";
import { SseBroker } from "../apps/server/src/api/v2/sseBroker";
import { createCast } from "../apps/server/src/repositories/castRepo";
import { verifyCreatorWorkflow } from "./browser-workflow-checks";
import { edgeTestEnvironment } from "./browser-test-environment.mjs";

if (process.env.NODE_ENV !== "test" || path.resolve(process.env.VIDEO_GENERATE_TEST_FIXTURE ?? "") !== process.cwd()) {
  throw new Error("浏览器验收必须通过隔离入口启动，禁止使用真实项目数据");
}
const out = path.join(process.cwd(), "browser-results");
await fs.mkdir(out, { recursive: true });
const report = {
  at: new Date().toISOString(), status: "running", browser: "", createdSeries: false,
  checks: [] as Array<Record<string, unknown>>, pageErrors: [] as string[],
  consoleErrors: [] as string[], httpErrors: [] as string[], externalRequests: [] as string[],
  failure: "",
};
let browser: Browser | undefined;
let server: Server | undefined;
let page: Page | undefined;

try {
  const app = express();
  app.use(localRequestGuard("http://127.0.0.1:5173"));
  app.use(requestLogging());
  app.use(express.json({ limit: "50mb" }));
  const eventConnections = new Set<ExpressResponse>();
  let fixtureBroker = new SseBroker();
  app.get("/api/v2/events", (req, res) => {
    eventConnections.add(res);
    res.once("close", () => eventConnections.delete(res));
    fixtureBroker.subscribe("__global__", res, req.query.lastEventId ? Number(req.query.lastEventId) : undefined);
  });
  app.get("/healthz", (_req, res) => res.json({ ok: true, fixture: true, last_backup: null }));
  app.use("/api", router);
  app.use("/api/v2", v2Router);
  app.use("/api", (req, res) => res.status(404).json({ error: { code: "NotFound", message: `测试服务未匹配接口 ${req.path}` } }));
  app.use(express.static(path.join(process.cwd(), "dist/web")));
  app.use((_req, res) => res.sendFile("index.html", { root: path.join(process.cwd(), "dist/web") }));
  app.use(((error, _req, res, _next) => res.status(error.status ?? 500).json({ error: { code: error.code, message: error.message } })) as express.ErrorRequestHandler);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server!.once("listening", resolve); server!.once("error", reject); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  if (process.env.VIDEO_GENERATE_TEST_BROWSER === "msedge") {
    browser = await chromium.launch({ channel: "msedge", headless: true, timeout: 20_000, env: edgeTestEnvironment() });
    report.browser = "Microsoft Edge (Chromium)";
  } else try {
    browser = await chromium.launch({ headless: true, timeout: 20_000 });
    report.browser = "Playwright Chromium";
  } catch (firstError) {
    try {
      browser = await chromium.launch({ channel: "msedge", headless: true, timeout: 20_000, env: edgeTestEnvironment() });
      report.browser = "Microsoft Edge (Chromium)";
    } catch (secondError) {
      throw new Error(`没有可启动的浏览器。Chromium: ${String(firstError)}；Edge: ${String(secondError)}`);
    }
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN", reducedMotion: "reduce", serviceWorkers: "block" });
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === base || ["data:", "blob:"].includes(url.protocol)) return route.continue();
    report.externalRequests.push(`${url.origin}${url.pathname}`);
    await route.abort("blockedbyclient");
  });
  await context.addInitScript(() => {
    if (!localStorage.getItem("browser-fixture.show-tour")) localStorage.setItem("video-generate.onboarding.completed.v3", "demo_completed");
  });
  page = await context.newPage();
  page.setDefaultTimeout(12_000);
  page.on("pageerror", error => report.pageErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") report.consoleErrors.push(message.text()); });
  page.on("response", response => { if (response.status() >= 400) report.httpErrors.push(`${response.status()} ${new URL(response.url()).pathname}`); });

  async function inspect(name: string, route: string, width = 1440, height = width < 600 ? 844 : 900) {
    await page!.setViewportSize({ width, height });
    if (route) await page!.goto(`${base}${route}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    if (name === "not-found") {
      await page!.getByRole("heading", { name: "页面未找到", exact: true }).waitFor();
    } else {
      await page!.waitForFunction(() => (document.getElementById("root")?.innerText.length ?? 0) > 40);
    }
    await page!.waitForTimeout(450);
    if (name.startsWith("script")) await page!.getByText("正在载入剧本编辑器…", { exact: true }).waitFor({ state: "hidden" });
    if (name.startsWith("status-health")) await page!.locator('[data-diagnostics-state="ready"]').waitFor({ timeout: 30_000 });
    const state = await page!.evaluate(() => ({
      title: document.title,
      textLength: document.getElementById("root")?.innerText.length ?? 0,
      viewport: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      mainWidth: document.querySelector("main")?.getBoundingClientRect().width,
      background: getComputedStyle(document.body).backgroundColor,
      bodyText: (document.getElementById("root")?.innerText ?? "").slice(0, 180),
    }));
    assert.ok(state.textLength > (name === "not-found" ? 10 : 40), `${name} 不应白屏`);
    assert.ok(!await page!.getByRole("heading", { name: "页面出了点问题", exact: true }).count(), `${name} 进入页面错误边界`);
    assert.ok(state.documentWidth <= width + 1, `${name} 根文档出现横向溢出`);
    const filename = `${String(report.checks.length + 1).padStart(2, "0")}-${name}.png`;
    await page!.screenshot({ path: path.join(out, filename), fullPage: true });
    report.checks.push({ name, route, ...state, screenshot: filename, horizontalOverflow: state.documentWidth > width + 1 });
    const main = page!.locator("main");
    if (await main.count() && (name === "status-failures-narrow" || await main.evaluate(el => el.scrollHeight > el.clientHeight * 1.3))) {
      await main.evaluate(el => el.scrollTop = el.scrollHeight);
      await page!.screenshot({ path: path.join(out, filename.replace(".png", "-bottom.png")), fullPage: true });
      await main.evaluate(el => el.scrollTop = 0);
    }
    if (name === "status-failures-narrow") {
      const failureCard: Locator = page!.locator(".failure-record").first();
      await failureCard.waitFor({ state: "visible" });
      await failureCard.scrollIntoViewIfNeeded();
      await page!.screenshot({ path: path.join(out, filename.replace(".png", "-record.png")), fullPage: true });
    }
    if (name === "series-overview-narrow") {
      const episodeRow: Locator = page!.locator(".v24-series-episode-row").first();
      await episodeRow.scrollIntoViewIfNeeded();
      await page!.screenshot({ path: path.join(out, filename.replace(".png", "-episode.png")), fullPage: true });
      const action = episodeRow.getByRole("button").last();
      await action.scrollIntoViewIfNeeded();
      await action.click({ trial: true });
    }
  }

  await inspect("studio-desktop", "/studio");
  await page.getByRole("button", { name: "新建系列", exact: true }).first().click();
  await page.getByPlaceholder("例如：雨夜咖啡馆 · 都市治愈短剧").fill("雨夜咖啡馆");
  await inspect("create-series-dialog", "");
  const created = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v2/series" && response.request().method() === "POST");
  await page.getByRole("button", { name: "创建系列", exact: true }).click();
  const response = await created;
  assert.equal(response.status(), 201);
  const payload = await response.json();
  const slug = payload.series.slug as string;
  assert.ok(slug);
  // Creation does not force navigation; the creator chooses when to open the project.
  await page.goto(`${base}/studio/${encodeURIComponent(slug)}`);
  report.createdSeries = true;
  const episode = await createEpisode(slug, { title: "第一集 · 雨停之前" });
  const shot = await addShot(slug, episode.id, { title: "雨中的暖光", action: "雨滴划过玻璃，咖啡馆里透出温暖的灯光。", prompt_img: "A warm cafe on a rainy evening", prompt_vid: "Rain slides down the window as warm light glows inside." });
  // Real EventSource sockets + real task API; fixture records never run a provider queue.
  const second = await context.newPage();
  await second.goto(`${base}/studio/${encodeURIComponent(slug)}/inbox`);
  await page.waitForFunction(() => document.querySelector(".global-tools"));
  const connectionsReadyBy = Date.now() + 10_000;
  while (eventConnections.size < 2 && Date.now() < connectionsReadyBy) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(eventConnections.size, 2, "both tabs must have an active EventSource before the event");
  const id = "browser-network-task";
  createTaskRecord({ id, job_id: "browser-job", kind: "video", provider_id: "fixture", status: "running", meta: { series_slug: slug, episode_id: episode.id, shot_id: shot.id } });
  fixtureBroker.emit({ type: "task.running", job_id: "browser-job", task_id: id, data: { shot_id: shot.id, action: "video" }, at: new Date().toISOString() });
  for (const tab of [page, second]) await tab.waitForFunction(taskId => JSON.parse(localStorage.getItem("video-generate.tasks.v2") ?? "{}")[taskId]?.status === "running", id);
  // Close the transport, replace the broker (empty sequence/ring), change status while disconnected.
  for (const connection of eventConnections) connection.destroy();
  fixtureBroker = new SseBroker();
  updateTaskRecord(id, { status: "failed", error: "隔离测试：服务重连后恢复失败状态" });
  for (const tab of [page, second]) {
    await tab.waitForFunction(taskId => JSON.parse(localStorage.getItem("video-generate.tasks.v2") ?? "{}")[taskId]?.status === "failed", id);
    await tab.locator('[data-tool-trigger="queue"]').click();
    await tab.locator('[data-tool-panel="queue"]').getByText("隔离测试：服务重连后恢复失败状态", { exact: false }).first().waitFor();
    await tab.keyboard.press("Escape");
  }
  await second.close();
  report.checks.push({ name: "SSE-network-reconnect-two-tabs", realEventSource: true, brokerRestartSimulated: true, failedTaskRecovered: true, paidCalls: 0 });

  // Exercise the real consistency route and UI with explicitly local byte comparison.
  await writeLocalSettings({ CONSISTENCY_SCORER_PROVIDER: "phash" });
  const character = await createCharacter(slug, { name: "浏览器检查角色", role: "lead", personality: "calm" });
  const consistencyUrl = `${base}/api/v2/series/${encodeURIComponent(slug)}/characters/${character.id}/consistency-check`;
  const insufficient = await context.request.get(consistencyUrl);
  assert.equal((await insufficient.json()).report.avg_similarity, null);
  assert.equal((await context.request.get(`${consistencyUrl}?threshold=NaN`)).status(), 400);
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#c86a45" } }).png().toBuffer();
  const assetIds: string[] = [];
  for (const name of ["consistency-a.png", "consistency-b.png"]) {
    await fs.writeFile(path.join(process.cwd(), "data", "series", slug, "assets/images", name), png);
    const asset = await addAsset(slug, { series_slug: slug, kind: "image", tags: [], path: `assets/images/${name}`, filename: name, mime: "image/png", size_bytes: png.length });
    assetIds.push(asset.asset_id);
  }
  await updateCharacter(slug, character.id, { ref_image_ids: assetIds });
  await page.goto(`${base}/studio/${encodeURIComponent(slug)}/elements/${character.id}`);
  const panel = page.locator("details").filter({ has: page.locator("summary").filter({ hasText: "一致性体检" }) });
  await panel.locator("summary").click();
  await panel.getByRole("button", { name: "开始检查", exact: true }).click();
  await panel.getByText("整体一致度", { exact: true }).waitFor();
  await fs.unlink(path.join(process.cwd(), "data", "series", slug, "assets/images/consistency-b.png"));
  const failedCheck = page.waitForResponse(r => r.url().includes("/consistency-check") && r.status() === 503);
  await panel.getByRole("button", { name: "重新检查", exact: true }).click();
  const failedResponse = await failedCheck;
  assert.equal((await failedResponse.json()).error.code, "ConsistencyScorerUnavailable");
  await panel.getByText("以下保留上一次有效报告，本次未产生新评分。", { exact: true }).waitFor();
  assert.equal(await panel.getByText("整体一致度", { exact: true }).isVisible(), true);
  await page.screenshot({ path: path.join(out, "consistency-report-retained.png"), fullPage: true });
  report.checks.push({ name: "consistency-unavailable-retains-report", realRoute: true, lessThanTwo: "null", unavailableStatus: 503, previousReportVisible: true });
  // Restore the deliberately removed fixture image before the visual page sweep.
  await fs.writeFile(path.join(process.cwd(), "data", "series", slug, "assets/images/consistency-b.png"), png);

  const nextShot = await addShot(slug, episode.id, { title: "第二镜独立标题", action: "Second isolated shot" });
  await page.goto(`${base}/studio/${encodeURIComponent(slug)}/shot-stage/${episode.id}/${shot.id}`);
  const titleInput = page.getByPlaceholder("给这个分镜起个名字");
  await titleInput.waitFor();
  await titleInput.fill("切镜前保存的标题");
  await page.getByRole("button", { name: "后一镜", exact: true }).first().click();
  await page.waitForURL(url => url.pathname.endsWith(nextShot.id));
  await page.waitForFunction(() => (document.querySelector('input[placeholder="给这个分镜起个名字"]') as HTMLInputElement)?.value === "第二镜独立标题");
  await page.getByRole("button", { name: "前一镜", exact: true }).first().click();
  await page.waitForURL(url => url.pathname.endsWith(shot.id));
  await page.waitForFunction(() => (document.querySelector('input[placeholder="给这个分镜起个名字"]') as HTMLInputElement)?.value === "切镜前保存的标题");
  report.checks.push({ name: "shot-navigation-saves-and-isolates-draft", actualClicks: true, originalDraftPersisted: true });
  const routes = [
    ["studio-with-project", "/studio"], ["series-overview", `/studio/${slug}`],
    ["inbox", `/studio/${slug}/inbox`], ["script", `/studio/${slug}/script/${episode.id}`],
    ["storyboard", `/studio/${slug}/storyboard/${episode.id}`], ["elements", `/studio/${slug}/elements`],
    ["shot-stage", `/studio/${slug}/shot-stage/${episode.id}/${shot.id}`],
    ["compose", `/studio/${slug}/compose/${episode.id}`],
    ["settings", "/settings"], ["vault", "/vault"], ["trash", "/trash"],
    ["timeline", `/studio/${slug}/timeline/${episode.id}`],
    ["element-workbench", `/studio/${slug}/elements/${character.id}`],
    ["shot-failures", `/studio/${slug}/shot-stage/${episode.id}/${shot.id}/failures`],
    ...["character", "scene", "prop", "wardrobe", "reference", "misc"].map(kind => [`elements-${kind}`, `/studio/${slug}/elements/kind/${kind}`]),
    ...["health", "failures", "logs"].map(tab => [`status-${tab}`, `/status?tab=${tab}`]),
    ...["episodes", "elements", "series", "casts"].map(tab => [`trash-${tab}`, `/trash?tab=${tab}`]),
  ];
  const cast = await createCast({ name: "咖啡馆剧组", description: "跨作品复用的示例素材组" });
  routes.push(["cast-detail", `/casts/${cast.id}`]);
  for (const [name, route] of routes) await inspect(name, route);
  await inspect("settings-text", "/settings");
  for (const label of ["图像模型", "视频模型", "语音模型", "真实视频锁", "链路", "预算", "用量", "关于"]) {
    await page.getByRole("button", { name: label, exact: true }).first().click();
    await inspect(`settings-${label}`, "");
    if (label === "图像模型") {
      const extension = page.locator('[data-model-id="local_sdxl_openclaw"]');
      assert.equal(await extension.getByText("待配置", { exact: true }).isVisible(), true);
      assert.match(await extension.innerText(), /本地执行器/);
      assert.equal(await extension.getByRole("button", { name: "试一下", exact: true }).count(), 0);
      const demo = page.locator('[data-model-id="local_card_image"]');
      assert.equal(await demo.getByText("已配置", { exact: true }).isVisible(), true);
      report.checks.at(-1)!.providerReadinessVerified = true;
    }
  }
  await verifyCreatorWorkflow({ page, base, slug, inspect, checks: report.checks });
  for (const [name, route] of routes.filter(([name]) => !name.startsWith("elements-") && !name.startsWith("trash-"))) {
    await inspect(`${name}-narrow`, route, 390);
  }
  for (const [width, height] of [[1440, 900], [1366, 768], [1024, 768], [720, 450], [390, 844]]) {
    for (const kind of ["script", "compose"]) {
      await inspect(`${kind}-tools-${width}`, `/studio/${slug}/${kind}/${episode.id}`, width, height);
      for (const tool of ["shortcuts", "assistant", "queue"]) {
        const trigger = page.locator(`[data-tool-trigger="${tool}"]`);
        await trigger.click();
        const panel: Locator = page.locator(`[data-tool-panel="${tool}"]`);
        await panel.waitFor({ state: "visible" });
        await page.waitForFunction(name => document.querySelector(`[data-tool-panel="${name}"]`)?.contains(document.activeElement), tool);
        // A focusable panel can still sit outside the viewport or behind page cards.
        // Shortcuts uses BaseDialog's full-screen wrapper; inspect its actual card.
        const surface: Locator = tool === "shortcuts" ? panel.locator(":scope > div").last() : panel;
        const panelGeometry: { x: number; y: number; width: number; height: number; right: number; bottom: number; unobscured: boolean } = await surface.evaluate(el => {
          const rect = el.getBoundingClientRect();
          const points = [[rect.left + 12, rect.top + 12], [rect.left + rect.width / 2, rect.top + Math.min(30, rect.height / 2)], [rect.right - 12, rect.bottom - 12]];
          return { x: rect.left, y: rect.top, width: rect.width, height: rect.height,
            right: rect.right, bottom: rect.bottom,
            unobscured: points.every(([x, y]) => el.contains(document.elementFromPoint(x, y))) };
        });
        assert.ok(panelGeometry.width > 150 && panelGeometry.height > 80, `${kind}/${tool}/${width}: panel collapsed`);
        assert.ok(panelGeometry.x >= -1 && panelGeometry.y >= -1 && panelGeometry.right <= width + 1 && panelGeometry.bottom <= height + 1,
          `${kind}/${tool}/${width}: panel outside viewport ${JSON.stringify(panelGeometry)}`);
        assert.equal(panelGeometry.unobscured, true, `${kind}/${tool}/${width}: panel covered by page content`);
        if (width === 1440 || width === 390) await page.screenshot({ path: path.join(out, `tool-${kind}-${tool}-${width}.png`), fullPage: true });
        await page.keyboard.press("Tab");
        assert.equal(await panel.evaluate(el => el.contains(document.activeElement)), true);
        await page.keyboard.press("Escape");
        await panel.waitFor({ state: "hidden" });
        await page.waitForFunction(name => document.activeElement?.getAttribute("data-tool-trigger") === name, tool);
      }
      // Verify the actual side controls receive clicks, rather than merely measuring document width.
      const side: Locator = kind === "script" ? page.locator(".script-assistant-column") : page.locator(".compose-columns > div").last();
      const buttons: Locator = side.locator("button:visible:not(:disabled)");
      let hits = 0;
      for (const button of (await buttons.all()).slice(-5)) {
        await button.scrollIntoViewIfNeeded();
        await button.click({ trial: true });
        assert.equal(await button.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), true);
        hits++;
      }
      assert.ok(hits > 0, `${kind}: no sidebar controls exercised`);
      if (kind === "compose") {
        const checkbox: Locator = side.getByRole("checkbox").last();
        if (await checkbox.count()) { const initial: boolean = await checkbox.isChecked(); await checkbox.click(); assert.equal(await checkbox.isChecked(), !initial); await checkbox.click(); }
      }
      report.checks.push({ name: `${kind}-interaction-${width}`, width, height, sidebarHitTests: hits, toolKeyboardChecks: 3,
        zoomLayout: width === 720 ? "1440x900 at 200% equivalent CSS viewport; not native browser zoom" : "100%" });
    }
  }
  await inspect("studio-tablet", "/studio", 1024);
  await inspect("studio-narrow", "/studio", 390);
  await inspect("settings-narrow", "/settings", 390);
  await inspect("shot-stage-narrow", `/studio/${slug}/shot-stage/${episode.id}/${shot.id}`, 390);
  await inspect("not-found", "/unknown-browser-fixture", 1024);
  await page.getByRole("button", { name: "回到首页", exact: true }).click();
  await page.waitForURL(url => url.pathname === "/studio");
  await page.evaluate(() => {
    localStorage.setItem("browser-fixture.show-tour", "1");
    localStorage.removeItem("video-generate.onboarding.completed.v3");
  });
  await page.reload();
  await page.getByRole("button", { name: "下一步", exact: true }).waitFor();
  await inspect("welcome-introduction", "");
  await inspect("welcome-introduction-narrow", "", 390);
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await inspect("welcome-own-api", "");
  await page.getByRole("button", { name: "跳过，稍后配置", exact: true }).click();
  await inspect("welcome-create", "");
  await page.getByRole("button", { name: "创建示例系列", exact: true }).click();
  await page.getByText("示例系列已创建", { exact: true }).waitFor();
  await inspect("welcome-created", "");
  await page.getByRole("button", { name: "进入灵感箱", exact: false }).click();
  await page.waitForURL(url => url.pathname.endsWith("/inbox"));
  assert.equal(await page.evaluate(() => localStorage.getItem("video-generate.onboarding.completed.v3")), "demo_completed");
  report.checks.push({ name: "onboarding-creates-project-without-api-key", actualServerWrite: true, paidCalls: 0 });
  assert.equal(report.pageErrors.length, 0, report.pageErrors.join("\n"));
  const componentErrors = report.consoleErrors.filter(error => /\[ErrorBoundary\]|TypeError:|ReferenceError:|Maximum update depth/.test(error));
  assert.equal(componentErrors.length, 0, componentErrors.join("\n"));
  const unexpectedHttpErrors = report.httpErrors.filter(error =>
    !/^404 .*\/(?:cover-fallback|compose-file\/compose_manifest\.json)$/.test(error) &&
    !/^503 .*\/consistency-check$/.test(error) &&
    !/^503 .*\/script$/.test(error)); // Deliberate save-failure fixture in verifyCreatorWorkflow.
  assert.equal(unexpectedHttpErrors.length, 0, unexpectedHttpErrors.join("\n"));
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = error instanceof Error ? error.stack ?? error.message : String(error);
  if (page) await page.screenshot({ path: path.join(out, "failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  if (server) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server!.close(() => resolve()));
  }
  await fs.writeFile(path.join(out, "summary.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
