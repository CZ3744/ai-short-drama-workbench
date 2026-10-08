/**
 * shotMetaPresets.ts — 2026-05-19
 * 镜头元数据三件套翻译表(toC 兜底, 铁律 #9):
 *   - shot_type   景别  (close_up / medium_shot / long_shot / wide_shot / establishing 等)
 *   - camera_angle 角度 (eye_level / high_angle / low_angle / birds_eye / dutch_angle)
 *   - transition  转场  (cut / fade / dissolve / wipe / zoom)
 *
 * value = 后端 / LLM 输出的英文 schema 值(prompts/storyboard_director.md 第 127/133/134/136 行)
 * label = 用户界面显示的中文人话
 *
 * 设计:
 *   - 跟 cameraMovementPresets.ts 同构(value/label/description), 全前端共用一套 helper
 *   - displayLabel(value) — 用户文本: 预设命中返 label, 自定义文本透传, 空值返空
 *   - description 给将来 dropdown / tooltip 用
 */

export interface ShotMetaPreset {
  value: string;
  label: string;
  description: string;
}

// ─── 景别 (shot_type) ─────────────────────────────────────────────────

export const SHOT_TYPE_PRESETS: ShotMetaPreset[] = [
  { value: "extreme_close",   label: "大特写",  description: "兼容旧预设, 局部细节极近距离" },
  { value: "extreme_close_up", label: "大特写", description: "眼睛 / 局部细节, 极近距离" },
  { value: "close_up",         label: "特写",    description: "面部 / 物体, 突出情绪与细节" },
  { value: "medium_close_up",  label: "中近景",  description: "肩部以上, 偏特写但含一些环境" },
  { value: "medium",           label: "中景",    description: "兼容旧预设, 腰部以上, 对白常用" },
  { value: "medium_shot",      label: "中景",    description: "腰部以上, 对白常用" },
  { value: "cowboy_shot",      label: "牛仔镜",  description: "膝盖以上, 半身动作场景" },
  { value: "medium_long_shot", label: "中远景",  description: "全身 + 少量环境" },
  { value: "full_shot",        label: "全景",    description: "兼容旧预设, 完整人物和环境" },
  { value: "extreme_long",     label: "大远景",  description: "兼容旧预设, 广阔场景, 人物渺小" },
  { value: "long_shot",        label: "远景",    description: "人物较小, 突出环境关系" },
  { value: "wide_shot",        label: "全景",    description: "宽广视野, 完整环境呈现" },
  { value: "extreme_wide_shot",label: "大全景",  description: "地标 / 风景大画面" },
  { value: "establishing",     label: "定场镜",  description: "场景引入, 交代时空" },
  { value: "over_the_shoulder",label: "过肩镜",  description: "OTS, 双人对话常用" },
  { value: "two_shot",         label: "双人镜",  description: "两个主体同框" },
  { value: "insert",           label: "插入镜",  description: "物体特写穿插剧情" },
  { value: "pov",              label: "主观镜",  description: "POV, 角色视角" },
  { value: "reaction",         label: "反应镜",  description: "对话听者的表情反应" },
  { value: "top_down",         label: "俯视",    description: "兼容旧预设, 正上方俯拍" },
  { value: "low_angle",        label: "仰视",    description: "兼容旧预设, 从低处仰拍主体" },
];

export const SHOT_TYPE_PRESET_MAP: Record<string, ShotMetaPreset> =
  Object.fromEntries(SHOT_TYPE_PRESETS.map((p) => [p.value, p]));

// 2026-07-22 Y6 UP-10: 粘贴分镜(paste storyboard)路径不过 normalizeShotType, 用户/LLM 直接写标准
// 中文景别值(如 "远景"/"中景"/"特写")存进库, 而上面的 MAP 是按内部英文枚举键(long_shot/...)查的,
// 中文原值查不到 → 误判"自定义景别". 修法: ① 中文值本身若已是某预设的 label, 直接原样当作已识别
// (SHOT_TYPE_LABEL_SET, 覆盖远景/全景/中景/特写/大特写/大远景/大全景/中近景/中远景/定场镜/过肩镜/
// 双人镜/插入镜/主观镜/反应镜/俯视/仰视等); ② "近景"等不在任何预设 label 里的标准别名单独收录.
// 真不认识的值(英文 snake_case / 无意义乱码)才继续落"自定义景别", 不冲淡这个兜底的意义.
const SHOT_TYPE_LABEL_SET: Set<string> = new Set(SHOT_TYPE_PRESETS.map((p) => p.label));

