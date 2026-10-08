/**
 * cameraMovementPresets.ts
 * B-4: 运镜参数标准预设表(前端单一定义)
 *
 * value  — 存库字段值(全英文,与后端 shotPromptPresets.ts 保持对称)
 * label  — 用户界面显示的中文名称
 * description — 给 LLM 的展开说明(同时也给用户看,一句话明确意义)
 */

export interface CameraMovementPreset {
  value: string;
  label: string;
  description: string;
}

export const CAMERA_MOVEMENT_PRESETS: CameraMovementPreset[] = [
  { value: "fixed",       label: "固定镜头",   description: "摄像机静止不动" },
  { value: "push_in",     label: "推近",        description: "镜头从远到近，放大主体" },
  { value: "pull_out",    label: "拉远",        description: "镜头从近到远，显示更多环境" },
  { value: "pan_left",    label: "左摇",        description: "镜头水平向左转动" },
  { value: "pan_right",   label: "右摇",        description: "镜头水平向右转动" },
  { value: "tilt_up",     label: "上摇",        description: "镜头垂直向上转动" },
  { value: "tilt_down",   label: "下摇",        description: "镜头垂直向下转动" },
  { value: "tracking",    label: "跟拍",        description: "镜头跟随主体移动" },
  { value: "dolly_left",  label: "左移",        description: "整个机位水平向左移动" },
  { value: "dolly_right", label: "右移",        description: "整个机位水平向右移动" },
  { value: "orbit",       label: "环绕",        description: "镜头围绕主体旋转" },
  { value: "handheld",    label: "手持晃动",    description: "模拟手持的轻微抖动，增加临场感" },
  { value: "zoom_in",     label: "变焦推近",    description: "焦距推近，机位不动（区别于「推近」）" },
  { value: "zoom_out",    label: "变焦拉远",    description: "焦距拉远，机位不动" },
];

/** value → preset 的快查 Map，O(1) */
export const CAMERA_MOVEMENT_PRESET_MAP: Record<string, CameraMovementPreset> =
  Object.fromEntries(CAMERA_MOVEMENT_PRESETS.map((p) => [p.value, p]));

// 2026-07-22 Y6 UP-10: 粘贴分镜(paste storyboard)路径未经归一化, 用户/LLM 直接写标准中文运镜值
// (如 "固定"/"跟随"/"推"/"拉"/"摇"/"移") 存进库 — 这些是常见口语简称, 并不完全等于上面预设表里
// 已有的完整 label("固定镜头"/"跟拍"/"推近"/"拉远"/"左摇"/"右摇"/"上摇"/"下摇"/"左移"/"右移"),
// 原 value-keyed MAP 查不到 → 误判"自定义运镜". 修法两层:
//   ① 若中文原值本身已是某预设的完整 label(如直接写"固定镜头"/"跟拍"), 原样识别为已知.
//   ② 口语简称显式收录别名表. "摇"/"移" 因缺方向(左右/上下)天生有歧义, 不强行猜一个方向,
//      原样把用户写的词展示回去(仍是可读中文, 不是英文 enum, 符合铁律 #9 "不许见技术黑话"的精神,
//      不等同"自定义"这个兜底态)。真不认识的值(英文 snake_case / 乱码)才继续落"自定义运镜".
const CAMERA_MOVEMENT_LABEL_SET: Set<string> = new Set(CAMERA_MOVEMENT_PRESETS.map((p) => p.label));

const CAMERA_MOVEMENT_CHINESE_ALIASES: Record<string, string> = {
  "固定": "固定镜头",
  "跟随": "跟拍",
  "推": "推近",
  "拉": "拉远",
  "摇": "摇",
  "移": "移",
};

/**
 * 给定一个 camera_movement 字段值，返回对用户显示的文本：
 *   - 预设命中 → 返回 label（如"推近"）
 *   - 标准中文值/口语简称命中 → 返回对应中文标签（2026-07-22 Y6 UP-10 新增）
 *   - 未命中   → 统一兜底文案（铁律 #9 toC 兜底，不透传 LLM 原始英文 enum）
 *   - 空值     → 返回空字符串
 *
 * 2026-07-22 X5-3 (A4-3): 原实现未命中时"原值透传"会把 LLM 输出的裸英文 snake_case
 * (如 "orbit_slow") 直接渲染给用户，违反铁律 #9，改统一兜底文案。
 */
export function cameraMovementDisplayLabel(value: string | undefined | null): string {
  if (!value || !value.trim()) return "";
  const v = value.trim();
  const preset = CAMERA_MOVEMENT_PRESET_MAP[v];
  if (preset) return preset.label;
  if (CAMERA_MOVEMENT_LABEL_SET.has(v)) return v;
  if (CAMERA_MOVEMENT_CHINESE_ALIASES[v]) return CAMERA_MOVEMENT_CHINESE_ALIASES[v];
  return "自定义运镜";
}
