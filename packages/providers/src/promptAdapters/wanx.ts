/**
 * 通义万相 (Wanx) Prompt Adapter
 * 适配通义万相图/视频生成的 prompt 格式
 */

import type { Shot, Character, Scene } from "../../../drama/src/types";

export interface WanxImagePrompt {
  prompt: string;
  negative_prompt?: string;
  width: number;
  height: number;
  model?: string;
  n?: number;
  extras?: Record<string, any>;
}

export interface WanxVideoPrompt {
  prompt: string;
  first_frame_image?: string;
  duration?: number;
  width: number;
  height: number;
  extras?: Record<string, any>;
}

/**
 * 适配通义万相图片生成提示词
 */
export function adaptImagePrompt(
  generalPromptText: string,
  shot: Shot,
  characters: Character[],
  scene: Scene,
  providerConfig: Record<string, any>
): WanxImagePrompt {
  const { width, height } = parseAspectRatio(providerConfig.aspect_ratio || "16:9");

  // 通义万相偏好：中文描述，风格明确
  const style = providerConfig.style || "写实摄影";
  const prompt = `【${style}】${generalPromptText}，高清，专业品质`;

  return {
    prompt,
    negative_prompt: "模糊，变形，低质量，水印",
    width,
    height,
    model: providerConfig.model || "wanx-v1",
    n: 1,
    extras: {
      style: providerConfig.style || " <auto>"
    }
  };
}

/**
 * 适配通义万相视频生成提示词
 */
export function adaptVideoPrompt(
  generalPromptText: string,
  shot: Shot,
  characters: Character[],
  scene: Scene,
  firstFramePath: string | undefined,
  providerConfig: Record<string, any>
): WanxVideoPrompt {
  const { width, height } = parseAspectRatio(providerConfig.aspect_ratio || "16:9");

  // 通义万相视频：中文描述，强调动作
  const motionDesc = shot.camera_movement || "固定镜头";
  const prompt = `${generalPromptText}，${motionDesc}，流畅自然`;

  return {
    prompt,
    first_frame_image: firstFramePath,
    duration: shot.duration_sec || 5,
    width,
    height,
    extras: {
      model: providerConfig.model || "wanx-video-v1"
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
    "4:3": { width: 1440, height: 1080 }
  };

  return ratioMap[aspectRatio] || ratioMap["16:9"];
}
