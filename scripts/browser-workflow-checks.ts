import assert from "node:assert/strict";
import type { Page } from "playwright";

/** Real isolated API writes; intercepted failures and slow responses never reach paid services. */
export async function verifyCreatorWorkflow(options: {
  page: Page;
  base: string;
  slug: string;
  inspect: (name: string, route: string) => Promise<void>;
  checks: Array<Record<string, unknown>>;
}) {
  const { page, base, slug, inspect, checks } = options;
  const endpoint = `${base}/api/v2/series/${encodeURIComponent(slug)}/script`;
  const route = `/studio/${encodeURIComponent(slug)}/script`;
  const original = "雨夜，咖啡馆快要打烊。林夏看见门外的陌生人，轻轻把灯重新打开。";
  const first = `${original} 她递出一杯热水。`;
  const latest = `${first} 窗外雨声渐小，陌生人终于讲出了来意。`;
  assert.ok((await page.request.patch(endpoint, { data: { script_md: original } })).ok());
  await page.goto(`${base}${route}`);
  const editor = page.locator(".script-editor-column [contenteditable=true]");
  await editor.waitFor();
  let releaseFirst!: () => void;
  let sawFirst!: () => void;
  const firstSeen = new Promise<void>(resolve => { sawFirst = resolve; });
  const hold = new Promise<void>(resolve => { releaseFirst = resolve; });
  let held = false;
  await page.route(endpoint, async request => {
    if (request.request().method() === "PATCH" && !held) {
      held = true;
      sawFirst();
      await hold;
    }
    await request.continue();
  });
  await editor.fill(first);
  await page.getByRole("button", { name: "立即保存", exact: true }).click();
  await firstSeen;
  await editor.fill(latest);
  const latestSaved = page.waitForResponse(response => response.url() === endpoint && response.request().method() === "PATCH" && response.request().postDataJSON().script_md === latest);
  releaseFirst();
  assert.ok((await latestSaved).ok());
  await page.getByText("已自动保存", { exact: true }).waitFor();
  assert.equal((await (await page.request.get(endpoint)).json()).script.script_md, latest);
  await page.unroute(endpoint);
  await inspect("script-latest-edit-persisted", "");
  checks.push({ name: "script-inflight-save-drains-latest-edit", actualServerReadback: true });

  const unsaved = `${latest} 这段文字用于验证保存失败后的草稿恢复。`;
  await page.route(endpoint, async request => {
    if (request.request().method() !== "PATCH") return request.continue();
    await request.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "WorkflowSaveFailureFixture", message: "隔离测试：暂时无法保存，请重试" } }) });
  });
  await editor.fill(unsaved);
  await page.getByRole("button", { name: "立即保存", exact: true }).click();
  await page.getByRole("button", { name: "重试保存", exact: true }).waitFor();
  await inspect("script-save-failure-recovery", "");
  await page.getByRole("button", { name: "灵感箱", exact: true }).click();
  assert.equal(new URL(page.url()).pathname, route, "failed persistence must stop the page's navigation action");
  page.once("dialog", dialog => void dialog.accept());
  await page.reload();
  await page.getByRole("button", { name: "恢复草稿", exact: true }).waitFor();
  assert.equal((await (await page.request.get(endpoint)).json()).script.script_md, latest, "recovery must not overwrite saved content without a click");
  await inspect("script-recovered-draft-choice", "");
  await page.unroute(endpoint);
  await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
  await page.getByRole("button", { name: "立即保存", exact: true }).click();
  await page.getByText("已自动保存", { exact: true }).waitFor();
  assert.equal((await (await page.request.get(endpoint)).json()).script.script_md, unsaved);
  checks.push({ name: "script-failure-blocks-navigation-and-recovers-after-reload", actualServerReadback: true });

  const versionsEndpoint = `${base}/api/v2/series/${encodeURIComponent(slug)}/script-versions`;
  const versionA = await page.request.post(versionsEndpoint, { data: { title: "雨夜初稿", content_md: original, activate: true } });
  assert.equal(versionA.status(), 201);
  assert.equal((await page.request.post(versionsEndpoint, { data: { title: "雨夜修订稿", content_md: latest, activate: true } })).status(), 201);
  await page.reload();
  await editor.waitFor();
  const workInProgress = `${latest} 这是切换版本前尚未另存的修改。`;
  await editor.fill(workInProgress);
  await page.getByRole("button", { name: "剧本版本切换器", exact: true }).click();
  await page.getByRole("menuitem").filter({ hasText: "雨夜初稿" }).click();
  await page.waitForFunction(expected => document.querySelector(".script-editor-column [contenteditable=true]")?.textContent === expected, original);
  const versions = (await (await page.request.get(versionsEndpoint)).json()).versions as Array<{ content_md: string; title: string }>;
  assert.ok(versions.some(version => version.title === "切换前的剧本备份" && version.content_md === workInProgress));
  assert.equal((await (await page.request.get(endpoint)).json()).script.script_md, original);
  await inspect("script-version-switch-with-backup", "");
  checks.push({ name: "script-version-switch-refreshes-editor-and-preserves-edits", actualServerReadback: true });
}
