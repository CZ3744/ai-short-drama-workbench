// P25: Tests for OpenClawLocalImageProvider — mock exec

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PresetOption } from "../../../../core/src/presetSchema";
import type { ProviderContext } from "../../core/types";

function makePreset(overrides?: Record<string, unknown>): PresetOption {
  return {
    id: "local_sdxl_openclaw",
    label_zh: "OpenClaw 本地 SDXL",
    label_en: "OpenClaw Local SDXL",
    prompt_phrase: "sdxl",
    enabled: true,
    notes: "",
    default: false,
    ...overrides,
  } as PresetOption;
}

function makeCtx(overrides?: Partial<ProviderContext>): ProviderContext {
  return {
    series_slug: "test",
    job_id: "job-1",
    task_id: "task-1",
    log: () => {},
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("OpenClawLocalImageProvider", () => {
  it("throws when executor config is missing", async () => {
    const { OpenClawLocalImageProvider } = await import("../openclawLocalImageProvider");
    const provider = new OpenClawLocalImageProvider(makePreset(), null);

    await assert.rejects(
      () => provider.generate({
        prompt: "a red circle",
        width: 1024,
        height: 1024,
        count: 1,
      }, makeCtx()),
      (err: any) => {
        assert.equal(err.code, "invalid_request");
        assert.equal(err.retriable, false);
        assert.match(err.message, /本地 SDXL.*设置/);
        assert.ok(!err.message.includes("executor.python_path"));
        return true;
      }
    );
  });

  it("healthCheck returns ok:false when python path does not exist", async () => {
    const { OpenClawLocalImageProvider } = await import("../openclawLocalImageProvider");
    const preset = makePreset({
      executor: {
        python_path: "C:\\nonexistent\\python.exe",
        script_path: "C:/Projects/video-studio\\OpenClaw\\scripts\\imggen_local.py",
      },
    });
    const provider = new OpenClawLocalImageProvider(preset, null);
    const result = await provider.healthCheck();

    assert.equal(result.ok, false);
    assert.ok(result.reason?.includes("missing venv"));
  });

  it("healthCheck returns ok:false with reason when python is not a valid executable", async () => {
    const { OpenClawLocalImageProvider } = await import("../openclawLocalImageProvider");
    const preset = makePreset({
      executor: {
        python_path: "C:\\Windows\\System32\\cmd.exe", // exists but not python
        script_path: "test.py",
      },
    });
    const provider = new OpenClawLocalImageProvider(preset, null);
    const result = await provider.healthCheck();
    assert.equal(result.ok, false);
  });

  it("rejects exec with disallowed python path", async () => {
    const { OpenClawLocalImageProvider } = await import("../openclawLocalImageProvider");
    const preset = makePreset({
      executor: {
        python_path: "C:\\evil\\malware.exe",
        script_path: "test.py",
      },
    });
    const provider = new OpenClawLocalImageProvider(preset, null);

    await assert.rejects(
      () => provider.generate({
        prompt: "test",
        width: 1024,
        height: 1024,
        count: 1,
      }, makeCtx()),
      (err: any) => {
        assert.ok(err.message.includes("Rejected python_path"));
        return true;
      }
    );
  });

  it("passes validation with correct config (spawn fails on missing python)", async () => {
    const { OpenClawLocalImageProvider } = await import("../openclawLocalImageProvider");
    const preset = makePreset({
      executor: {
        python_path: "C:\\Python312\\python.exe",
        script_path: "C:/Projects/video-studio\\OpenClaw\\scripts\\imggen_local.py",
        default_model_variant: "dreamshaper",
        steps: 8,
        default_negative_prompt: "blurry, bad quality",
        timeout_ms: 5000,
      },
    });
    const provider = new OpenClawLocalImageProvider(preset, null);

    // This will fail because python.exe doesn't exist at that path,
    // but it should NOT fail on validation.
    try {
      await provider.generate({
        prompt: "a beautiful landscape with mountains and rivers",
        negative_prompt: "ugly, blurry",
        width: 1024,
        height: 1024,
        count: 1,
        seed: 42,
      }, makeCtx());
    } catch (err: any) {
      // Should be a spawn/server error, not a validation error
      assert.ok(!err.message.includes("not configured"), `Unexpected validation error: ${err.message}`);
    }
  });
});
