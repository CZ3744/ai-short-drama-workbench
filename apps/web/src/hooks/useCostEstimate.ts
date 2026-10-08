/**
 * useCostEstimate — 每个生成按钮旁显示"预计 ¥X.XX"
 *
 * 从 config/presets/{kind}_provider.json 读取 cost_per_image_cny / cost_per_second_cny，
 * 乘以 count/duration 预估总花费。
 *
 * 格式: "¥0.04"（精确，如已知单价）或 "约 ¥2.40"（近似，如视频时长可变）
 */
import { useMemo } from "react";
import imagePresets from "../../../../config/presets/image_provider.json";
import videoPresets from "../../../../config/presets/video_provider.json";

// ─── types ──────────────────────────────────────────────────────────

interface PresetOption {
  id: string;
  cost_per_image_cny?: number;
  cost_per_second_cny?: number;
  label?: string;
  [key: string]: unknown;
}
interface PresetFile {
  options?: PresetOption[];
}
const imagePresetsTyped = imagePresets as PresetFile;
const videoPresetsTyped = videoPresets as PresetFile;

export type CostKind = "image" | "video" | "tts";

export interface CostEstimate {
  /** 人民币数值，免费为 0 */
  cny: number;
  /** 展示文本，如 "免费"、"¥0.04"、"约 ¥2.40" */
  display: string;
}

// ─── alias mapping ──────────────────────────────────────────────────

/** 前端的简化 provider id → config presets 中的真实 id */
const PROVIDER_ALIAS_MAP: Record<string, string> = {
  jimeng: "jimeng_image_4",
  gpt_image: "openai_gpt_image_2",
  flux: "openrouter_flux_11_pro",
  gemini: "openrouter_gemini_image",
  local: "local_sdxl_openclaw",
  local_image: "local_sdxl_openclaw",
  local_mock: "local_mock_video",
  openrouter: "openrouter_gemini_image",
};

// ─── helpers ────────────────────────────────────────────────────────

function resolveId(kind: CostKind, providerId: string): string {
  if (PROVIDER_ALIAS_MAP[providerId]) return PROVIDER_ALIAS_MAP[providerId];
  return providerId;
}

/**
 * 从 config presets JSON 中读取单位成本。
 * 返回 null 表示该 provider 没有定价数据；
 * 返回 0 表示明确免费（如本地 provider）。
 */
function readUnitCost(kind: CostKind, providerId: string): number | null {
  const resolved = resolveId(kind, providerId);

  if (kind === "image") {
    const option = imagePresetsTyped.options?.find((o) => o.id === resolved);
    const cost = option?.cost_per_image_cny;
    return typeof cost === "number" ? cost : null;
  }

  if (kind === "video") {
    const option = videoPresetsTyped.options?.find((o) => o.id === resolved);
    const cost = option?.cost_per_second_cny;
    return typeof cost === "number" ? cost : null;
  }

  // TTS: 目前预设中无计费字段；Edge TTS 等主流为免费
  if (kind === "tts") {
    if (
      resolved === "edge_tts" ||
      resolved === "windows_sapi" ||
      resolved === "openclaw_local_tts" ||
      !resolved
    ) {
      return 0; // 免费
    }
    return 0; // 默认免费
  }

  return null;
}

// ─── hook ───────────────────────────────────────────────────────────

/**
 * 预估一次 AI 生成操作的成本（人民币）。
 *
 * @param kind      - "image" | "video" | "tts"
 * @param providerId - provider id（前端简写或真实 id 均可）
 * @param count      - 生成数量
 * @param duration   - 每单位时长（秒），仅对 video 有效；缺省按 5 秒估算
 */
export function useCostEstimate(
  kind: CostKind,
  providerId: string,
  count: number,
  duration?: number,
): CostEstimate {
  return useMemo(() => {
    const unitCost = readUnitCost(kind, providerId);

    // 无定价数据
    if (unitCost === null) {
      return { cny: 0, display: "" };
    }

    // 明确免费
    if (unitCost <= 0) {
      return { cny: 0, display: "免费" };
    }

    // 计算总价
    let cny: number;
    if (kind === "video") {
      const effectiveDuration = typeof duration === "number" && duration > 0 ? duration : 5;
      cny = count * effectiveDuration * unitCost;
    } else {
      cny = count * unitCost;
    }

    // 保留两位小数
    cny = Math.round(cny * 100) / 100;

    if (cny <= 0) {
      return { cny: 0, display: "免费" };
    }

    // 图像：单价确定 → 精确
    // 视频 / TTS：时长/字数浮动 → 加"约"
    const precise = kind === "image";
    const prefix = precise ? "" : "约 ";

    return { cny, display: `${prefix}¥${cny.toFixed(2)}` };
  }, [kind, providerId, count, duration]);
}

/**
 * 纯函数版：无需 react，可直接在非组件上下文中使用。
 * 等价于 useCostEstimate 的计算逻辑。
 */
export function calcCost(
  kind: CostKind,
  providerId: string,
  count: number,
  duration?: number,
): CostEstimate {
  const unitCost = readUnitCost(kind, providerId);

  if (unitCost === null) return { cny: 0, display: "" };
  if (unitCost <= 0) return { cny: 0, display: "免费" };

  let cny: number;
  if (kind === "video") {
    const effectiveDuration = typeof duration === "number" && duration > 0 ? duration : 5;
    cny = count * effectiveDuration * unitCost;
  } else {
    cny = count * unitCost;
  }

  cny = Math.round(cny * 100) / 100;
  if (cny <= 0) return { cny: 0, display: "免费" };

  const precise = kind === "image";
  const prefix = precise ? "" : "约 ";
  return { cny, display: `${prefix}¥${cny.toFixed(2)}` };
}

// ─── provider options for CostPanel comparison ──────────────────────

export interface ProviderCostOption {
  id: string;
  label: string;
  unitCost: number;
  notes?: string;
  isCurrent: boolean;
}

/**
 * 返回某个 kind 下所有有定价的 provider 列表，按单价升序。
 * 用于 CostPanel 的同质供应商对比。
 */
export function getProviderCostOptions(kind: CostKind, currentId: string): ProviderCostOption[] {
  const presets = kind === "image" ? imagePresetsTyped : videoPresetsTyped;
  const options = presets.options ?? [];

  return options
    .filter((o) => {
      const cost = kind === "image" ? o.cost_per_image_cny : o.cost_per_second_cny;
      return typeof cost === "number";
    })
    .map((o) => ({
      id: o.id,
      label: (typeof o.label_zh === "string" ? o.label_zh : typeof o.label_en === "string" ? o.label_en : o.id),
      unitCost: (kind === "image" ? o.cost_per_image_cny : o.cost_per_second_cny) as number,
      notes: typeof o.notes === "string" ? o.notes : undefined,
      isCurrent: o.id === currentId,
    }))
    .sort((a, b) => a.unitCost - b.unitCost);
}

/**
 * 返回当前 provider 的单位成本（元）。
 * 返回 null 表示无定价，0 表示免费。
 */
export function getUnitCost(kind: CostKind, providerId: string): number | null {
  return readUnitCost(kind, providerId);
}
