import { validate, GenerateAllFirstFramesSchema } from "../../api/v2/validators";
import { readSeries } from "../../api/v2/seriesStore";
import { orchestrator } from "../../jobs/orchestrator";

export interface GenerateAllFirstFramesInput {
  slug: string;
  episodeId: string;
  body: unknown;
}

export interface RequestLog {
  info: (obj: Record<string, unknown>, message: string) => void;
}

export interface GenerateAllFirstFramesDeps {
  requestId?: string;
  requestLog?: RequestLog;
}

export type GenerateAllFirstFramesResult =
  | { kind: "validation"; status: number; errors: Array<{ path: string; message: string }> }
  | { kind: "error"; status: number; body: Record<string, unknown> }
  | { kind: "json"; body: Record<string, unknown> };

export async function generateAllFirstFrames(
  input: GenerateAllFirstFramesInput,
  deps: GenerateAllFirstFramesDeps,
): Promise<GenerateAllFirstFramesResult> {
  const v = validate(GenerateAllFirstFramesSchema, input.body);
  if (!v.ok) return { kind: "validation", status: v.status, errors: v.errors };

  // W7 (2026-05-15) — Bug 1: 批量首帧生成必须显式选了 image provider。
  // 批量场景看不到单 shot 的 image_model_ref(orchestrator 也只读 series.defaults),
  // 所以只校验 body.provider_override + series.defaults.image_provider_id 任一非空。
  const fromBody = v.data.provider_override;
  if (!(fromBody && fromBody.trim())) {
    const series = await readSeries(input.slug);
    const def = series?.defaults?.image_provider_id;
    if (!def || !def.trim()) {
      return {
        kind: "error",
        status: 400,
        body: {
          error: {
            code: "provider_not_selected",
            message: "请先在右上角选择图像模型,或在设置中配置默认图像模型",
          },
        },
      };
    }
  }

  deps.requestLog?.info(
    {
      action: "generate_first_frames",
      count_per_shot: v.data.count_per_shot,
      provider_override: v.data.provider_override,
    },
    "orchestrate first_frames",
  );

  const result = await orchestrator.orchestrate({
    series_slug: input.slug,
    episode_id: input.episodeId,
    action: "generate_first_frames",
    count_per_shot: v.data.count_per_shot,
    provider_override: v.data.provider_override,
    prompt_override: v.data.prompt_override,
    seed_override: v.data.seed,
    only_shot_ids: v.data.only_shot_ids,
    requestId: deps.requestId,
  });

  return { kind: "json", body: { ok: true, ...result } };
}
