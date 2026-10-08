// 来源: design-skill/video-generate/src/batch2b.jsx:19-64
// v24-batch-all · 模型字典 + 热路径 + 镜头语法 + 字幕字体预设
// 本文件是前端默认字典（作为后端 /api/v2/models 不可达时的 fallback）。
// TODO(pm): MODEL_DICT 是否迁到后端 db 维护？目前硬编码在前端。

export type ModelAction = "t2i" | "i2v" | "t2v";
export type ModelStatus = "ok" | "coming";

export interface ModelDescriptor {
  id: string;
  name: string;
  price: string;
  eta: string;
  note: string;
  actions: ModelAction[];
  status: ModelStatus;
  durations?: number[];
  hot?: boolean;
}

export const MODEL_DICT: ModelDescriptor[] = [
  { id: "local_card_image",    name: "本地卡片",          price: "¥0 / 张",    eta: "约 1s",  note: "无 Key 可跑通链路，适合草稿占位",       actions: ["t2i"],            status: "ok", hot: true },
  { id: "local_sdxl_openclaw", name: "本地 SDXL",         price: "本地算力",   eta: "约 20s", note: "适合本机生图与离线草稿",             actions: ["t2i"],            status: "ok" },
  { id: "jimeng_image_4",      name: "即梦 Image 4.0",    price: "按 API 计费", eta: "约 6s",  note: "中文人物与短剧风格首帧",             actions: ["t2i"],            status: "ok" },
  { id: "openai_gpt_image_2",  name: "OpenAI Image",      price: "按 API 计费", eta: "约 10s", note: "通用图像生成，适合概念与海报",       actions: ["t2i"],            status: "ok" },
  { id: "local_mock_video",    name: "本地 Mock 视频",    price: "¥0 / 条",    eta: "约 1s",  note: "无 Key 可跑通视频候选与合成流程",     actions: ["i2v", "t2v"], durations: [5, 10], status: "ok", hot: true },
  { id: "aliyun_wan_t2v",      name: "通义万相 / Wan",    price: "按 API 计费", eta: "约 70s", note: "中文运镜词稳定，支持文生/图生视频",   actions: ["i2v", "t2v"], durations: [5, 10], status: "ok" },
  { id: "minimax_hailuo",      name: "MiniMax 海螺",      price: "按 API 计费", eta: "约 60s", note: "运动幅度大，适合动作与情绪推进",      actions: ["i2v", "t2v"], durations: [6, 10], status: "ok" },
  { id: "jimeng_video_3pro",   name: "即梦视频 3 Pro",    price: "按 API 计费", eta: "约 60s", note: "短剧风格与中文画面提示词友好",        actions: ["i2v", "t2v"], durations: [5, 10], status: "ok" },
  { id: "wan_i2v_endframe",    name: "Wan 首尾帧",        price: "按 API 计费", eta: "约 95s", note: "首尾帧引导，过渡平滑（接入中）",      actions: ["i2v"], durations: [5], status: "coming" },
];

export const HOT_PATH_T2I = ["本地卡片", "即梦 Image 4.0", "本地 SDXL"];
export const HOT_PATH_I2V = ["本地 Mock 视频", "通义万相 / Wan", "MiniMax 海螺"];

export function modelsForAction(action: ModelAction): ModelDescriptor[] {
  return MODEL_DICT.filter((m) => m.actions.includes(action));
}

export function hotPathFor(action: ModelAction): string[] {
  if (action === "i2v" || action === "t2v") return HOT_PATH_I2V;
  return HOT_PATH_T2I;
}

// 镜头语法 - batch2b.jsx:34-48
export interface CameraVocabItem {
  id: string;
  label: string;
  desc: string;
}

export const CAMERA_VOCAB: CameraVocabItem[] = [
  { id: "push",     label: "推",     desc: "镜头向被摄主体方向移近" },
  { id: "pull",     label: "拉",     desc: "镜头远离被摄主体" },
  { id: "pan",      label: "摇",     desc: "机位不动，镜头横向旋转" },
  { id: "tilt",     label: "移",     desc: "机位整体平移" },
  { id: "follow",   label: "跟",     desc: "镜头跟随主体运动" },
  { id: "rise",     label: "升",     desc: "机位向上抬升" },
  { id: "fall",     label: "降",     desc: "机位向下" },
  { id: "low",      label: "仰",     desc: "镜头由下向上仰拍" },
  { id: "high",     label: "俯",     desc: "镜头由上向下俯拍" },
  { id: "orbit",    label: "环绕",   desc: "镜头围绕主体环绕" },
  { id: "snap",     label: "急推",   desc: "快速推近，强调情绪" },
  { id: "zoom",     label: "变焦推", desc: "焦距变化推近，无机位移动" },
  { id: "handheld", label: "手持",   desc: "手持感的轻微抖动" },
];

// 字幕字体预设 - batch2b.jsx:50-64
export interface FontPreset {
  id: string;
  label: string;
  sample: string;
  css: React.CSSProperties;
  bg: string;
}

export const FONT_PRESETS: FontPreset[] = [
  {
    id: "songti_bold",
    label: "宋体加粗",
    sample: "请问，还有热的关东煮吗？",
    css: { fontFamily: "'Noto Serif SC', 'Source Han Serif SC', serif", fontWeight: 700, color: "#fff", textShadow: "0 2px 4px rgba(0,0,0,0.9)" },
    bg: "linear-gradient(135deg, #2a2622 0%, #4a3f35 100%)",
  },
  {
    id: "mincho_white",
    label: "明朝白底",
    sample: "请问，还有热的关东煮吗？",
    css: { fontFamily: "'Noto Serif SC', serif", fontWeight: 500, color: "#1a1816" },
    bg: "linear-gradient(135deg, rgba(255,255,255,0.94) 0%, rgba(248,246,241,0.94) 100%)",
  },
  {
    id: "rounded_solo",
    label: "圆体单边描",
    sample: "请问，还有热的关东煮吗？",
    css: { fontFamily: "'PingFang SC', 'HarmonyOS Sans', sans-serif", fontWeight: 600, color: "#fff", textShadow: "1px 1px 0 #d97757, -1px -1px 0 #d97757, 1px -1px 0 #d97757, -1px 1px 0 #d97757" },
    bg: "linear-gradient(135deg, #7d97b4 0%, #2f3f54 100%)",
  },
  {
    id: "mono_kuro",
    label: "等距黑体",
    sample: "请问，还有热的关东煮吗？",
    css: { fontFamily: "ui-monospace, 'SF Mono', Consolas, monospace", fontWeight: 600, color: "#fff", letterSpacing: "0.04em", textShadow: "0 1px 0 rgba(0,0,0,0.8)" },
    bg: "linear-gradient(135deg, #efd2bd 0%, #a14826 100%)",
  },
];
