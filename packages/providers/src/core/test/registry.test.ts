// P20: ProviderRegistry tests

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ProviderRegistry, registerDefaults } from "../registry";
import type { PresetOption } from "../../../../core/src/presetSchema";
import type { LlmProvider, HealthCheckResult } from "../types";

function makePreset(id: string, overrides?: Partial<PresetOption>): PresetOption {
  return {
    id,
    label_zh: id,
    label_en: id,
    prompt_phrase: "",
    enabled: true,
    notes: "",
    default: false,
    ...overrides,
  };
}

class StubLlmProvider implements LlmProvider {
  readonly id: string;
  private _keyPresent: boolean;
  constructor(id: string, keyPresent: boolean) {
    this.id = id;
    this._keyPresent = keyPresent;
  }
  async complete() { return { text: "ok" }; }
  async healthCheck(): Promise<HealthCheckResult> {
    return this._keyPresent ? { ok: true } : { ok: false, reason: "missing key" };
  }
}

describe("ProviderRegistry", () => {
  let registry: ProviderRegistry;
  let getKeyCalls: string[];

  beforeEach(() => {
    getKeyCalls = [];
    registry = new ProviderRegistry({
      llmPresets: [
        makePreset("ikuncode_gpt55"),
        makePreset("mimo_v25pro"),
        makePreset("disabled_llm", { enabled: false }),
      ],
      imagePresets: [makePreset("local_card_image")],
      videoPresets: [makePreset("local_mock_video")],
      ttsPresets: [makePreset("edge_tts")],
      getKeyFor: (id) => {
        getKeyCalls.push(id);
        return id === "ikuncode_gpt55" ? "test-key-123" : null;
      },
    });
  });

  it("returns registered LLM provider", () => {
    registry.register("llm", "ikuncode_gpt55", (cfg, key) => new StubLlmProvider(cfg.id, !!key));
    const provider = registry.getLlm("ikuncode_gpt55");
    assert.equal(provider.id, "ikuncode_gpt55");
  });

  it("caches provider instances", () => {
    let created = 0;
    registry.register("llm", "ikuncode_gpt55", (cfg, key) => {
      created++;
      return new StubLlmProvider(cfg.id, !!key);
    });
    registry.getLlm("ikuncode_gpt55");
    registry.getLlm("ikuncode_gpt55");
    assert.equal(created, 1);
  });

  it("injects apiKey from getKeyFor", () => {
    let receivedKey: string | null = null;
    registry.register("llm", "ikuncode_gpt55", (cfg, key) => {
      receivedKey = key;
      return new StubLlmProvider(cfg.id, !!key);
    });
    registry.getLlm("ikuncode_gpt55");
    assert.equal(receivedKey, "test-key-123");
  });

  it("passes null key when getKeyFor returns null", () => {
    let receivedKey: string | null = "sentinel";
    registry.register("llm", "mimo_v25pro", (cfg, key) => {
      receivedKey = key;
      return new StubLlmProvider(cfg.id, !!key);
    });
    registry.getLlm("mimo_v25pro");
    assert.equal(receivedKey, null);
  });

  it("throws ProviderError for unregistered provider", () => {
    assert.throws(
      () => registry.getLlm("nonexistent"),
      (err: any) => err.name === "ProviderError" && err.code === "invalid_request"
    );
  });

  it("listAvailable returns correct info", () => {
    registry.register("llm", "ikuncode_gpt55", (cfg, key) => new StubLlmProvider(cfg.id, !!key));
    registry.register("llm", "mimo_v25pro", (cfg, key) => new StubLlmProvider(cfg.id, !!key));
    const list = registry.listAvailable("llm");
    assert.equal(list.length, 3);
    const ikun = list.find((p) => p.id === "ikuncode_gpt55")!;
    assert.equal(ikun.enabled, true);
    const disabled = list.find((p) => p.id === "disabled_llm")!;
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.reason, "disabled in presets");
  });

  it("registerDefaults wires Aliyun Wanx image preset to a real provider factory", () => {
    const imageRegistry = new ProviderRegistry({
      llmPresets: [],
      imagePresets: [makePreset("aliyun_wanx_26")],
      videoPresets: [],
      ttsPresets: [],
      getKeyFor: () => null,
    });
    registerDefaults(imageRegistry);

    const available = imageRegistry.listAvailable("image");
    assert.equal(available.find((p) => p.id === "aliyun_wanx_26")?.enabled, true);
    assert.equal(imageRegistry.getImage("aliyun_wanx_26").id, "aliyun_wanx_26");
  });
});
