/**
 * GPT Image 2 Prompt Adapter
 * 适配 GPT Image 2 图片生成的 prompt 格式
 */

import type { Shot, Character, Scene } from "../../../drama/src/types";

export interface GptImage2Prompt {
  prompt: string;
  size?: string;
  quality?: string;
  style?: string;
  n?: number;
  extras?: Record<string, any>;
}

/**
 * 适配 GPT Image 2 图片生成提示词
 */
export function adaptImagePrompt(
  generalPromptText: string,
  shot: Shot,
  characters: Character[],
  scene: Scene,
  providerConfig: Record<string, any>
): GptImage2Prompt {
  // GPT Image 偏好：英文描述，自然语言
  const style = providerConfig.style || "natural";
  const quality = providerConfig.quality || "standard";

  // 转换画面比例为 OpenAI 支持的尺寸
  const size = mapToGptSize(providerConfig.aspect_ratio || "16:9");

  return {
    prompt: generalPromptText,
    size,
    quality,
    style,
    n: 1,
    extras: {
      response_format: "url"
    }
  };
}

/**
 * 映射画面比例到 GPT Image 支持的尺寸
 */
function mapToGptSize(aspectRatio: string): string {
  const sizeMap: Record<string, string> = {
    "16:9": "1792x1024",
    "9:16": "1024x1792",
    "1:1": "1024x1024",
    "4:3": "1536x1024",
    "3:4": "1024x1536"
  };

  return sizeMap[aspectRatio] || "1024x1024";
}
