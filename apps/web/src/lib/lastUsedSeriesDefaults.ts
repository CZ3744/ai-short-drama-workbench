// lastUsedSeriesDefaults — 记忆用户上次新建系列时填的常用参数.
//
// 用途: 仅作为"新建系列 / 批量生成"弹窗的默认值建议, 不强制, 不污染后端.
//   - CreateSeriesDialog / BatchSeriesDialog 打开时读, 用于 prefill
//   - 用户提交成功时写 (handleGenerate / handleSubmit 内调用)
//
// 红线: 不做任何真实选择决策; 仅 UX 建议.

import { createLastUsed } from "./lastUsedRegistry";

const KEY = "video-generate:last-used-series-defaults";

export interface LastUsedSeriesDefaults {
  platform?: string;
  style?: string;
  aspect_ratio?: string;
  duration_per_episode_sec?: number;
  /** CreateSeriesDialog 的内容类型: "short" | "skit" | "ad" */
  content_type?: string;
}

const registry = createLastUsed<LastUsedSeriesDefaults>({
  storageKey: KEY,
  serialize: (v) => JSON.stringify(v),
  deserialize: (raw) => {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as LastUsedSeriesDefaults;
  },
});

export function rememberLastUsedSeriesDefaults(defaults: LastUsedSeriesDefaults): void {
  registry.set(defaults);
}

export function getLastUsedSeriesDefaults(): LastUsedSeriesDefaults {
  return registry.get() ?? {};
}
