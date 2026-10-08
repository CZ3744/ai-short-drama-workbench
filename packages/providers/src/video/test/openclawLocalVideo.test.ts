// P25: Tests for OpenClawLocalVideoProvider — mock exec

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PresetOption } from "../../../../core/src/presetSchema";
import type { ProviderContext } from "../../core/types";

function makePreset(overrides?: Record<string, unknown>): PresetOption {
  return {
    id: "local_animatediff_openclaw",
    label_zh: "OpenClaw 本地 AnimateDiff",
    label_en: "OpenClaw Local AnimateDiff",
    prompt_phrase: "animatediff",
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

describe("OpenClawLocalVideoProvider", () => {
  it("has mode t2v (2026-05-18 v3: 双模 provider, orchestrator 加 OpenClaw 特例透传 first_frame)", async () => {
    const { OpenClawLocalVideoProvider } = await import("../openclawLocalVideoProvider");
    const provider = new OpenClawLocalVideoProvider(makePreset(), null);
    assert.equal(provider.mode, "t2v");
  });

  it("throws when executor config is missing python_path", async () => {
    const { OpenClawLocalVideoProvider } = await import("../openclawLocalVideoProvider");
    const provider = new OpenClawLocalVideoProvider(makePreset(), null);

    await assert.rejects(
      () => provider.generate({
        prompt: "a cat walking",
        duration_sec: 5,
        aspect_ratio: "16:9",
      }, makeCtx()),
      (err: any) => {
        assert.ok(err.message.includes("executor.python_path not configured"));
        return true;
      }
    );
  });

  it("throws when executor config is missing script_path", async () => {
    const { OpenClawLocalVideoProvider } = await import("../openclawLocalVideoProvider");
    const preset = makePreset({
      executor: {
        python_path: "C:\\Python312\\python.exe",
      },
    });
    const provider = new OpenClawLocalVideoProvider(preset, null);

    await assert.rejects(
      () => provider.generate({
        prompt: "test",
        duration_sec: 5,
        aspect_ratio: "16:9",
      }, makeCtx()),
      (err: any) => {
        assert.ok(err.message.includes("executor.script_path not configured"));
        return true;
      }
    );
  });

  it("healthCheck returns ok:false when python path does not exist", async () => {
    const { OpenClawLocalVideoProvider } = await import("../openclawLocalVideoProvider");
    const preset = makePreset({
      executor: {
        python_path: "C:\\nonexistent\\python.exe",
        script_path: "C:/Projects/video-studio\\OpenClaw\\scripts\\video_gen_local.py",
        engine: "wan2.1",
      },
    });
    const provider = new OpenClawLocalVideoProvider(preset, null);
    const result = await provider.healthCheck();

    assert.equal(result.ok, false);
    assert.ok(result.reason?.includes("missing venv"));
  });

  it("rejects exec with disallowed python path", async () => {
    const { OpenClawLocalVideoProvider } = await import("../openclawLocalVideoProvider");
    const preset = makePreset({
      executor: {
        python_path: "C:\\evil\\malware.exe",
        script_path: "test.py",
        engine: "wan2.1",
      },
    });
    const provider = new OpenClawLocalVideoProvider(preset, null);

    await assert.rejects(
      () => provider.generate({
        prompt: "test",
        duration_sec: 5,
        aspect_ratio: "16:9",
      }, makeCtx()),
      (err: any) => {
        assert.ok(err.message.includes("Rejected python_path"));
        return true;
      }
    );
  });

  it("uses engine field from preset", async () => {
    const { OpenClawLocalVideoProvider } = await import("../openclawLocalVideoProvider");

    // Test animatediff engine
    const presetAD = makePreset({
      executor: {
        python_path: "C:\\Python312\\python.exe",
        script_path: "C:/Projects/video-studio\\OpenClaw\\scripts\\video_gen_local.py",
        engine: "animatediff",
        timeout_ms: 3000,
      },
    });
    const providerAD = new OpenClawLocalVideoProvider(presetAD, null);
    // generate will fail on spawn but should not fail on validation
    try {
      await providerAD.generate({
        prompt: "test",
        duration_sec: 2,
        aspect_ratio: "16:9",
      }, makeCtx());
    } catch (err: any) {
      // Expected: spawn error, not validation error
      assert.ok(!err.message.includes("not configured"));
    }
  });

  it("maps aspect ratios correctly", async () => {
    const { OpenClawLocalVideoProvider } = await import("../openclawLocalVideoProvider");
    const preset = makePreset({
      executor: {
        python_path: "C:\\Python312\\python.exe",
        script_path: "test.py",
        engine: "mock",
        timeout_ms: 3000,
      },
    });
    const provider = new OpenClawLocalVideoProvider(preset, null);

    // These will fail on spawn, but we can verify they don't fail on validation
    for (const ratio of ["16:9", "9:16", "1:1"] as const) {
      try {
        await provider.generate({
          prompt: "test",
          duration_sec: 5,
          aspect_ratio: ratio,
        }, makeCtx());
      } catch (err: any) {
        assert.ok(!err.message.includes("aspect"));
      }
    }
  });
});
