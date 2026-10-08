/** A cover is sent directly to an image model, so compile an image brief rather than a JSON-writing instruction. */
export function buildCoverImagePrompt(context: {
  series_title?: string;
  series_synopsis?: string;
  episode_title?: string;
  episode_index?: number;
  episode_synopsis?: string;
  visual_style_phrase?: string;
  key_characters?: string;
  key_scene?: string;
}): string {
  const title = context.series_title || context.episode_title || "短剧";
  return [
    `为《${title}》创作一张完整的竖屏影视封面，画幅 9:16，尺寸 1080×1920。`,
    context.episode_title && context.episode_title !== title
      ? `分集：第 ${context.episode_index ?? 1} 集《${context.episode_title}》。` : "",
    context.series_synopsis ? `系列故事：${context.series_synopsis}` : "",
    context.episode_synopsis && context.episode_synopsis !== context.series_synopsis
      ? `本集故事：${context.episode_synopsis}` : "",
    `视觉风格：${context.visual_style_phrase || "电影感写实"}。`,
    context.key_characters ? `主要人物：${context.key_characters}` : "",
    context.key_scene ? `主要场景：${context.key_scene}` : "",
    "突出故事主体、人物情绪和清晰的视觉焦点，让小尺寸缩略图也能辨认。保持画面层次，避免过度堆叠元素。",
    "请直接生成封面图。不要添加未经指定的文字、标志或水印；为后续排版保留适当空间。",
  ].filter(Boolean).join("\n\n");
}
