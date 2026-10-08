/**
 * MiniMax Prompt Adapter
 * 适配 MiniMax 视频生成的 prompt 格式
 */

import type { Shot, Character, Scene } from "../../../drama/src/types";

export interface MinimaxVideoPrompt {
  prompt: string;
  first_frame_image?: string;
  duration?: number;
  width: number;
  height: number;
  model?: string;
  extras?: Record<string, any>;
}

/**
 * 适配 MiniMax 视频生成提示词
 */
export function adaptVideoPrompt(
  generalPromptText: string,
  shot: Shot,
  characters: Character[],
  scene: Scene,
  firstFramePath: string | undefined,
  providerConfig: Record<string, any>
): MinimaxVideoPrompt {
  const { width, height } = parseAspectRatio(providerConfig.aspect_ratio || "16:9");

  // MiniMax 偏好：英文提示词，强调电影感
  const motionDesc = translateMotionToEnglish(shot.camera_movement || "fixed");
  const prompt = `${generalPromptText}, ${motionDesc}, cinematic quality, smooth motion, professional lighting`;

  return {
    prompt,
    first_frame_image: firstFramePath,
    duration: shot.duration_sec || 5,
    width,
    height,
    model: providerConfig.model || "MiniMax-Hailuo-01",
    extras: {
      motion_strength: providerConfig.motion_strength || 0.5,
      style: providerConfig.style || "cinematic"
    }
  };
}

/**
 * 解析画面比例为宽高像素
 */
function parseAspectRatio(aspectRatio: string): { width: number; height: number } {
  const ratioMap: Record<string, { width: number; height: number }> = {
    "16:9": { width: 1920, height: 1080 },
    "9:16": { width: 1080, height: 1920 },
    "1:1": { width: 1024, height: 1024 }
  };

  return ratioMap[aspectRatio] || ratioMap["16:9"];
}

/**
 * 翻译镜头运动为英文
 */
function translateMotionToEnglish(motion: string): string {
  const motionMap: Record<string, string> = {
    "固定": "static camera",
    "推近": "dolly in",
    "拉远": "dolly out",
    "左摇": "pan left",
    "右摇": "pan right",
    "上摇": "tilt up",
    "下摇": "tilt down",
    "跟踪": "tracking shot",
    "环绕": "orbit shot"
  };

  return motionMap[motion] || "static camera";
}
