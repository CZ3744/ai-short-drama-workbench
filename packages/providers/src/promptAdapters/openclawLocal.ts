/**
 * OpenClaw Local Prompt Adapter
 * 适配 OpenClaw 本地模型的 prompt 格式
 */

import type { Shot, Character, Scene } from "../../../drama/src/types";

export interface OpenClawLocalImagePrompt {
  prompt: string;
  negative_prompt?: string;
  width: number;
  height: number;
  steps?: number;
  cfg_scale?: number;
  sampler?: string;
  seed?: number;
  extras?: Record<string, any>;
}

export interface OpenClawLocalVideoPrompt {
  prompt: string;
  first_frame_image?: string;
  duration?: number;
  fps?: number;
  width: number;
  height: number;
  extras?: Record<string, any>;
}

/**
 * 适配 OpenClaw 本地图片生成提示词
 */
export function adaptImagePrompt(
  generalPromptText: string,
  shot: Shot,
  characters: Character[],
  scene: Scene,
  providerConfig: Record<string, any>
): OpenClawLocalImagePrompt {
  const { width, height } = parseAspectRatio(providerConfig.aspect_ratio || "16:9");

  // 本地模型偏好：英文提示词，质量关键词
  const qualitySuffix = "masterpiece, best quality, highly detailed, 8k uhd";
  const prompt = `${generalPromptText}, ${qualitySuffix}`;

  return {
    prompt,
    negative_prompt: "lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry",
    width,
    height,
    steps: providerConfig.steps || 30,
    cfg_scale: providerConfig.cfg_scale || 7,
    sampler: providerConfig.sampler || "euler_a",
    seed: providerConfig.seed ?? -1,
    extras: {
      model: providerConfig.model || "sdxl-base"
    }
  };
}

/**
 * 适配 OpenClaw 本地视频生成提示词
 */
export function adaptVideoPrompt(
  generalPromptText: string,
  shot: Shot,
  characters: Character[],
  scene: Scene,
  firstFramePath: string | undefined,
  providerConfig: Record<string, any>
): OpenClawLocalVideoPrompt {
  const { width, height } = parseAspectRatio(providerConfig.aspect_ratio || "16:9");

  // 本地视频模型：AnimateDiff 格式
  const motionDesc = shot.camera_movement || "static";
  const prompt = `${generalPromptText}, ${motionDesc} camera, smooth motion, consistent character`;

  return {
    prompt,
    first_frame_image: firstFramePath,
    duration: shot.duration_sec || 2,
    fps: providerConfig.fps || 8,
    width,
    height,
    extras: {
      model: providerConfig.model || "animatediff-v3",
      motion_module: providerConfig.motion_module || "mm_sd_v15_v2"
    }
  };
}

/**
 * 解析画面比例为宽高像素
 */
function parseAspectRatio(aspectRatio: string): { width: number; height: number } {
  const ratioMap: Record<string, { width: number; height: number }> = {
    "16:9": { width: 1024, height: 576 },
    "9:16": { width: 576, height: 1024 },
    "1:1": { width: 768, height: 768 },
    "4:3": { width: 1024, height: 768 }
  };

  return ratioMap[aspectRatio] || ratioMap["16:9"];
}
