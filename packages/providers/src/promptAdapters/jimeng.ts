/**
 * 即梦 (Jimeng) Prompt Adapter
 * 适配即梦图/视频生成的 prompt 格式
 */

import type { Shot, Character, Scene } from "../../../drama/src/types";

export interface JimengImagePrompt {
  prompt: string;
  negative_prompt?: string;
  width: number;
  height: number;
  model?: string;
  seed?: number;
  extras?: Record<string, any>;
}

export interface JimengVideoPrompt {
  prompt: string;
  first_frame_image?: string;
  duration?: number;
  fps?: number;
  width: number;
  height: number;
  extras?: Record<string, any>;
}

/**
 * 适配即梦图片生成提示词
 */
export function adaptImagePrompt(
  generalPromptText: string,
  shot: Shot,
  characters: Character[],
  scene: Scene,
  providerConfig: Record<string, any>
): JimengImagePrompt {
  const { width, height } = parseAspectRatio(providerConfig.aspect_ratio || "16:9");

  // 即梦偏好：中文描述，风格关键词前置
  const stylePrefix = providerConfig.visual_style || "写实风格";
  const qualitySuffix = "高清，细节丰富，专业摄影";

  const prompt = `${stylePrefix}，${generalPromptText}，${qualitySuffix}`;

  return {
    prompt,
    negative_prompt: "模糊，变形，低质量，水印，文字",
    width,
    height,
    model: providerConfig.model || "jimeng-2.1",
    extras: {
      guidance_scale: providerConfig.guidance_scale || 7.5,
      num_inference_steps: providerConfig.steps || 30
    }
  };
}

/**
 * 适配即梦视频生成提示词
 */
export function adaptVideoPrompt(
  generalPromptText: string,
  shot: Shot,
  characters: Character[],
  scene: Scene,
  firstFramePath: string | undefined,
  providerConfig: Record<string, any>
): JimengVideoPrompt {
  const { width, height } = parseAspectRatio(providerConfig.aspect_ratio || "16:9");

  // 即梦视频提示词：动作描述 + 镜头运动
  const motionDesc = shot.camera_movement || "固定镜头";
  const prompt = `${generalPromptText}，${motionDesc}，流畅运动，自然过渡`;

  return {
    prompt,
    first_frame_image: firstFramePath,
    duration: shot.duration_sec || 5,
    fps: providerConfig.fps || 24,
    width,
    height,
    extras: {
      motion_strength: providerConfig.motion_strength || 0.5
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
    "1:1": { width: 1024, height: 1024 },
    "4:3": { width: 1440, height: 1080 },
    "3:4": { width: 1080, height: 1440 }
  };

  return ratioMap[aspectRatio] || ratioMap["16:9"];
}
