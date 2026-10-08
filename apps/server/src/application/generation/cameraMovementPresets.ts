/**
 * cameraMovementPresets.ts (server-side copy)
 * B-4: 运镜参数标准预设表 — 与前端 apps/web/src/lib/cameraMovementPresets.ts 保持对称。
 *
 * 注: 项目前后端不共享 import 路径，故维护两份。
 * 如修改预设，两处同步更新。
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
