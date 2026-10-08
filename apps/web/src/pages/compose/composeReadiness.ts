import type { Shot } from "../../hooks/useShots";
import type { ComposeStageKey, StageDetail } from "./parts/StageProgressBar";

export interface ShotReadiness {
  shotId: string;
  index: number;
  label: string;
  durationSec: number;
  approved: boolean;
  hasPickedFrame: boolean;
  hasPickedVideo: boolean;
  ready: boolean;
  missingReason: string | null;
}

export function computeReadiness(s: Shot): ShotReadiness {
  const hasPickedFrame = Boolean(s.picked_first_frame_id);
  const hasPickedVideo = Boolean(s.picked_video_id);
  const approved = s.status === "approved";
  // 2026-05-22: readiness 改为 picked_video_id + approved 二条件.
  // 用户原话: "我五个视频都导入了... 为什么不让我进入下一步" — 之前强要求 picked_first_frame_id
  // 但导入视频 / video-to-video 路径不必然有首帧 (视频本身就是画面). 放宽:
  //   - 有 picked_video_id → 合成主流量已就绪 (取视频自带画面)
  //   - 没首帧 hint: 友好提示 "本镜走视频直出, 没单独首帧图" 但不阻塞 ready
  const ready = approved && hasPickedVideo;
  let missingReason: string | null = null;
  if (!hasPickedVideo) missingReason = "未生成或导入视频";
  else if (!approved) missingReason = "未审批 — 在分镜页点选定即可";
  // 2026-05-22 铁律 #9: 不暴露 SHOT_03 技术 id, 优先用 shot.title, fallback 人话 "第 N 镜"
  const friendlyLabel = s.title?.trim() || `第 ${s.index} 镜`;
  return {
    shotId: s.id,
    index: s.index,
    label: friendlyLabel,
    durationSec: s.duration_sec || 0,
    approved,
    hasPickedFrame,
    hasPickedVideo,
    ready,
    missingReason,
  };
}

export function computeStages(readiness: ShotReadiness[], composing: boolean, done: boolean): { current: ComposeStageKey; completed: ComposeStageKey[]; details: Partial<Record<ComposeStageKey, StageDetail>> } {
  const total = readiness.length;
  const pickedVideos = readiness.filter((r) => r.hasPickedVideo).length;
  const ready = readiness.filter((r) => r.ready).length;

  const completed: ComposeStageKey[] = [];
  let current: ComposeStageKey = "storyboard";

  // Each stage describes the evidence it counts. Imported videos need no first frame.
  if (total > 0) { completed.push("storyboard"); current = "dubbing"; }
  if (pickedVideos === total && total > 0) { completed.push("dubbing"); current = "subtitle"; }
  // 2026-05-25 修: 字幕就绪 → current 跳过 cover 直接到 export.
  // cover 是用户事后去封面页手动操作的可选步骤, 不是合成中"自动进行"的环节.
  // 用户原话: "我什么都没操作为什么说是封面生成中?"
  if (ready === total && total > 0) { completed.push("subtitle"); current = "export"; }
  if (done) { completed.push("export"); current = "export"; }
  if (composing) current = "export";

  const details: Partial<Record<ComposeStageKey, StageDetail>> = {
    storyboard: { completed: total, total },
    dubbing: { completed: pickedVideos, total },
    subtitle: { completed: ready, total },
    // cover 总是 0/0 — 我们没有 cover_path 实时检测信号, 不撒谎"已生成". 进度条会显示"可选"语义.
    cover: { completed: 0, total: 0 },
    export: { completed: done ? 1 : 0, total: 1 },
  };

  return { current, completed, details };
}

/** T4: 导出不可用时分析并给出引导文字 */
export function composeExportBlockReason(
  done: boolean,
  composing: boolean,
  readiness: ShotReadiness[],
): string | null {
  if (done) return null; // 已完成，无需引导
  if (composing) return "合成进行中，请稍候…";
  const missingVideo = readiness.filter((r) => !r.hasPickedVideo);
  const notApproved = readiness.filter((r) => !r.approved);
  if (readiness.length === 0) return "还没有分镜，请先去分镜板规划";
  if (missingVideo.length > 0) return `还需要为 ${missingVideo.length} 个镜头生成视频（${missingVideo.map((r) => r.label).slice(0, 3).join("、")}…）`;
  // 2026-07-09 audit(UX 第一性原理) — 首帧对"已导入视频 / 视频直出"的镜非必需. 就绪判据(computeReadiness:83
  // ready=approved&&hasPickedVideo)已不要求首帧, 此处导出阻断必须对齐, 否则同页顶栏显示"5/5 镜就绪"、导出引导
  // 却说"还需为 5 镜挑首帧"自相矛盾(复现用户原始投诉"5 个视频都导入了为什么不让进下一步"). 删 missingFrame 阻断分支.
  if (notApproved.length > 0) return `还有 ${notApproved.length} 个镜头未审批`;
  // 2026-05-25 合成 UI: 全部就绪但未合成 — 引导用户去点页面右上角主 CTA, 不再放重复按钮
  return "全部就绪 — 请点击页面右上角橙色「合成成片」按钮生成视频后即可导出";
}
