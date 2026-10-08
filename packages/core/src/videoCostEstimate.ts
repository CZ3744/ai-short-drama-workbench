/**
 * Video Cost Estimate — 真实视频生成成本估算
 * 读取 config/video_cost_estimates.json 进行匹配
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./paths";

export interface VideoCostEntry {
  provider: string;
  model: string;
  resolution_tier?: string;
  duration?: number;
  estimated_cny: number;
  notes: string;
}

export interface CostEstimateResult {
  found: boolean;
  estimated_cny: number | null;
  currency: string;
  note: string;
}

let _cache: VideoCostEntry[] | null = null;

function loadCostEstimates(): VideoCostEntry[] {
  if (_cache !== null) return _cache;
  let result: VideoCostEntry[] = [];
  try {
    const filePath = join(repoRoot, "config", "video_cost_estimates.json");
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    result = data.estimates || [];
  } catch {
    result = [];
  }
  _cache = result;
  return result;
}

/**
 * 估算单次视频生成成本（CNY）
 */
export function estimateVideoCost(params: {
  provider: string;
  model: string;
  resolution_tier?: string;
  duration?: number;
}): CostEstimateResult {
  if (params.provider === "local_mock_video") {
    return { found: true, estimated_cny: 0, currency: "CNY", note: "本地模拟，完全免费。" };
  }

  const entries = loadCostEstimates();

  // Exact match: provider + model + resolution + duration
  const exact = entries.find(e =>
    e.provider === params.provider &&
    e.model === params.model &&
    (!params.resolution_tier || !e.resolution_tier || e.resolution_tier === params.resolution_tier) &&
    (!params.duration || !e.duration || e.duration === params.duration)
  );
  if (exact) {
    return { found: true, estimated_cny: exact.estimated_cny, currency: "CNY", note: exact.notes };
  }

  // Partial match: provider + model
  const partial = entries.find(e =>
    e.provider === params.provider && e.model === params.model
  );
  if (partial) {
    return { found: true, estimated_cny: partial.estimated_cny, currency: "CNY", note: partial.notes };
  }

  // Provider-only match
  const providerMatch = entries.find(e => e.provider === params.provider);
  if (providerMatch) {
    return { found: true, estimated_cny: providerMatch.estimated_cny, currency: "CNY", note: providerMatch.notes };
  }

  return {
    found: false,
    estimated_cny: null,
    currency: "CNY",
    note: "无法估算，请以平台账单为准。"
  };
}

/**
 * 格式化成本显示
 */
export function formatCostDisplay(result: CostEstimateResult): string {
  if (!result.found || result.estimated_cny === null) {
    return "预计成本：未知，请以平台账单为准。";
  }
  if (result.estimated_cny === 0) {
    return "预计成本：免费（本地模拟）";
  }
  return `预计成本：约 ¥${result.estimated_cny.toFixed(2)}（${result.note}）`;
}
