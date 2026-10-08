/**
 * 可灵 (Kling) Prompt Adapter
 * 适配可灵视频生成的 prompt 格式
 */

import type { Shot, Character, Scene } from "../../../drama/src/types";

export interface KlingVideoPrompt {
  prompt: string;
  negative_prompt?: string;
  first_frame_image?: string;
  duration?: number;
  fps?: number;
  width: number;
  height: number;
  mode?: "standard" | "professional";
  extras?: Record<string, any>;
}

/**
 * 适配可灵视频生成提示词
 */
export function adaptVideoPrompt(
  generalPromptText: string,
  shot: Shot,
  characters: Character[],
  scene: Scene,
  firstFramePath: string | undefined,
  providerConfig: Record<string, any>
): KlingVideoPrompt {
  const { width, height } = parseAspectRatio(providerConfig.aspect_ratio || "16:9");

  // 可灵偏好：英文提示词，动作描述详细
  const motionDesc = translateMotionToEnglish(shot.camera_movement || "fixed");
  const prompt = `${generalPromptText}, ${motionDesc}, cinematic, smooth motion, professional quality`;

  return {
    prompt,
    negative_prompt: "blurry, distorted, low quality, watermark, text, static",
    first_frame_image: firstFramePath,
    duration: shot.duration_sec || 5,
    fps: providerConfig.fps || 24,
    width,
    height,
    mode: providerConfig.mode || "standard",
    extras: {
      motion_strength: providerConfig.motion_strength || 0.6,
      creativity: providerConfig.creativity || 0.5
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
    "推近": "push in, dolly in",
    "拉远": "pull out, dolly out",
    "左摇": "pan left",
    "右摇": "pan right",
    "上摇": "tilt up",
    "下摇": "tilt down",
    "跟踪": "tracking shot",
    "环绕": "orbit shot",
    "手持": "handheld"
  };

  return motionMap[motion] || "static camera";
}
