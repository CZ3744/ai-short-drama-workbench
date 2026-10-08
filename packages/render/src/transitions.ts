// W7 Phase 2: 转场体系(transitions)
//
// ffmpeg xfade filter 工具。支持的转场类型:
//   - hard          硬切(默认,无 xfade)
//   - crossfade     交叉溶解(对应 xfade=dissolve)
//   - fade          淡入淡出(对应 xfade=fade)
//   - wipe-left     从左划入(xfade=wipeleft)
//   - wipe-right    从右划入(xfade=wiperight)
//   - wipe-up       从上划入(xfade=wipeup)
//   - wipe-down     从下划入(xfade=wipedown)
//
// 旧字段 transition_in 兼容:fade / dissolve / wipe 已被本表覆盖。
//
// 参考: https://ffmpeg.org/ffmpeg-filters.html#xfade

export type TransitionType =
  | "hard"
  | "crossfade"
  | "fade"
  | "wipe-left"
  | "wipe-right"
  | "wipe-up"
  | "wipe-down";

const TRANSITION_TO_XFADE: Record<Exclude<TransitionType, "hard">, string> = {
  crossfade: "dissolve",
  fade: "fade",
  "wipe-left": "wipeleft",
  "wipe-right": "wiperight",
  "wipe-up": "wipeup",
  "wipe-down": "wipedown",
};

/** Wave 7 之前 storyboard 已存的旧字段名兼容 → 新 TransitionType
 *  另外 ShotStagePage 用户挑的中文标签也走这里规范化。
 *  推/拉镜接没有对应 xfade,降级 hard(不影响渲染,只是无过渡)。 */
const LEGACY_ALIAS: Record<string, TransitionType> = {
  // 英文 / API 名
  hard: "hard",
  none: "hard",
  cut: "hard",
  fade: "fade",
  dissolve: "crossfade",
  crossfade: "crossfade",
  wipe: "wipe-left",
  "wipe-left": "wipe-left",
  "wipe-right": "wipe-right",
  "wipe-up": "wipe-up",
  "wipe-down": "wipe-down",
  // transition.json preset id(config/presets/transition.json 的 options[].id)
  hard_cut: "hard",
  cross_dissolve: "crossfade",
  push: "wipe-left", // json type=wipe,无原生 push 的 xfade → 降级左划入
  // 中文(ShotStagePage TRANSITION_OPTIONS)
  "硬切": "hard",
  "硬剪": "hard",
  "淡入": "fade",
  "淡出": "fade",
  "淡入淡出": "fade", // transition.json fade 的 label_zh
  "叠化": "crossfade",
  "交叉溶解": "crossfade", // transition.json cross_dissolve 的 label_zh
  "推拉": "wipe-left", // transition.json push 的 label_zh
  "划像": "wipe-left",
  "左划入": "wipe-left",
  "右划入": "wipe-right",
  "上划入": "wipe-up",
  "下划入": "wipe-down",
  "推镜接": "hard",
  "拉镜接": "hard",
};

/**
 * 规范化用户/存储的 transition 字符串到内部枚举,不识别返回 "hard"。
 */
export function normalizeTransition(raw: string | undefined | null): TransitionType {
  if (!raw) return "hard";
  const lower = raw.trim().toLowerCase();
  return LEGACY_ALIAS[lower] ?? "hard";
}

export interface XfadeSegmentInput {
  /** 该段在 timeline 上的时长(秒) */
  durationSec: number;
  /** 从这一段切到下一段的转场类型(最后一段用 hard 或不影响) */
  transitionToNext: TransitionType;
  /** 转场持续时间(秒,默认 0.5) */
  transitionDurationSec?: number;
}

export interface XfadeFilterChainResult {
  /** filter_complex 字符串,如 "[0:v][1:v]xfade=transition=fade:duration=0.5:offset=4.5[v1];..." */
  filterComplex: string;
  /** 最终视频流标签,如 "[vout]" */
  outputLabel: string;
  /** 该 chain 输出的总时长(秒) — 加和减去重叠部分 */
  totalDurationSec: number;
}

