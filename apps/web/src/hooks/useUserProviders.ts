// useUserProviders — 拉用户配置的 provider 实例, 按 modality 分桶.
//
// 设计:
//   - 走 GET /api/v2/providers/presets (内置 + 自定义合并)
//   - 适配层把 legacy `kind: "llm"|"image"|"video"|"tts"` 映射到新 schema 的
//     modality `text|image|video|tts` (cc-switch v4).
//   - 2026-05-15 W3-B T3: 加 tts 桶, 让 ModelPicker 也能选 TTS provider,
//     从而 ComposePage 不再依赖 deprecated ModelProviderSelect.
//   - SWR 共享 key "user:providers", 多个 ModelPicker 同页只发一次请求.
//   - 不做 mutate, refresh() 强制刷新即可.
//
// 红线: 不知道业务实体, 不返回默认值. 调用方拿到 list 后自己决定显示什么.

import useSWR from "swr";
import { apiGet } from "../lib/api";
import type { PresetsGroupedResponse, ProviderWithQuota } from "../lib/api";
import { listVideoModelInstances, type VideoModelInstance } from "../lib/videoModelInstancesApi";

/**
 * 用户视角的 provider 实例. 给 ModelPicker 用.
 *
 * 数据来源: GET /api/v2/providers (builtin + custom 合并). 字段与 providerController.ts
 * 里的 ProviderConfig 保持一致, 不暴露 api_key 等敏感信息. 仅暴露下拉里需要的 id / label / model.
 */
export interface UserProvider {
  /** instance_id (UUID 或 legacy provider id 例 "ikuncode_gpt55"). model_ref 用 "<id>:<model>". */
  id: string;
  /** 用户起的中文名. 显示在下拉里. */
  label: string;
  /** 该 instance 的默认 model. 没设置则空字符串. */
  model: string;
  /** legacy kind ("llm"|"image"|"video"|"tts") — 给 ModelPicker 显示用. */
  kind: string;
  /** 是否启用. 禁用的 ModelPicker 不显示. */
  enabled: boolean;
  /** Key 是否已配置. 没配 Key 下拉项可点但 UI 标灰提示. */
  key_present: boolean;
  /** 可选: 拉过模型列表缓存. ModelPicker 暂时不用, 留作未来 sub-menu. */
  model_list?: string[];
  /**
   * 二级菜单分组键 (2026-05-18: 视频渠道二级架构).
   * - video: "可灵 AI" / "Vidu" / "即梦" / "海螺" / "万相" / "本地与 Mock" / "其他"
   * - 其他 kind: 留空, ModelPicker 不分组
   * 不存原始 channel id (例 "kling"), 直接存中文 label 供 <optgroup label> 显示
   */
  group?: string;
}

export interface UseUserProvidersResult {
  providers: {
    text: UserProvider[];
    image: UserProvider[];
    video: UserProvider[];
    tts: UserProvider[];
  };
  isLoading: boolean;
  error: Error | null;
  refresh: () => void;
}

// legacy "llm" kind 对应新 schema modality "text".
function legacyKindToModality(k: string): "text" | "image" | "video" | "tts" | null {
  if (k === "llm" || k === "text") return "text";
  if (k === "image") return "image";
  if (k === "video") return "video";
  if (k === "tts") return "tts";
  return null;
}

function toUserProvider(p: ProviderWithQuota): UserProvider {
  // legacy mask: api_key 字段被 server 抹成 "*****" 当存在, 空串当不存在.
  // server `maskApiKey` 把已设置的 key 替换成固定的 `***`, 未设置时为 undefined.
  const key_present = p.provider_status?.configured ?? !!(p.api_key && p.api_key.length > 0);
  return {
    id: p.id,
    label: p.label_zh ?? p.id,
    model: p.model_id ?? "",
    kind: p.kind,
    enabled: p.enabled !== false, // undefined 视为启用
    key_present,
    model_list: p.model_list_cache,
  };
}

