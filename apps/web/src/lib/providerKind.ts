import { parseProviderFromModelRef } from "./modelRef";

/**
 * providerKind — 前端 provider 类型判断 helper (Wave 4-D, 2026-05-16).
 *
 * 用途:
 *   - useVideoGeneration / useImageGeneration 内部判断"要不要弹 dry-run + 二级确认"
 *   - 任何 caller 都不直接判断 provider id 字符串, 一律走本 helper
 *
 * 解耦约束 (memory feedback_decoupling.md):
 *   - 全前端 isRealVideoProvider 只在此处定义, 其他文件 import 使用
 *   - 真实视频 provider 列表必须与后端 packages/core/src/realVideoLock.ts:29-36
 *     完全一致 (6 个). 后端列表是 source of truth — 前端列表纯前端 UX 判断用,
 *     真正锁占用仍由后端 realVideoLock.acquireRealLock 决定 (HTTP 409 / dry-run
 *     返回 real_lock_held_by).
 *
 * 配置参考:
 *   - 后端: packages/core/src/realVideoLock.ts (REAL_VIDEO_PROVIDERS)
 *   - presets: config/presets/video_provider.json
 */

/**
 * 真实视频 provider id 集合 — 必须与 realVideoLock.ts:29-36 完全一致 (6 个).
 *
 * 若后端新增真实视频 provider, 同步在此处加一行 (零 caller 变更).
 */
const REAL_VIDEO_PROVIDERS = new Set([
  "minimax_hailuo",
  "aliyun_wan_t2v",
  "jimeng_video_3pro",
  "jimeng_video_3_720p",
  "kling_3",
  "vidu_q3_ref",
  "zhipu_cogvideox",
  "baidu_qianfan_video",
  "tencent_hunyuan_video",
]);

/**
 * 从 provider id 或 model_ref ("provider_id:model_id") 抽出 provider id.
 * - 输入 "minimax_hailuo"               → "minimax_hailuo"
 * - 输入 "minimax_hailuo:hailuo-02-pro" → "minimax_hailuo"
 * - 输入 ""/undefined/null              → null
 */
function extractProviderId(providerOrModelRef: string | undefined | null): string | null {
  return parseProviderFromModelRef(providerOrModelRef) ?? null;
}

/**
 * 是否为"会扣费 + 占用真实锁"的视频 provider.
 *
 * 入参可以是:
 *   - 裸 provider id ("minimax_hailuo")
 *   - 完整 model_ref ("minimax_hailuo:hailuo-02-pro")
 *   - instance 前缀 ("instance:vmi_xxx:cogvideox-3")  ← 2026-05-27 audit P0 #1 加
 *
 * UI 用法:
 *   if (isRealVideoProvider(modelRef)) → 在按钮上加 "真实¥" 标记 + 弹二级确认
 *
 * 2026-05-27 audit P0 #1: instance: 前缀之前直接走 parseProviderFromModelRef 拿到
 * "instance" 字符串, REAL_VIDEO_PROVIDERS 不命中 → 返 false → 用户用 instance 配的
 * 真实付费 provider (kling/智谱/etc) 直接绕过二级确认 silent 扣费. 修法: 任何
 * instance: 前缀的 model_ref 保守判 true (instance 几乎必然指向真实付费 provider,
 * 本地 mock 不需要 instance 配), 让用户至少看到弹窗确认. 后端 videoDryRun 仍会精确
 * 判 is_real_provider 让弹窗里显示真相.
 */
export function isRealVideoProvider(
  providerOrModelRef: string | undefined | null,
): boolean {
  if (typeof providerOrModelRef === "string" && providerOrModelRef.trim().startsWith("instance:")) {
    return true;
  }
  const pid = extractProviderId(providerOrModelRef);
  return pid !== null && REAL_VIDEO_PROVIDERS.has(pid);
}
