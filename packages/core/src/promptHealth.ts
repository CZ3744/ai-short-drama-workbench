/**
 * Prompt Health Check — Prompt 体检模块
 * 真实生成前对 prompt 做质量检查
 */

export interface PromptHealthResult {
  ok: boolean;
  score: number; // 0-100
  warnings: PromptWarning[];
  suggestions: string[];
  stats: {
    length: number;
    has_subject: boolean;
    has_visual_style: boolean;
    has_camera_motion: boolean;
    screen_text_count: number;
    is_too_abstract: boolean;
    word_count: number;
  };
}

export interface PromptWarning {
  code: string;
  message: string;
  severity: "info" | "warn" | "error";
}

/**
 * 检查 prompt 健康状态
 */
export function checkPromptHealth(prompt: string, options?: {
  maxLength?: number;
  providerLimit?: number;
  screenText?: string[];
  negativePrompt?: string;
}): PromptHealthResult {
  const warnings: PromptWarning[] = [];
  const suggestions: string[] = [];
  let score = 100;

  const text = (prompt || "").trim();
  const maxLen = options?.maxLength || 2000;
  const providerLimit = options?.providerLimit;

  // 1. 空 prompt
  if (!text) {
    return {
      ok: false,
      score: 0,
      warnings: [{ code: "empty_prompt", message: "Prompt 为空", severity: "error" }],
      suggestions: ["请填写视觉描述 prompt，描述画面主体、风格、镜头运动等。"],
      stats: { length: 0, has_subject: false, has_visual_style: false, has_camera_motion: false, screen_text_count: 0, is_too_abstract: false, word_count: 0 }
    };
  }

  // 2. 长度检查
  const length = text.length;
  if (providerLimit && length > providerLimit) {
    warnings.push({ code: "over_limit", message: `Prompt 长度 ${length} 超过 provider 限制 ${providerLimit}，将被截断。`, severity: "warn" });
    score -= 15;
    suggestions.push(`建议精简 prompt 到 ${providerLimit} 字以内，避免自动截断丢失关键信息。`);
  } else if (length > maxLen) {
    warnings.push({ code: "too_long", message: `Prompt 过长（${length} 字），建议精简。`, severity: "warn" });
    score -= 10;
  }

  // 3. 过短
  if (length < 20) {
    warnings.push({ code: "too_short", message: "Prompt 过短，视频生成效果可能不佳。", severity: "warn" });
    score -= 10;
    suggestions.push("建议补充画面主体、风格、镜头运动等描述。");
  }

  // 4. 中文分词和词数
  const chineseChars = (text.match(/[一-鿿]/g) || []).length;
  const latinWords = (text.match(/[a-zA-Z]+/g) || []).length;
  const wordCount = chineseChars + latinWords;

  // 5. 主体检测
  const subjectPatterns = [
    /一个/, /一位/, /一只/, /一张/, /一座/, /一棵/,
    /人/, /猫/, /狗/, /树/, /花/, /山/, /水/, /海/, /天/,
    /桌子/, /椅子/, /房子/, /车/, /飞机/, /船/,
    /a /, /an /, /the /, /person/, /cat/, /dog/, /tree/,
    /画面/, /场景/, /镜头/, /背景/, /前景/
  ];
  const hasSubject = subjectPatterns.some(p => p.test(text));
  if (!hasSubject && wordCount > 5) {
    warnings.push({ code: "no_subject", message: "未检测到明确的画面主体。", severity: "info" });
    score -= 5;
    suggestions.push("建议描述画面中的主要物体或人物。");
  }

  // 6. 视觉风格
  const stylePatterns = [
    /风格/, /质感/, /色调/, /光线/, /光影/, /柔和/, /明亮/, /暗/, /暖色/, /冷色/,
    /style/, /lighting/, /color/, /tone/, /warm/, /cool/, /bright/, /dark/,
    /卡通/, /写实/, /水彩/, /油画/, /素描/, /赛博朋克/, /复古/,
    /realistic/, /cartoon/, /watercolor/, /cyberpunk/, /vintage/
  ];
  const hasStyle = stylePatterns.some(p => p.test(text));
  if (!hasStyle && wordCount > 10) {
    warnings.push({ code: "no_style", message: "未检测到视觉风格描述。", severity: "info" });
    score -= 3;
    suggestions.push("建议添加色调、光线、风格等描述，使画面更可控。");
  }

  // 7. 镜头运动
  const cameraPatterns = [
    /镜头/, /推/, /拉/, /摇/, /移/, /跟/, /升/, /降/, /旋转/, /固定/,
    /zoom/, /pan/, /tilt/, /dolly/, /tracking/, /static/, /orbit/,
    /缓慢/, /快速/, /慢慢/, /渐渐/
  ];
  const hasCamera = cameraPatterns.some(p => p.test(text));
  if (!hasCamera && wordCount > 10) {
    warnings.push({ code: "no_camera", message: "未检测到镜头运动描述。", severity: "info" });
    score -= 2;
  }

  // 8. 屏幕文字过多
  const screenTextCount = options?.screenText?.length || 0;
  if (screenTextCount > 5) {
    warnings.push({ code: "too_much_text", message: `屏幕文字较多（${screenTextCount} 条），视频中文字可能难以阅读。`, severity: "warn" });
    score -= 5;
  }

  // 9. 矛盾检测
  // v0.2.4 fix: previous `p1 && p2` for same-pair bidirectional regex was
  // logically impossible to both match — the whole branch was dead code.
  // Correct logic: flag when BOTH antonyms appear anywhere (order agnostic).
  const contradictionPairs: Array<[RegExp, RegExp]> = [
    [/明亮|明朗|高亮/, /昏暗|阴暗|暗淡/],
    [/快速|迅捷|高速/, /缓慢|慢速|迟缓/],
    [/静止|静态|不动/, /运动|动态|移动/],
    [/近景|特写/, /远景|广角|全景/]
  ];
  for (const [p1, p2] of contradictionPairs) {
    if (p1.test(text) && p2.test(text)) {
      warnings.push({ code: "contradiction", message: "Prompt 中可能存在矛盾的描述。", severity: "warn" });
      score -= 5;
      break;
    }
  }

  // 10. 过于抽象
  const abstractPatterns = [
    /哲学/, /存在/, /虚无/, /本质/, /意义/, /灵魂/, /宇宙的/,
    /philosophy/, /existence/, /meaning/, /soul/, /abstract/
  ];
  const isAbstract = abstractPatterns.some(p => p.test(text));
  if (isAbstract) {
    warnings.push({ code: "too_abstract", message: "Prompt 较为抽象，视频模型可能难以具象化。", severity: "info" });
    score -= 5;
    suggestions.push("建议用具体的视觉元素替代抽象概念。");
  }

  // 确保分数在 0-100
  score = Math.max(0, Math.min(100, score));

  return {
    ok: score >= 50 && !warnings.some(w => w.severity === "error"),
    score,
    warnings,
    suggestions,
    stats: {
      length,
      has_subject: hasSubject,
      has_visual_style: hasStyle,
      has_camera_motion: hasCamera,
      screen_text_count: screenTextCount,
      is_too_abstract: isAbstract,
      word_count: wordCount
    }
  };
}

