import { readSeries, listShots } from "../../api/v2/seriesStore";
import { getRegistry } from "../../api/v2/orchestration/_shared/registry";

import { budgetGuard } from "../../../../../packages/providers/src/core/budgetGuard";

export interface PreflightInput {
  body: unknown;
}

interface PreflightRequest {
  series_slug: string;
  episode_id: string;
  shot_ids: string[];
  action: "generate_first_frames" | "generate_videos";
  count_per_shot: number;
  provider_override?: string;
}

export interface PreflightResultBody {
  total_calls: number;
  estimated_cost_min_cny: number;
  estimated_cost_max_cny: number;
  estimated_duration_min_sec: number;
  estimated_duration_max_sec: number;
  budget_remaining_today_cny: number;
  budget_daily_cap_cny: number;
  blocked: boolean;
  block_reason?: string;
  unit_cost_cny: number;
  unit_cost_basis: "accurate" | "estimated";
}

export type PreflightResult =
  | { kind: "error"; status: number; body: Record<string, unknown> }
  | { kind: "json"; body: PreflightResultBody };

export async function preflight(input: PreflightInput): Promise<PreflightResult> {
  const body = input.body as PreflightRequest;
  const { series_slug, episode_id, shot_ids, action, count_per_shot, provider_override } = body;

  if (!series_slug || !episode_id || !shot_ids?.length || !action) {
    return {
      kind: "error",
      status: 400,
      body: { error: { code: "InvalidRequest", message: "缺少必填字段" } },
    };
  }

  const series = await readSeries(series_slug);
  if (!series) {
    return {
      kind: "error",
      status: 404,
      body: { error: { code: "NotFound", message: "Series 不存在" } },
    };
  }

  const shots = await listShots(series_slug, episode_id);
  const targetShots = shots.filter(s => shot_ids.includes(s.id));
  if (targetShots.length === 0) {
    return {
      kind: "error",
      status: 404,
      body: { error: { code: "NotFound", message: "没有匹配的 shot" } },
    };
  }

  // W7 (2026-05-15) — Bug 1: 不再 silent fallback 到 local_card_image / local_mock_video。
  // preflight 用于成本预估,如果用户既没传 override 也没设 series.defaults,
  // 说明还没选模型 — 直接当作未选,跳过 estimateCost,基于 unitCost=0 给出预估。
  // (UI 应在到这里之前就拦截"未选模型"的提交,这里只做防御性处理)
  const providerId = provider_override
    || (action === "generate_first_frames"
      ? series.defaults.image_provider_id
      : series.defaults.video_provider_id);

  const reg = getRegistry();
  let unitCostCny = 0;
  let unitCostBasis: "accurate" | "estimated" = "estimated";

  if (providerId) {
    try {
      if (action === "generate_videos") {
        const vp = reg.getVideo(providerId);
        if (vp.estimateCost) {
          const sampleDuration = targetShots.reduce((sum, s) => sum + (s.duration_sec || 5), 0) / targetShots.length;
          const est = vp.estimateCost({
            prompt: "",
            duration_sec: Math.round(sampleDuration),
            aspect_ratio: (series.defaults.aspect_ratio as "16:9" | "9:16" | "1:1" | "4:3" | "3:4") || "16:9",
          });
          unitCostCny = est.cny;
          unitCostBasis = est.basis;
        }
      } else {
        const ip = reg.getImage(providerId);
        if (ip.estimateCost) {
          const est = ip.estimateCost({ prompt: "", width: 1920, height: 1080, count: 1 });
          unitCostCny = est.cny;
          unitCostBasis = est.basis;
        }
      }
    } catch {
      unitCostCny = 0;
    }
  }

  const totalCalls = targetShots.length * count_per_shot;
  const estimatedCostBase = unitCostCny * totalCalls;
  const estimatedCostMinCny = Math.round(estimatedCostBase * 0.8 * 100) / 100;
  const estimatedCostMaxCny = Math.round(estimatedCostBase * 1.5 * 100) / 100;

  let estDurationSec: number;
  if (action === "generate_videos") {
    const totalDuration = targetShots.reduce((sum, s) => sum + (s.duration_sec || 5), 0);
    estDurationSec = totalDuration * count_per_shot;
  } else {
    estDurationSec = totalCalls * 30;
  }

  const limits = budgetGuard.getLimits();
  const dailyUsed = budgetGuard.getDailyUsed();
  const budgetRemaining = Math.max(0, limits.dailyCapCNY - dailyUsed);
  const blocked = estimatedCostMaxCny > budgetRemaining;

  return {
    kind: "json",
    body: {
      total_calls: totalCalls,
      estimated_cost_min_cny: estimatedCostMinCny,
      estimated_cost_max_cny: estimatedCostMaxCny,
      estimated_duration_min_sec: Math.round(estDurationSec * 0.8),
      estimated_duration_max_sec: Math.round(estDurationSec * 1.5),
      budget_remaining_today_cny: Math.round(budgetRemaining * 100) / 100,
      budget_daily_cap_cny: limits.dailyCapCNY,
      blocked,
      block_reason: blocked ? `预估最高 ¥${estimatedCostMaxCny.toFixed(2)} 超出今日剩余预算 ¥${budgetRemaining.toFixed(2)}` : undefined,
      unit_cost_cny: unitCostCny,
      unit_cost_basis: unitCostBasis,
    },
  };
}