export function useUserProviders(): UseUserProvidersResult {
  const { data, error, isLoading, mutate } = useSWR<PresetsGroupedResponse>(
    "user:providers",
    () => apiGet<PresetsGroupedResponse>("/api/v2/providers/presets"),
    { revalidateOnFocus: false, refreshInterval: 60_000 },
  );

  // 2026-05-18: 5 真实视频渠道二级架构 — 视频实例独立桶, 优先显示在 ModelPicker video 下拉里
  const { data: viData, mutate: mutateInstances } = useSWR(
    "user:video-instances",
    () => listVideoModelInstances(),
    { revalidateOnFocus: false, refreshInterval: 60_000 },
  );

  const buckets = {
    text: [] as UserProvider[],
    image: [] as UserProvider[],
    video: [] as UserProvider[],
    tts: [] as UserProvider[],
  };
  if (data?.providers) {
    const allProviders = [
      ...(data.providers.llm ?? []),
      ...(data.providers.image ?? []),
      ...(data.providers.video ?? []),
      ...(data.providers.tts ?? []),
    ];
    for (const p of allProviders) {
      const m = legacyKindToModality(p.kind);
      if (!m) continue;
      // 5 个真实视频 channel 的 builtin id 隐藏 (改由 instances 表呈现, 防止重复出现)
      if (m === "video" && LEGACY_VIDEO_PROVIDER_IDS.has(p.id)) continue;
      const up = toUserProvider(p);
      // 视频桶:剩余的内置 / 本地 / mock 归入"本地与 Mock"组,展示在二级菜单底部
      if (m === "video") {
        up.group = guessBuiltinVideoGroup(p.id);
      }
      buckets[m].push(up);
    }
  }

  // 把视频 instance 注入视频桶最前 (二级架构优先)
  if (viData?.instances) {
    const channelLabel: Record<string, string> = {
      kling: "可灵 AI",
      vidu: "Vidu",
      jimeng: "即梦 (火山)",
      minimax: "MiniMax 海螺",
      aliyun_wan: "阿里万相",
      // 2026-05-20 Wave T S25 — 3 个 builtin 升 instance 架构
      zhipu: "智谱 CogVideoX",
      baidu_qianfan: "百度千帆",
      tencent_hunyuan: "腾讯混元",
    };
    const instanceProviders: UserProvider[] = viData.instances.map((inst: VideoModelInstance) => ({
      // model_ref 形态: "instance:<id>" — ModelPicker buildModelRef 会拼上 ":<model>" 给后端 modelRef.ts
      // resolve. 因此 id="instance" + model=inst.id, 后端 providerIdFromModelRef -> "instance" +
      // modelIdFromModelRef -> inst.id. 见 videoGenerationService 的 instance 分支.
      id: `instance:${inst.id}`,
      // 2026-05-18: 二级菜单架构 — label 不再带 channel 前缀, channel 由 <optgroup> 显示
      label: inst.display_name,
      model: inst.model_id,
      kind: "video",
      enabled: inst.api_key_present,
      key_present: inst.api_key_present,
      group: channelLabel[inst.channel] ?? inst.channel,
    }));
    // 实例放最前 (channel 分组在前, 内置在后)
    buckets.video = [...instanceProviders, ...buckets.video];
  }

  return {
    providers: buckets,
    isLoading,
    error: (error as Error | undefined) ?? null,
    refresh: () => {
      void mutate();
      void mutateInstances();
    },
  };
}

/** 2026-05-18: 这些 builtin video provider id 已被二级架构取代, 不在 ModelPicker 显示 */
const LEGACY_VIDEO_PROVIDER_IDS = new Set([
  "kling_3",
  "vidu_q3_ref",
  "jimeng_video_3pro",
  "jimeng_video_3_720p",
  "minimax_hailuo",
  "aliyun_wan_t2v",
  // 2026-05-20 Wave T S25 — 3 个 builtin 升 instance 架构后,通用 Picker 列表也隐藏
  "zhipu_cogvideox",
  "baidu_qianfan_video",
  "tencent_hunyuan_video",
]);

/**
 * 2026-05-18: 二级菜单分组 — 把剩余的内置 / 本地 / mock 视频 provider 按视觉归组.
 * - local_mock_video / 任何 mock_ 前缀 → "本地与 Mock"
 * - openclaw_* → "本地与 Mock" (OpenClaw 本地 AnimateDiff)
 * - zhipu / tencent / baidu → "其他云服务" (这 3 个还没升级到 instance 架构)
 * - 其他未知 → "其他"
 */
function guessBuiltinVideoGroup(providerId: string): string {
  const id = providerId.toLowerCase();
  if (id.includes("mock") || id.includes("local") || id.startsWith("openclaw")) return "本地与 Mock";
  if (id.startsWith("zhipu")) return "其他云服务";
  if (id.startsWith("tencent")) return "其他云服务";
  if (id.startsWith("baidu") || id.startsWith("qianfan")) return "其他云服务";
  return "其他";
}

/**
 * 单实例查询. 用于在业务实体 (Shot/Episode/Generation) 上有 model_ref 时, 反查 instance label.
 *
 * 返回 null 表示: instance_id 为空, 或者已被用户删除 / 禁用.
 */
export function useUserProvider(instance_id: string | null | undefined): UserProvider | null {
  const { providers } = useUserProviders();
  if (!instance_id) return null;
  for (const m of ["text", "image", "video", "tts"] as const) {
    const hit = providers[m].find((p) => p.id === instance_id);
    if (hit) return hit;
  }
  return null;
}