/**
 * 构造多段视频拼接的 xfade filter_complex 字符串。
 *
 * 公式: offset(i) = sum(duration[0..i-1]) - transitionDuration * i
 *   每加一个 xfade,前一段尾巴会被吃掉 transitionDuration 秒。
 *
 * 若任意一段 transitionToNext === "hard",该相邻段不走 xfade,而是普通拼接;
 * 此时整体策略由调用方决定:可以(a)将整个 chain 都用 hard → 直接 ffmpegConcat,
 * 或(b)用 xfade 但在 hard 段处理 duration=0 — 当前实现采用 (a),由调用方在 hasAnyXfade 判断后决定走哪条。
 *
 * 调用方:
 *   const chain = buildXfadeFilterChain([{...},{...}]);
 *   spawn("ffmpeg", [..., "-filter_complex", chain.filterComplex, "-map", chain.outputLabel, ...]);
 */
export function buildXfadeFilterChain(segments: XfadeSegmentInput[]): XfadeFilterChainResult {
  if (segments.length === 0) {
    throw new Error("buildXfadeFilterChain: segments 为空");
  }

  if (segments.length === 1) {
    // 单镜直接输出 [0:v]
    return {
      filterComplex: "",
      outputLabel: "[0:v]",
      totalDurationSec: segments[0].durationSec,
    };
  }

  const parts: string[] = [];
  let prevLabel = "[0:v]";
  let offsetSec = 0;
  let totalDuration = segments[0].durationSec;

  for (let i = 1; i < segments.length; i++) {
    const transition = segments[i - 1].transitionToNext;
    // 2026-05-28 audit P1-32: hard 转场不应被误替换为 fade — 之前 hard 走这里时用 fade 名 + 0.5s
    // duration, 等于强加 0.5s 淡入淡出. 正确做法: hard 用 fade 字符串 (xfade 不接受 "hard"),
    // 但 duration=0 让 ffmpeg 当作硬切. 仍走 xfade pipeline 不破坏 offset 公式.
    const isHard = transition === "hard";
    // 2026-06-01 收尾自查: 转场时长必须 clamp。`?? 0.5` 不挡 NaN → Math.max(NaN,0.1)=NaN →
    // 拼出 "duration=NaN" 崩 ffmpeg; 时长过长(≥ 镜长)会让下方 offset += durationSec - transDuration
    // 变负 → xfade offset 为负同样崩。上限取相邻较短段 - 0.05(合法大转场不受影响, 仅挡退化值)。
    const rawTransDur = segments[i - 1].transitionDurationSec;
    const safeTransDur =
      typeof rawTransDur === "number" && Number.isFinite(rawTransDur) && rawTransDur > 0 ? rawTransDur : 0.5;
    const transDurCap = Math.max(0.1, Math.min(segments[i - 1].durationSec, segments[i].durationSec) - 0.05);
    const transDuration = isHard ? 0 : Math.min(Math.max(safeTransDur, 0.1), transDurCap);
    const xfadeName = isHard
      ? "fade"               // hard 兜底用 fade 字符串, 但 duration=0 等于硬切
      : TRANSITION_TO_XFADE[transition];

    offsetSec += segments[i - 1].durationSec - transDuration;
    const outLabel = i === segments.length - 1 ? "[vout]" : `[v${i}]`;
    parts.push(
      `${prevLabel}[${i}:v]xfade=transition=${xfadeName}:duration=${transDuration.toFixed(3)}:offset=${offsetSec.toFixed(3)}${outLabel}`,
    );
    prevLabel = outLabel;
    totalDuration += segments[i].durationSec - transDuration;
  }

  return {
    filterComplex: parts.join(";"),
    outputLabel: "[vout]",
    totalDurationSec: totalDuration,
  };
}

/** 判断转场链路里是否至少有一个非 hard 的转场(决定是否走 xfade pipeline)。 */
export function hasAnyXfade(segments: XfadeSegmentInput[]): boolean {
  // 最后一段的 transitionToNext 不影响 — 因为没有"下一段"。
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i].transitionToNext !== "hard") return true;
  }
  return false;
}
