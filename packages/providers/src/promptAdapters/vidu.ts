/**
 * Vidu Prompt Adapter
 * 适配 Vidu 视频生成的 prompt 格式
 * P24 补齐: 参考图排序逻辑 (ref2v 模式, 3-7 张)
 */

import type { Shot, Character, Scene } from "../../../drama/src/types";

export interface ViduVideoPrompt {
  prompt: string;
  negative_prompt?: string;
  first_frame_image?: string;
  duration?: number;
  width: number;
  height: number;
  style?: string;
  extras?: Record<string, any>;
}

export interface RefImageInput {
  asset_id: string;
  /** 角色 / 场景 / 道具 */
  role: "character" | "scene" | "prop";
  /** 关联的 character_id (role=character 时必填) */
  character_id?: string;
  /** base64 data URL 或 https URL */
  url: string;
  label?: string;
}

export interface SortedRefImage {
  url: string;
  label: string;
}

/**
 * 参考图排序规则 (P24 spec):
 *  1. 主角色参考图 (shot.character_ids[0])
 *  2. 场景参考图
 *  3. 次要角色 / 道具
 *
 * 返回排序后的数组 (3-7 张), 超限或不足抛 invalid_request.
 */
export function sortReferenceImages(
  shot: Shot,
  refImages: RefImageInput[],
): SortedRefImage[] {
  if (refImages.length < 3) {
    throw new InvalidRefRequestError(
      `Vidu ref2v requires at least 3 reference images, got ${refImages.length}`,
    );
  }
  if (refImages.length > 7) {
    throw new InvalidRefRequestError(
      `Vidu ref2v supports at most 7 reference images, got ${refImages.length}`,
    );
  }

  const mainCharId = shot.character_ids[0];

  // 分桶
  const mainChar: RefImageInput[] = [];
  const otherChars: RefImageInput[] = [];
  const scenes: RefImageInput[] = [];
  const props: RefImageInput[] = [];

  for (const img of refImages) {
    if (img.role === "character") {
      if (mainCharId && img.character_id === mainCharId) {
        mainChar.push(img);
      } else {
        otherChars.push(img);
      }
    } else if (img.role === "scene") {
      scenes.push(img);
    } else {
      props.push(img);
    }
  }

  // 排序: 主角色 → 场景 → 次要角色 → 道具
  const sorted: SortedRefImage[] = [
    ...mainChar.map((r) => ({
      url: r.url,
      label: r.label ?? `main_char_${r.character_id ?? "unknown"}`,
    })),
    ...scenes.map((r) => ({
      url: r.url,
      label: r.label ?? "scene",
    })),
    ...otherChars.map((r) => ({
      url: r.url,
      label: r.label ?? `char_${r.character_id ?? "unknown"}`,
    })),
    ...props.map((r) => ({
      url: r.url,
      label: r.label ?? "prop",
    })),
  ];

  return sorted;
}

export class InvalidRefRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRefRequestError";
  }
}

/**
 * 适配 Vidu 视频生成提示词 (t2v / i2v 模式, 兼容旧接口)
 */
export function adaptVideoPrompt(
  generalPromptText: string,
  shot: Shot,
  characters: Character[],
  scene: Scene,
  firstFramePath: string | undefined,
  providerConfig: Record<string, any>,
): ViduVideoPrompt {
  const { width, height } = parseAspectRatio(providerConfig.aspect_ratio || "16:9");

  // Vidu 偏好: 简洁英文提示词, 强调风格
  const style = providerConfig.style || "realistic";
  const prompt = `${generalPromptText}, ${style} style, cinematic lighting, smooth motion`;

  return {
    prompt,
    negative_prompt: "blurry, distorted, low quality, watermark, text",
    first_frame_image: firstFramePath,
    duration: shot.duration_sec || 4,
    width,
    height,
    style,
    extras: {
      motion_strength: providerConfig.motion_strength || 0.5,
      seed: providerConfig.seed,
    },
  };
}

/**
 * 适配 Vidu ref2v 模式的完整请求体参数
 */
export function adaptRef2VBody(opts: {
  prompt: string;
  sortedImages: SortedRefImage[];
  model: string;
  style: string;
  duration: number;
  aspectRatio: string;
  seed?: number;
}): {
  model: string;
  prompt: string;
  images: string[];
  duration: number;
  aspect_ratio: string;
  style: string;
  bgm: boolean;
  seed?: number;
} {
  return {
    model: opts.model,
    prompt: opts.prompt,
    images: opts.sortedImages.map((img) => img.url),
    duration: opts.duration,
    aspect_ratio: opts.aspectRatio,
    style: opts.style,
    bgm: false,
    seed: opts.seed,
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
  };

  return ratioMap[aspectRatio] || ratioMap["16:9"];
}
