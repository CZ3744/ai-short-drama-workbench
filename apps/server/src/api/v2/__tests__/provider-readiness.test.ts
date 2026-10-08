import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import express from "express";
import { repoRoot } from "../../../../../../packages/core/src/paths";
import { crudRouter } from "../providerController/crud";
import {
  clearHealthCache, computeProviderStatus, getBuiltinPresets, setCachedHealth,
} from "../providerController/shared";

describe("Local model configuration readiness", () => {
  const originals = new Map<string, string>();
  let server: Server;
  let baseUrl = "";

  before(async () => {
    assert.equal(path.resolve(process.env.VIDEO_GENERATE_TEST_FIXTURE ?? ""), path.resolve(repoRoot),
      "This fixture may only modify the isolated safe-test copy");
    // Exercise the actual preset-to-API projection, including omitted and partial executors.
    for (const [kind, id, executor] of [
      ["image", "local_sdxl_openclaw", undefined],
      ["video", "local_animatediff_lightning_openclaw", { python_path: "private-runtime/python", script_path: "private-runtime/generate.py" }],
      ["tts", "local_gpt_sovits_openclaw", { python_path: "private-runtime/python", script_path: " " }],
    ] as const) {
      const filename = path.join(repoRoot, "config", "presets", `${kind}_provider.json`);
      const original = fs.readFileSync(filename, "utf8");
      originals.set(filename, original);
      const dict = JSON.parse(original);
      const option = dict.options.find((p: { id: string }) => p.id === id);
      assert.ok(option, `Fixture provider ${id} must exist`);
      delete option.executor;
      if (executor) option.executor = executor;
      fs.writeFileSync(filename, JSON.stringify(dict));
    }
    clearHealthCache();
    const app = express();
    app.use("/api/v2", crudRouter);
    await new Promise<void>(resolve => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    clearHealthCache();
    for (const [filename, original] of originals) fs.writeFileSync(filename, original);
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it("returns missing local executors as unconfigured while the demo card stays configured", async () => {
    const response = await fetch(`${baseUrl}/api/v2/providers/presets`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text.includes("private-runtime"), false, "Private executor paths must not leave the server");
    const { providers } = JSON.parse(text);
    for (const [kind, id] of [["image", "local_sdxl_openclaw"], ["tts", "local_gpt_sovits_openclaw"]]) {
      const model = providers[kind].find((p: { id: string }) => p.id === id);
      assert.equal(model.provider_status.configured, false);
      assert.equal(model.provider_status.healthy, false);
      assert.equal(model.provider_status.enabled_for_generation, false);
      assert.equal(model.provider_status.reason, "未配置本地执行器");
      assert.equal(model.quota.color, "gray");
    }
    const demo = providers.image.find((p: { id: string }) => p.id === "local_card_image");
    assert.equal(demo.provider_status.configured, true);
    assert.equal(demo.provider_status.tested, false);
    assert.equal(demo.provider_status.healthy, false);
  });

  it("requires a real health result after a complete executor configuration", () => {
    const provider = getBuiltinPresets().find(p => p.id === "local_animatediff_lightning_openclaw")!;
    const pending = computeProviderStatus(provider);
    assert.equal(pending.configured, true);
    assert.equal(pending.tested, false);
    assert.equal(pending.healthy, false);
    assert.equal(pending.enabled_for_generation, false);
    setCachedHealth(provider.id, { id: provider.id, ok: true, quota_state: "ok", last_checked_at: "2026-10-08T00:00:00.000Z" });
    const verified = computeProviderStatus({ ...provider, enabled: true });
    assert.equal(verified.tested, true);
    assert.equal(verified.healthy, true);
    assert.equal(verified.enabled_for_generation, true);
    assert.equal(verified.last_checked_at, "2026-10-08T00:00:00.000Z");
    assert.equal(computeProviderStatus({ ...provider, enabled: false }).enabled_for_generation, false);
  });

  it("does not let an earlier successful health check conceal missing executor configuration", () => {
    const provider = getBuiltinPresets().find(p => p.id === "local_sdxl_openclaw")!;
    setCachedHealth(provider.id, { id: provider.id, ok: true, quota_state: "ok", last_checked_at: "2026-10-08T00:00:00.000Z" });
    const status = computeProviderStatus(provider);
    assert.equal(status.tested, true, "Keep the actual test history");
    assert.equal(status.configured, false);
    assert.equal(status.healthy, false);
    assert.equal(status.enabled_for_generation, false);
    assert.equal(status.reason, "未配置本地执行器");
  });
});