const SHOT_TYPE_CHINESE_ALIASES: Record<string, string> = {
  "近景": "近景",
};

export function shotTypeDisplayLabel(value: string | undefined | null): string {
  if (!value || !value.trim()) return "";
  const v = value.trim();
  const preset = SHOT_TYPE_PRESET_MAP[v];
  if (preset) return preset.label;
  if (SHOT_TYPE_LABEL_SET.has(v)) return v;
  if (SHOT_TYPE_CHINESE_ALIASES[v]) return SHOT_TYPE_CHINESE_ALIASES[v];
  // 2026-07-22 X5-3 (A4-3): 铁律 #9 toC 兜底 — 未命中预置表时不再吐 LLM 原始英文 enum
  // (如 "hook_close_up"), 改统一兜底文案.
  return "自定义景别";
}

// ─── 角度 (camera_angle) ──────────────────────────────────────────────

export const CAMERA_ANGLE_PRESETS: ShotMetaPreset[] = [
  { value: "eye_level",   label: "平视",   description: "与主体同水平, 客观自然" },
  { value: "high_angle",  label: "高角度", description: "俯视主体, 弱化 / 压迫感" },
  { value: "low_angle",   label: "低角度", description: "仰视主体, 强化 / 威严感" },
  { value: "birds_eye",   label: "鸟瞰",   description: "正上方垂直俯拍" },
  { value: "bird_eye",    label: "鸟瞰",   description: "正上方垂直俯拍" }, // 兼容历史拼写
  { value: "worms_eye",   label: "蚁视",   description: "正下方垂直仰拍" },
  { value: "worm_eye",    label: "蚁视",   description: "正下方垂直仰拍" }, // 兼容
  { value: "dutch_angle", label: "倾斜",   description: "镜头倾斜, 不安 / 紧张氛围" },
  { value: "canted",      label: "倾斜",   description: "同 dutch_angle" },
];

export const CAMERA_ANGLE_PRESET_MAP: Record<string, ShotMetaPreset> =
  Object.fromEntries(CAMERA_ANGLE_PRESETS.map((p) => [p.value, p]));

export function cameraAngleDisplayLabel(value: string | undefined | null): string {
  if (!value || !value.trim()) return "";
  return CAMERA_ANGLE_PRESET_MAP[value.trim()]?.label ?? value.trim();
}

// ─── 转场 (transition) ────────────────────────────────────────────────

export const TRANSITION_PRESETS: ShotMetaPreset[] = [
  { value: "cut",      label: "硬切",     description: "瞬间切到下一镜, 最常用" },
  { value: "fade",     label: "淡入淡出", description: "渐黑 / 渐白过渡" },
  { value: "fade_in",  label: "淡入",     description: "从黑场渐显" },
  { value: "fade_out", label: "淡出",     description: "渐隐到黑场" },
  { value: "dissolve", label: "溶解",     description: "前后两镜画面叠化过渡" },
  { value: "wipe",     label: "划像",     description: "新画面以扫动方式覆盖旧画面" },
  { value: "zoom",     label: "推拉过渡", description: "镜头推近 / 拉远后切下镜" },
  { value: "match_cut",label: "匹配剪辑", description: "两镜构图相似无缝衔接" },
];

export const TRANSITION_PRESET_MAP: Record<string, ShotMetaPreset> =
  Object.fromEntries(TRANSITION_PRESETS.map((p) => [p.value, p]));

// 2026-07-22 Y6 UP-10: 跟 shot_type 同一类 bug — 粘贴分镜若直接写标准中文转场值("硬切"/"溶解"...)
// 而非内部英文枚举键, 原逻辑会误判"自定义转场". 同款 identity-passthrough 修法.
const TRANSITION_LABEL_SET: Set<string> = new Set(TRANSITION_PRESETS.map((p) => p.label));

export function transitionDisplayLabel(value: string | undefined | null): string {
  if (!value || !value.trim()) return "";
  const v = value.trim();
  const preset = TRANSITION_PRESET_MAP[v];
  if (preset) return preset.label;
  if (TRANSITION_LABEL_SET.has(v)) return v;
  // 2026-07-22 X5-3 (A4-3): 铁律 #9 toC 兜底 — 未命中预置表时不再吐原始英文 enum, 改统一兜底文案.
  return "自定义转场";
}
