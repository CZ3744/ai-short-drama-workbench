/** Run only through run-showcase.mjs: real UI/API, isolated data, no cloud calls. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import sharp from "sharp";
import { chromium, type Browser, type Page } from "playwright";
import { router } from "../apps/server/src/api/routes";
import { v2Router } from "../apps/server/src/api/v2";
import { localRequestGuard } from "../apps/server/src/middleware/localRequestGuard";
import { createEpisode, addShot, updateSeries, updateEpisode, createCharacter, updateCharacter } from "../apps/server/src/api/v2/seriesStore";
import { addAsset } from "../apps/server/src/repositories/assetRepo";
import { edgeTestEnvironment } from "./browser-test-environment.mjs";

assert.equal(process.env.NODE_ENV, "test");
assert.equal(path.resolve(process.env.VIDEO_GENERATE_TEST_FIXTURE ?? ""), process.cwd(), "Use the isolated showcase launcher");
const out = path.join(process.cwd(), "browser-results");
await fs.mkdir(out, { recursive: true });
const report = { status: "running", sample: "雨停之前 · 虚构咖啡馆故事", provenance: "Original SVG storyboard drawings; imported still-image clips; no AI generation", screenshots: [] as string[], checks: [] as string[], pageErrors: [] as string[], externalRequests: [] as string[], failure: "" };
let browser: Browser | undefined;
let server: Server | undefined;
let page: Page | undefined;
const run = promisify(execFile);

function drawing(index: number) {
  const rain = Array.from({ length: 17 }, (_, i) => `<path d="M${45 + i * 54} 55l-16 35 M${71 + i * 48} 134l-12 28"/>`).join("");
  const scene = index === 0 ? `
    <path d="M126 208h708v355H126z" fill="#f3dbc1"/><path d="M101 207l61-71h634l65 71z" fill="#b86242"/>
    <rect x="171" y="252" width="264" height="220" rx="6" fill="#ffe5a9"/><path d="M304 252v220 M171 362h264"/>
    <rect x="505" y="252" width="253" height="220" rx="6" fill="#405762"/><path d="M632 252v220 M505 362h253"/>
    <path d="M99 564h770 M90 601h800 M142 578h139 M423 578h255"/>
    <rect x="337" y="147" width="286" height="67" rx="4" fill="#faf0de"/><text x="480" y="190" text-anchor="middle" font-size="28" fill="#4e382b" stroke="none">雨停之前 · COFFEE</text>
    <path d="M572 505c0-71 94-71 94 0 M619 505v52 M619 557l-32 34 M619 557l30 34"/><circle cx="618" cy="458" r="18" fill="#d8b18a"/>
  ` : index === 1 ? `
    <rect x="95" y="137" width="286" height="335" rx="5" fill="#b3c8c4"/><path d="M239 138v335 M96 302h285"/>
    <path d="M415 350c15-100 145-100 166 0l38 142H386z" fill="#bc7151"/><circle cx="494" cy="214" r="52" fill="#f1ceb0"/>
    <path d="M442 212c-15-87 114-89 105 1l-21-31-66 10z" fill="#4b3e36"/><path d="M467 232q28 18 51-2"/>
    <path d="M398 368l-71 86 125 21 M580 366l78 82-130 31" fill="none"/>
    <path d="M99 486h768v41H99z" fill="#8c6a52"/><rect x="442" y="423" width="70" height="55" rx="8" fill="#faf0de"/><path d="M512 434q43 0 16 29h-16 M465 405q-14-19 0-31 M492 408q14-19 0-31"/>
    <path d="M172 529v90 M792 529v90"/>
  ` : `
    <rect x="130" y="126" width="703" height="353" rx="5" fill="#b3c8c4"/><path d="M481 126v353 M130 323h703"/><circle cx="712" cy="205" r="44" fill="#f6dda5"/>
    <path d="M93 521h793v33H93z" fill="#8c6a52"/><path d="M142 555v61 M818 555v61"/>
    <circle cx="303" cy="333" r="44" fill="#f1ceb0"/><path d="M250 337q-13-84 98-46l6 52-30-38-58 19z" fill="#4b3e36"/><path d="M234 474q2-102 129-94l44 124H214z" fill="#bc7151"/>
    <circle cx="649" cy="337" r="44" fill="#e0b58e"/><path d="M604 321q9-76 93-12l-4 36-32-37-55 30z" fill="#53473f"/><path d="M589 504l22-122q131-27 135 122z" fill="#647d79"/>
    <rect x="405" y="459" width="56" height="48" rx="7" fill="#faf0de"/><rect x="523" y="459" width="56" height="48" rx="7" fill="#faf0de"/>
    <path d="M301 407l88 64 M653 414l-63 57"/>
  `;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640"><rect width="960" height="640" fill="#eee5d7"/><g stroke="#51483e" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">${index === 0 ? `<g stroke="#99aaa9" stroke-width="2">${rain}</g>` : ""}${scene}</g><rect x="0" y="594" width="960" height="46" fill="#f8f3ea"/><text x="26" y="625" font-family="serif" font-size="18" fill="#655646">${["01 · 雨夜的暖光", "02 · 一杯热水", "03 · 等雨停的人"][index]}</text><text x="936" y="625" text-anchor="end" font-family="serif" font-size="16" fill="#655646">原创分镜草图 · 演示样例</text></svg>`;
}

try {
  const app = express();
  app.use(localRequestGuard("http://127.0.0.1:5173"));
  app.use(express.json({ limit: "50mb" }));
  app.get("/healthz", (_req, res) => res.json({ ok: true, fixture: true }));
  app.use("/api", router);
  app.use("/api/v2", v2Router);
  app.use(express.static(path.join(process.cwd(), "dist/web")));
  app.use((_req, res) => res.sendFile("index.html", { root: path.join(process.cwd(), "dist/web") }));
  app.use(((error, _req, res, _next) => res.status(error.status ?? 500).json({ error: { code: error.code, message: error.message } })) as express.ErrorRequestHandler);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server!.once("listening", resolve); server!.once("error", reject); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try { browser = await chromium.launch({ headless: true, timeout: 20000 }); }
  catch { browser = await chromium.launch({ channel: "msedge", headless: true, timeout: 20000, env: edgeTestEnvironment() }); }
  const context = await browser.newContext({ viewport: { width: 1600, height: 1050 }, locale: "zh-CN", reducedMotion: "reduce", serviceWorkers: "block" });
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === base || ["data:", "blob:"].includes(url.protocol)) return route.continue();
    report.externalRequests.push(`${url.origin}${url.pathname}`);
    await route.abort();
  });
  await context.addInitScript(() => localStorage.setItem("video-generate.onboarding.completed.v3", "demo_completed"));
  page = await context.newPage();
  page.setDefaultTimeout(18000);
  page.on("pageerror", error => report.pageErrors.push(error.message));
  async function post(endpoint: string, data: unknown) {
    const response = await context.request.post(`${base}${endpoint}`, { data });
    assert.ok(response.ok(), `${endpoint}: ${response.status()} ${await response.text()}`);
    return response.json();
  }
  async function capture(name: string) {
    await page!.locator("[data-sonner-toast]").waitFor({ state: "hidden", timeout: 15000 }).catch(async () => {
      assert.equal(await page!.locator("[data-sonner-toast]").count(), 0, "Wait for toast dismissal before capture");
    });
    await page!.evaluate(async () => { await document.fonts.ready; await Promise.all(Array.from(document.images).map(i => i.decode().catch(() => {}))); });
    assert.ok(await page!.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page!.screenshot({ path: path.join(out, name), fullPage: false });
    report.screenshots.push(name);
  }
  await page.goto(`${base}/studio`);
  await page.getByRole("button", { name: "新建系列", exact: true }).first().click();
  await page.getByPlaceholder("例如：雨夜咖啡馆 · 都市治愈短剧").fill("雨停之前");
  const creating = page.waitForResponse(r => new URL(r.url()).pathname === "/api/v2/series" && r.request().method() === "POST");
  await page.getByRole("button", { name: "创建系列", exact: true }).click();
  const created = await creating;
  assert.equal(created.status(), 201);
  const { series } = await created.json();
  const slug = series.slug as string;
  await updateSeries(slug, { synopsis: "一间雨夜咖啡馆，一杯没收钱的热水。三个镜头，讲一个关于等待与善意的小故事。", defaults: { ...series.defaults, aspect_ratio: "16:9", platform: "bilibili" } });
  report.checks.push("Create project through the actual dialog and API");
  const episode = await createEpisode(slug, { title: "第一集 · 为你留一盏灯" });
  const character = await createCharacter(slug, { name: "林夏", role: "lead", personality: "咖啡馆店主。说话轻缓，习惯用行动表达关心。" });
  const script = "# 雨停之前\n\n## 第一场 · 雨夜，咖啡馆外\n\n雨滴沿着玻璃滑落。街上的店铺逐一熄灯，转角的咖啡馆仍亮着暖黄色的光。一位收起雨伞的客人停在门前。\n\n## 第二场 · 柜台前\n\n林夏把翻到‘打烊’一面的木牌转回来，倒了一杯热水。她没有问客人要点什么，只把杯子推到桌边。\n\n林夏：进来等一会儿吧，雨就快停了。\n\n## 第三场 · 靠窗的位置\n\n两人坐在窗边。杯口的热气轻轻升起，雨声渐弱。客人终于露出一点笑意。\n\n客人：谢谢你，还留着这盏灯。\n\n林夏：总要有人等到雨停。";
  await updateSeries(slug, { script_md: script });
  await updateEpisode(slug, episode.id, { script_md: script });
  const artFiles: string[] = [];
  const clipFiles: string[] = [];
  const refs: string[] = [];
  for (let i = 0; i < 3; i++) {
    const png = path.join(process.cwd(), "data", "series", slug, "assets/images", `storyboard-${i + 1}.png`);
    await sharp(Buffer.from(drawing(i))).png().toFile(png);
    artFiles.push(png);
    const asset = await addAsset(slug, { series_slug: slug, kind: "image", tags: ["原创分镜草图", "演示样例"], path: `assets/images/storyboard-${i + 1}.png`, filename: `storyboard-${i + 1}.png`, mime: "image/png", size_bytes: (await fs.stat(png)).size });
    refs.push(asset.asset_id);
    const clip = path.join(process.cwd(), "data", "series", slug, "assets/videos", `storyboard-${i + 1}.mp4`);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-i", png, "-t", "4", "-vf", "scale=960:640", "-r", "24", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip], { windowsHide: true, timeout: 30000 });
    clipFiles.push(clip);
  }
  await updateCharacter(slug, character.id, { ref_image_ids: [refs[1]] });
  await page.goto(`${base}/studio/${slug}/elements/${character.id}`);
  await page.getByRole("button", { name: /设为代表图/ }).first().click();
  await page.getByRole("button", { name: "取消代表", exact: true }).first().waitFor();
  report.checks.push("Choose the character reference image through the real representative-image control");
  const shots = [];
  const titles = ["雨夜的暖光", "一杯热水", "等雨停的人"];
  const actions = ["雨滴划过玻璃。转角咖啡馆的灯亮着，一位客人收起雨伞，停在门前。", "林夏转回打烊木牌，把一杯热水轻轻推向客人。暖光落在杯口的蒸汽上。", "两人坐在靠窗的位置。雨声渐弱，杯口热气升起，客人露出一点笑意。"];
  for (let i = 0; i < 3; i++) {
    const shot = await addShot(slug, episode.id, { title: titles[i], action: actions[i], prompt_img: `${actions[i]}暖纸色分镜草图，简洁线条，柔和光线，16:9 构图。`, prompt_vid: "固定镜头，保持人物和场景布局，缓慢推进，动作自然克制。", duration_sec: 4, aspect_ratio: "16:9", shot_type: i === 0 ? "full_shot" : "medium", camera_movement: "push_in", character_ids: i ? [character.id] : [], reference_asset_ids: [], image_model_ref: "local_card_image", dialogue: i === 1 ? "进来等一会儿吧，雨就快停了。" : i === 2 ? "总要有人等到雨停。" : "", notes: "原创示意分镜；本演示使用导入素材，不代表 AI 生成效果。" });
    shots.push(shot);
    const importedImage = await post(`/api/v2/shots/${shot.id}/firstframe/import-image`, { image_base64: (await fs.readFile(artFiles[i])).toString("base64"), mime: "image/png", note: `${titles[i]} · 原创分镜草图` });
    if (i === 0) await updateEpisode(slug, episode.id, { cover_vault_id: importedImage.vault_id, synopsis: "关门之前，林夏为避雨的客人留了一盏灯。" });
    await post(`/api/v2/shots/${shot.id}/video/import-local`, { video_base64: (await fs.readFile(clipFiles[i])).toString("base64"), mime: "video/mp4", note: `${titles[i]} · 草图样片`, duration_sec: 4, width: 960, height: 640 });
    await page.goto(`${base}/studio/${slug}/shot-stage/${episode.id}/${shot.id}`);
    await page.getByRole("button", { name: "设首帧", exact: true }).first().click();
    await page.getByRole("button", { name: "已选定", exact: true }).first().waitFor();
  }
  report.checks.push("Import original images and local MP4s through real API; select each first frame through UI and verify automatically selected imported videos");

  await page.goto(`${base}/studio`);
  await page.getByText("雨停之前", { exact: true }).first().waitFor();
  await capture("01-studio.png");
  async function captureEditedScript() {
  await page!.goto(`${base}/studio/${slug}/script`);
  const editor = page!.locator(".script-editor-column [contenteditable=true]");
  await editor.waitFor();
  await editor.getByText("林夏：总要有人等到雨停。", { exact: true }).waitFor();
  const addition = "【导演笔记】让留白比对白更长一点。最后一镜停在两只杯子之间。";
  const saveResponse = page!.waitForResponse(response => response.request().method() === "PATCH" && decodeURIComponent(new URL(response.url()).pathname) === `/api/v2/series/${slug}/script` && response.request().postDataJSON()?.script_md?.includes(addition));
  await editor.click();
  await editor.press("Control+End");
  await editor.press("Enter");
  await page!.keyboard.insertText(addition);
  await page!.getByRole("button", { name: "立即保存", exact: true }).click();
  assert.ok((await saveResponse).ok());
  await page!.getByText("已自动保存", { exact: true }).waitFor();
  const saved = (await (await context.request.get(`${base}/api/v2/series/${slug}/script`)).json()).script.script_md;
  assert.ok(saved.includes("雨滴沿着玻璃滑落") && saved.includes(addition), "Original script and latest edit persist");
  assert.ok(saved.trimEnd().endsWith(addition), "Enter followed by typing appends the director note at the end, preserving the caret");
  await editor.press("Control+Home");
  await page!.locator("main").focus();
  await capture("02-script.png");
  report.checks.push("Edit actual script, save, verify latest text by API readback");
  }

  await page.goto(`${base}/studio/${slug}/storyboard/${episode.id}`);
  await page.getByRole("tab", { name: "九宫格", exact: true }).click();
  await page.getByText("雨夜的暖光", { exact: true }).first().scrollIntoViewIfNeeded();
  await capture("03-storyboard.png");
  await page.goto(`${base}/studio/${slug}/shot-stage/${episode.id}/${shots[1].id}`);
  await page.getByRole("button", { name: "审核后发送(首帧)", exact: true }).waitFor();
  const previewResponse = page.waitForResponse(response => response.url().includes("prompt-preview") && response.request().method() === "GET");
  await page.getByRole("button", { name: "审核后发送(首帧)", exact: true }).click();
  assert.ok((await previewResponse).ok());
  await page.getByRole("dialog").waitFor();
  await page.getByText("审核首帧提示词", { exact: true }).waitFor();
  await page.getByRole("dialog").locator("img").first().waitFor();
  await page.getByRole("dialog").getByRole("button", { name: "含 1 张图", exact: true }).waitFor();
  await page.getByRole("dialog").getByTitle("不让模型看这张", { exact: true }).click();
  assert.equal(await page.getByRole("dialog").getByRole("button", { name: "含 1 张图", exact: true }).count(), 0);
  await page.getByRole("dialog").getByTitle("重新加回参考图列表", { exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "含 1 张图", exact: true }).waitFor();
  await page.getByRole("dialog").locator("textarea").first().fill("雨夜咖啡馆，林夏把一杯热水轻轻推向客人。\n\n请参考附图的人物、服装与空间布局。中景构图，暖黄灯光，木质柜台；杯口蒸汽清晰，动作安静克制。\n\n这是单个镜头的首帧。保留窗外细雨，让画面右侧留出客人的位置。");
  await page.setViewportSize({ width: 1600, height: 1200 });
  await capture("04-prompt-review.png");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 1600, height: 1050 });
  report.checks.push("Open full prompt review, cancel and restore its actual representative image without duplication, edit text and close with Escape without generating");

  await page.goto(`${base}/studio/${slug}/compose/${episode.id}`);
  await page.getByText("合成设置", { exact: true }).waitFor();
  await page.getByRole("button", { name: "转场", exact: true }).click();
  const ratioSelect = page.getByText("画面比例", { exact: true }).locator("..").getByRole("combobox");
  await ratioSelect.filter({ hasText: "16:9 横屏" }).waitFor();
  assert.equal(await ratioSelect.innerText(), "16:9 横屏", "Series ratio selects the matching preset initially");
  for (const label of ["9:16 竖屏", "1:1 方形", "4:3", "3:4 竖屏", "16:9 横屏"]) {
    await ratioSelect.click();
    await page.getByRole("option", { name: label, exact: true }).click();
    assert.equal(await ratioSelect.innerText(), label);
  }
  await page.waitForFunction(key => JSON.parse(localStorage.getItem(key) ?? "{}").aspectRatio === "16:9", `video-generate.compose.settings:${slug}:${episode.id}`);
  await page.reload();
  await page.getByRole("button", { name: "转场", exact: true }).click();
  await ratioSelect.filter({ hasText: "16:9 横屏" }).waitFor();
  assert.equal(await ratioSelect.innerText(), "16:9 横屏", "Saved ratio remains selected after reload");
  await page.getByRole("button", { name: "配音", exact: true }).click();
  const composeResponse = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith(`/episodes/${episode.id}/compose`));
  await page.getByRole("button", { name: "合成成片", exact: true }).click();
  const queuedCompose = await composeResponse;
  assert.equal(queuedCompose.request().postDataJSON().aspect_ratio, "16:9");
  assert.ok(queuedCompose.ok(), `Compose response: ${queuedCompose.status()} ${await queuedCompose.text()}`);
  await page.getByRole("button", { name: "再合成一次", exact: true }).waitFor({ timeout: 120000 });
  await page.waitForFunction(() => { const video = document.querySelector("video"); return video && video.readyState >= 2 && video.duration > 0; }, undefined, { timeout: 30000 });
  await page.getByRole("button", { name: "播放", exact: true }).first().click();
  await page.waitForFunction(() => (document.querySelector("video")?.currentTime ?? 0) > 0.25);
  await page.getByRole("button", { name: "暂停", exact: true }).first().click();
  await page.locator("main").evaluate(element => { element.scrollTop = 0; });
  await capture("05-compose.png");
  report.checks.push("Select every aspect preset through UI; reload and verify saved selection; compose with the accepted 16:9 value, play and pause the actual result");
  const exportResponse = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith(`/episodes/${episode.id}/export`), { timeout: 120000 });
  await page.getByRole("button", { name: "导出 ZIP", exact: true }).click();
  const exported = await exportResponse;
  assert.ok(exported.ok(), `Export response: ${exported.status()} ${await exported.text()}`);
  const exportData = await exported.json();
  const archive = await fs.readFile(exportData.output_path);
  assert.equal(archive.subarray(0, 2).toString(), "PK");
  assert.ok(archive.length > 1000, "Real local ZIP output has content");
  await page.getByRole("button", { name: "打开输出文件夹", exact: true }).waitFor();
  report.checks.push("Export ZIP through UI, verify a real nonempty local ZIP and the output-folder action without opening a desktop window");
  await captureEditedScript();
  assert.equal(report.pageErrors.length, 0, report.pageErrors.join("\n"));
  assert.equal(report.externalRequests.length, 0, "No external requests permitted");
  for (const [from, to] of [["01-studio.png", "studio.png"], ["02-script.png", "script.png"], ["03-storyboard.png", "storyboard.png"], ["04-prompt-review.png", "prompt-review.png"], ["05-compose.png", "compose.png"]]) await fs.copyFile(path.join(out, from), path.join(out, to));
  report.status = "passed";
  await fs.writeFile(path.join(out, "README.md"), "# 真实界面展示素材\n\n这些截图由 `npm run build` 后运行 `node scripts/run-showcase.mjs` 生成。使用一次性空配置、空凭据和独立数据库，不读取用户作品。\n\n咖啡馆故事为虚构样例；图像为脚本内原创 SVG 分镜草图，视频为草图制作的本地静态片段，均明确标注样例。没有调用 AI 图像、视频或语音服务，不用于证明模型成片质量。\n\n截图展示真实页面和实际持久化数据；交互核验结果见 summary.json。截图没有通过 DOM 修改、隐藏错误或替换页面文字来美化。\n");
} catch (error) {
  report.status = "failed";
  report.failure = error instanceof Error ? error.stack ?? error.message : String(error);
  if (page) await page.screenshot({ path: path.join(out, "failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(out, "summary.json"), JSON.stringify(report, null, 2));
  await browser?.close();
  await new Promise<void>(resolve => { if (server) { server.closeAllConnections(); server.close(() => resolve()); } else resolve(); });
}
