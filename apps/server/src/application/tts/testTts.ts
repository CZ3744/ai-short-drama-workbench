import { validate, TtsTestSchema } from "../../api/v2/validators";
import { getRegistry } from "../../api/v2/orchestration/_shared/registry";

import { loggerSync } from "../../../../../packages/core/src/logger";
import type {
  ProviderContext,
  TtsProvider,
  TtsSynthesizeResponse,
} from "../../../../../packages/providers/src/core/types";

export interface TestTtsInput {
  body: unknown;
}

export type TestTtsResult =
  | { kind: "validation"; status: number; errors: Array<{ path: string; message: string }> }
  | { kind: "error"; status: number; body: Record<string, unknown> }
  | { kind: "audio"; buffer: Buffer; mime: string };

export async function testTts(input: TestTtsInput): Promise<TestTtsResult> {
  const validated = validate(TtsTestSchema, input.body);
  if (!validated.ok) {
    return { kind: "validation", status: validated.status, errors: validated.errors };
  }
  const { voice_id, text, provider_id } = validated.data;

  const ttsProviderId = provider_id || "edge_tts";
  const registry = getRegistry();

  let ttsProv: TtsProvider;
  try {
    ttsProv = registry.getTts(ttsProviderId);
  } catch {
    return {
      kind: "error",
      status: 400,
      body: { error: { code: "UnknownProvider", message: `TTS provider "${ttsProviderId}" 未注册或不可用` } },
    };
  }

  // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 不设 AbortSignal.timeout(60_000).
  const providerCtx: ProviderContext = {
    series_slug: "tts_test",
    job_id: `tts_test_${Date.now().toString(36)}`,
    task_id: `task_tts_test_${Date.now().toString(36)}`,
    log: () => {},
  };

  // 2026-05-18 (红线 #1 禁伪 mock): 删除 edge_tts silent fallback chain.
  // 历史: 用户指定 provider_id="azure_tts" 试听, 失败时 silent 切 edge_tts 播放,
  // 响应不带 provider_used 字段 → 用户以为 azure 正常 → 后面真合成时才发现 azure 不可用.
  // 现: 用户选了哪个 provider 就用哪个, 失败直接返 503 + 真实错误, 用户能立即定位.
  let synthResult: TtsSynthesizeResponse | null = null;
  let lastErr = "";
  try {
    synthResult = await ttsProv.synthesize({ text, voice_id }, providerCtx);
  } catch (e: unknown) {
    lastErr = e instanceof Error ? e.message : String(e);
    loggerSync().warn(`[tts/test] ${ttsProviderId} synthesize failed:`, lastErr);
    synthResult = null;
  }

  if (!synthResult?.audio?.buffer) {
    return {
      kind: "error",
      status: 503,
      body: {
        error: {
          code: "TtsFailed",
          message: `TTS 试听失败 (provider: ${ttsProviderId}): ${lastErr || "无音频返回"}`,
          provider_id: ttsProviderId,
          voice_id,
        },
      },
    };
  }

  return {
    kind: "audio",
    buffer: synthResult.audio.buffer,
    mime: synthResult.audio.mime || "audio/mpeg",
  };
}