/**
 * Prompt 压缩记录
 */
export interface PromptCompressionRecord {
  original_length: number;
  final_length: number;
  was_truncated: boolean;
  was_fallback: boolean;
  provider_limit: number | null;
}

/**
 * 记录 prompt 压缩情况
 */
export function recordPromptCompression(
  original: string,
  final: string,
  providerLimit: number | null,
  wasFallback: boolean
): PromptCompressionRecord {
  return {
    original_length: original.length,
    final_length: final.length,
    was_truncated: final.length < original.length && !wasFallback,
    was_fallback: wasFallback,
    provider_limit: providerLimit
  };
}

/**
 * 推荐第一次真实试跑分镜
 * 评分依据：prompt 短、旁白短、画面主体明确、无复杂字幕、时长短
 */
export function recommendFirstSmokeScene(scenes: Array<{
  stable_scene_id: string;
  visual_prompt: string;
  narration_text: string;
  screen_text: string[];
  duration_estimate_sec: number;
  visual_type: string;
}>): { scene_id: string; score: number; reasons: string[] } | null {
  if (!scenes || scenes.length === 0) return null;

  let best: { scene_id: string; score: number; reasons: string[] } | null = null;

  for (const scene of scenes) {
    let score = 100;
    const reasons: string[] = [];

    // Prompt 短加分
    const promptLen = (scene.visual_prompt || "").length;
    if (promptLen < 100) { score += 20; reasons.push("prompt 短（<100字）"); }
    else if (promptLen < 200) { score += 10; reasons.push("prompt 较短"); }
    else if (promptLen > 500) { score -= 15; reasons.push("prompt 较长"); }

    // 旁白短加分
    const narrLen = (scene.narration_text || "").length;
    if (narrLen < 50) { score += 15; reasons.push("旁白短"); }
    else if (narrLen > 200) { score -= 10; reasons.push("旁白较长"); }

    // 屏幕文字少加分
    const textCount = (scene.screen_text || []).length;
    if (textCount === 0) { score += 10; reasons.push("无屏幕文字"); }
    else if (textCount > 3) { score -= 10; reasons.push("屏幕文字较多"); }

    // 时长短加分
    const dur = scene.duration_estimate_sec || 8;
    if (dur <= 5) { score += 15; reasons.push("时长短（≤5s）"); }
    else if (dur <= 8) { score += 5; reasons.push("时长适中"); }
    else { score -= 10; reasons.push("时长较长"); }

    // keyword_card / title_card 比 ai_video_placeholder 简单
    if (scene.visual_type === "keyword_card" || scene.visual_type === "title_card") {
      score += 10; reasons.push("画面类型简单");
    }

    // 主体检测
    const subjectPatterns = [/一个/, /一位/, /人/, /卡片/, /文字/, /标题/, /背景/];
    if (subjectPatterns.some(p => p.test(scene.visual_prompt || ""))) {
      score += 5; reasons.push("画面主体明确");
    }

    if (!best || score > best.score) {
      best = { scene_id: scene.stable_scene_id, score, reasons };
    }
  }

  return best;
}
