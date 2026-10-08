/**
 * series-detail/utils.ts — SeriesDetail 页用纯函数集
 *
 * Wave P2 #15 抽出: 把 SeriesDetail.tsx 内联 helpers 集中,
 * 让主入口只保留数据装载 / 路由 / 渲染骨架.
 *
 * 这里全是纯函数, 没有 React import, 方便单测 + 复用.
 */

import { ROUTES } from "../../lib/routes";
import type { EpisodeRecord } from "../../lib/api";
import { formatDuration as _formatDuration } from "../../lib/format";

export type EpStatus = "draft" | "generating" | "picked" | "ready" | "approved" | "failed";

export function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function pickCoverClass(slug: string): string {
  const idx = (hashStr(slug) % 6) + 1;
  return `mk-cover-${idx}`;
}

export function pickThumbClass(n: number): string {
  const idx = (n % 7) + 1;
  return `mk-thumb--photo-${idx}`;
}

export function resolveEpisodeRoute(slug: string, epId: string, pathname: string): string {
  if (pathname.includes("/storyboard/")) return ROUTES.storyboard(slug, epId);
  if (pathname.includes("/storyboard")) return ROUTES.storyboard(slug, epId);
  if (pathname.includes("/script")) return ROUTES.script(slug);
  if (pathname.includes("/compose/")) return ROUTES.compose(slug, epId);
  if (pathname.includes("/timeline/")) return ROUTES.timeline(slug, epId);
  return ROUTES.storyboard(slug, epId);
}

export function getEpisodeId(episode: EpisodeRecord): string {
  return episode.episode_id ?? episode.id ?? "";
}

export function getEpisodeNumber(episode: EpisodeRecord): number {
  return episode.episode_number ?? episode.index ?? 0;
}

export function epStatusPill(s: string): EpStatus {
  if (s === "done" || s === "completed") return "approved";
  if (s === "storyboarded") return "ready";
  if (s === "drafted" || s === "scripted") return "draft";
  if (s === "generating" || s === "approved" || s === "picked" || s === "ready" || s === "failed" || s === "draft") {
    return s as EpStatus;
  }
  return "draft";
}

export function episodeHasScript(ep: EpisodeRecord): boolean {
  return Boolean(ep.script_path || ep.script_md);
}

export function episodeHasStoryboard(ep: EpisodeRecord): boolean {
  return Boolean(
    ep.storyboard_path ||
      ["storyboarded", "picked", "ready", "approved", "completed", "done"].includes(ep.status),
  );
}

export function episodeIsDone(ep: EpisodeRecord): boolean {
  // 2026-05-26 — 用户实测发现 status="exported" (已导出最终态) 没被算"完成",
  // 卡片显示"可以合成"误导. exported = 已合成 + 已导出, 应当算完成态.
  return ["approved", "completed", "done", "exported"].includes(ep.status);
}

export function episodeNeedsStoryboard(ep: EpisodeRecord): boolean {
  return episodeHasScript(ep) && !episodeHasStoryboard(ep) && ep.status !== "generating" && ep.status !== "failed";
}

export function episodeIsDraft(ep: EpisodeRecord): boolean {
  return !episodeHasScript(ep) && !episodeHasStoryboard(ep) && ep.status !== "generating" && ep.status !== "failed";
}

/**
 * 2026-05-26 重写 — 用户反馈"未完善看不出来该完善哪里, 提示不明确".
 *
 * 改进点:
 * - 不再笼统返"待完善", 按 ep 实际进度返回具体下一步动作
 * - 智能识别选视频进度 (picked_video_count vs actual_shot_count)
 * - "待合成"/"分镜已生成" 模糊状态升级为具体"X/Y 镜已选视频" / "可以合成"
 */
export function episodeStatusLabel(ep: EpisodeRecord): string {
  if (ep.status === "failed") return "出错需重试";
  if (ep.status === "generating") return "生成中";
  if (episodeIsDone(ep)) return "已完成";
  // 2026-05-26 — assembled = 已合成未导出最终态, 显式标"可导出"提示用户下一步
  if (ep.status === "assembled") return "可导出";

  const hasStoryboard = episodeHasStoryboard(ep);
  const hasScript = episodeHasScript(ep);

  if (hasStoryboard) {
    const shotCount = ep.actual_shot_count ?? ep.target_shot_count ?? 0;
    const pickedCount = ep.picked_video_count ?? 0;
    if (shotCount > 0 && pickedCount === shotCount) return "可以合成";
    if (pickedCount > 0) return `${pickedCount}/${shotCount} 镜已选`;
    if (["picked", "ready"].includes(ep.status)) return "待合成";
    return "待选视频";
  }

  if (hasScript) return "待拆分镜";
  return "待写剧本";
}

export function episodeActionLabel(ep: EpisodeRecord): string {
  if (episodeHasStoryboard(ep)) return "查看分镜";
  if (episodeHasScript(ep)) return "生成分镜";
  return "补充灵感";
}

export function episodePrimaryRoute(slug: string, ep: EpisodeRecord): string {
  const episodeId = getEpisodeId(ep);
  if (!episodeId) return ROUTES.inbox(slug);
  if (episodeHasStoryboard(ep)) return ROUTES.storyboard(slug, episodeId);
  if (episodeHasScript(ep)) return ROUTES.script(slug);
  return ROUTES.inbox(slug);
}

export function episodeHelperText(ep: EpisodeRecord): string {
  if (ep.synopsis) return ep.synopsis;
  if (episodeHasStoryboard(ep)) return "分镜已经生成，可以进入分镜板查看每个镜头的画面、动作和素材进度。";
  if (episodeHasScript(ep)) return "剧本已经准备好，下一步可以生成这一集的分镜。";
  return "这一集还没有具体内容，先补充灵感或生成剧本，再继续拆分分镜。";
}

/**
 * SeriesDetail 卡片时长格式化.
 *
 * 2026-05-26 修复 — 用户反馈"对每个分镜选定视频就不应该没有时长".
 * 优先级: 真选视频累加 (ep.picked_video_total_duration_sec) > LLM 目标 (ep.target_duration_sec) > "拆分镜后显示".
 *
 * 老 caller 传 number 仍兼容 (走原逻辑); 新 caller 可直接传 ep 拿到智能结果.
 */
export function formatDuration(epOrSeconds?: EpisodeRecord | number): string {
  // 兼容老 caller (传 seconds)
  if (typeof epOrSeconds === "number") {
    if (!epOrSeconds || epOrSeconds <= 0) return "拆分镜后显示";
    return _formatDuration(epOrSeconds);
  }
  // 新 caller (传整个 ep)
  if (epOrSeconds && typeof epOrSeconds === "object") {
    const real = epOrSeconds.picked_video_total_duration_sec;
    if (real && real > 0) return _formatDuration(real);
    const target = epOrSeconds.target_duration_sec;
    if (target && target > 0) return `目标 ${_formatDuration(target)}`;
    return "拆分镜后显示";
  }
  return "拆分镜后显示";
}
