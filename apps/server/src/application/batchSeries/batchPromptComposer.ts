/**
 * batchPromptComposer.ts — 批量生成系列 prompt 编译
 *
 * 从 batchSeries.ts 拆出，提供 composeForSingle / composeForMulti 两种模式，
 * 各有"仅出 prompt 不调 LLM"的 preview 版本（给前端"复制完整提示词"按钮用）。
 */

import type { BatchGenerateInput, BatchGenerateMultiInput, BatchProjectInput } from "./batchSeries";

/**
 * Merge global defaults + per-project params. Project-level wins over global.
 * 项目层覆盖全局, 都没填则该字段 undefined (让 LLM 自己决定).
 */
export function mergeProjectParams(
  project: BatchProjectInput,
  global: BatchProjectInput | undefined,
): BatchProjectInput {
  return {
    series_title: project.series_title ?? global?.series_title,
    inspiration: project.inspiration ?? global?.inspiration,
    episode_count: project.episode_count ?? global?.episode_count,
    duration_per_episode_sec: project.duration_per_episode_sec ?? global?.duration_per_episode_sec,
    aspect_ratio: project.aspect_ratio ?? global?.aspect_ratio,
    style: project.style ?? global?.style,
    platform: project.platform ?? global?.platform,
  };
}

// ─── Single-project prompt composers ─────────────────────────────────

/**
 * Compose the prompt string sent to LLM (single-project mode).
 */
export function composeBatchPrompt(input: BatchGenerateInput): string {
  const inspiration = input.inspiration?.trim() || "(用户未填 — 你可以自由发挥, 但建议输出一个有戏剧张力的短剧主题)";
  const episodeCount = input.episode_count ?? "(用户未指定 — 你自己决定 1-5 集合理范围)";
  const duration = input.duration_per_episode_sec ?? "(用户未指定 — 你自己决定, 短视频建议 30-90 秒)";
  // 2026-05-22: AI 短剧默认 9:16 竖屏 (抖音/小红书), 不再 fallback 16:9
  const aspect = input.aspect_ratio ?? "(用户未指定 — 短剧默认 9:16 竖屏)";
  const style = input.style?.trim() || "(用户未指定 — 你自己挑一个匹配灵感的风格)";
  const platform = input.platform ?? "(用户未指定 — 默认 bilibili 短视频)";
  const seriesTitleHint = input.series_title?.trim()
    ? `用户希望系列叫 "${input.series_title.trim()}"。如果不合适可微调。`
    : "用户没给系列标题, 你来起一个朗朗上口的。";

  return [
    "你是短剧批量生成助手。根据用户的灵感和参数, 一次性生成一个完整短剧 series 的剧本+分镜数据。",
    "",
    "## 用户灵感",
    "",
    inspiration,
    "",
    "## 参数",
    "",
    `- 集数: ${episodeCount}`,
    `- 每集时长: ${duration} 秒`,
    `- 画面比例: ${aspect}`,
    `- 风格/题材: ${style}`,
    `- 投放平台: ${platform}`,
    `- 系列标题: ${seriesTitleHint}`,
    "",
    "## 输出严格 JSON Schema (不要 markdown 包裹, 不要任何说明文字)",
    "",
    "```json",
    JSON.stringify(
      {
        series: {
          title: "系列标题",
          synopsis: "一句话总剧情",
          style_notes: "整体视觉风格、调色、镜头语言偏好",
          aspect_ratio: "9:16 (短剧默认竖屏) | 16:9 | 1:1 | 4:3 | 21:9 — 必填, 跟用户参数一致",
          platform: "bilibili | douyin | xhs | youtube | wechat_channels — 必填",
          characters: [
            {
              name: "角色名",
              role: "主角 / 配角",
              appearance: "外貌描述 (用于图像生成的 prompt 片段)",
              outfit: "服装",
              personality: "性格简述",
              image_briefs: [
                { angle: "正面 / 标准像", description: "干净中性背景, 五官清晰, 作为后续分镜的人物锚定参考" },
                { angle: "侧面 / 办公场景", description: "侧脸表情, 上半身, 带情绪状态 (例如低头思考)" },
                { angle: "全身 / 走廊", description: "全身站姿, 后期形象 / 不同情境" },
              ],
            },
          ],
          scenes: [
            {
              name: "场景名",
              location: "拍摄地点",
              mood: "氛围",
              visual_style: "视觉风格 prompt 片段",
              image_briefs: [
                { angle: "宽景", description: "整体空间布局, 含家具 / 落地窗等关键元素, 不出现人物" },
                { angle: "近景", description: "靠近桌面的细节, 用于近景分镜锚定" },
              ],
            },
          ],
        },
        episodes: [
          {
            title: "第1集 - 序章",
            synopsis: "一句话集剧情",
            script_md: "完整剧本 markdown 字符串, 含场景标题/旁白/对白/动作描述, 见下方「关于 script_md」说明",
            shots: [
              {
                index: 1,
                action: "画面描述, 必填, 例 '昏暗服务器机房, 镜头跟随主角从画面外走入, 主角神情焦虑'",
                shot_type: "近景",
                camera_movement: "缓慢推进",
                duration_sec: 5,
                dialogue: "台词 (可选)",
                voiceover: "旁白 (可选)",
                character_refs: ["角色名 — 引用上面 characters[].name"],
                scene_ref: "场景名 — 引用上面 scenes[].name",
              },
            ],
          },
        ],
      },
      null,
      2,
    ),
    "```",
    "",
    "## 硬性要求",
    "",
    "- **直接输出 JSON 对象**, 不要 markdown 代码块包裹",
    '- 不要写 "好的我来帮你..." 之类的开场白',
    "- 不要在 JSON 外加任何说明文字",
    "- `shots[].index` 从 1 开始递增, 每集独立计数",
    "- `shots[].action` 必填, 其余可选",
    "- `character_refs` / `scene_ref` 必须引用 `series.characters[].name` / `series.scenes[].name`, 不要每集发明新角色/场景",
    "- 每集 shots 数量根据时长合理估算 (1 镜约 3-8 秒)",
    "- 风格保持跨集一致 — 这是一个系列, 不是独立短片合集",
    "",
    "## 关于 script_md (每集剧本 markdown, 必填)",
    "",
    "- **每集 episode 必须包含 `script_md` 字段**, 是该集完整剧本的 markdown 字符串(面向人类阅读, 与 shots 内容呼应)",
    "- 内容结构: `## 场景X · 地点(时段)` + 旁白/动作描述 + **角色名:** 对白(情绪) 的标准电影剧本格式",
    `- 长度按集时长估算: ${typeof duration === "number" ? `约 ${duration} 秒 × 5-6 字/秒 = ${Math.round(duration * 5.5)} 字左右` : "短视频建议 30-90 秒约 200-500 字"}, 上限 20000 字`,
    "- 剧本要与同集 `shots` 内容呼应 — 同样的场景/角色/动作/对白都要在两边出现, 但 script_md 写给人看(完整段落), shots 写给图像/视频模型看(技术拆分)",
    "- 如果某集时长过短(<10s), 也至少给一段开头+台词的 mini 剧本, 不要省略 script_md",
    "",
    "## 关于 image_briefs (素材图规划, 重要)",
    "",
    "- 每个 character / scene 你都必须给 `image_briefs` 数组, 描述「这个素材需要几张参考图、每张要画什么」",
    "- **每张 brief 必填**: `angle` (例如 '正面' / '侧面' / '全身' / '宽景' / '近景' / '俯视') + `description` (这张图要画什么)",
    "- **数量自决**: 角色多形象 / 跨情境出现 → 2-4 张; 简单 prop / 一次性场景 → 1 张. 单 element 上限 8 张",
    "- 每张 brief 要够具体, 让一个空上下文的图像模型独立画出: 含背景 + 状态 + 服装 + 情绪",
    "- 第 1 张默认作「典型代表图」(代表外貌锚点), 后续张会自动以第 1 张为 i2i 参考保持五官一致",
    "- 如果实在没想清楚要几张, 至少给 1 张 angle='标准像' 的 brief 兜底",
    "- prop / wardrobe / reference / misc 类型本轮不出现在输出里(只有 character / scene 用 image_briefs)",
  ].join("\n");
}

/**
 * 仅返回 prompt, 不调用 LLM. 给前端 "复制完整提示词" 按钮用 (single-project mode).
 */
export function composeBatchPromptOnly(input: BatchGenerateInput): {
  prompt: string;
  resolved_params: BatchGenerateInput;
} {
  return {
    prompt: composeBatchPrompt(input),
    resolved_params: input,
  };
}

// ─── Multi-project prompt composers ──────────────────────────────────

/**
 * 多项目模式的 prompt 生成 — 一次让 LLM 生 N 部剧.
 */
export function composeBatchPromptMulti(input: BatchGenerateMultiInput): string {
  const global = input.global ?? {};
  // 2026-05-22: AI 短剧工作台默认竖屏 9:16 (抖音/小红书/视频号),
  // 不再 fallback 16:9. 用户原话: "这部剧的比例是什么, 视频、图片缩略图的比例就是什么".
  const globalAspect = global.aspect_ratio ?? "(由你决定, 短剧默认 9:16 竖屏)";
  const globalPlatform = global.platform ?? "(由你决定, 默认 bilibili)";
  const globalDuration = global.duration_per_episode_sec
    ? `${global.duration_per_episode_sec} 秒`
    : "(由你决定, 短视频建议 30-90 秒)";
  const globalStyle = global.style?.trim() || "(由你决定)";
  const globalInspiration = input.global_inspiration?.trim() || "(用户未填全局灵感, 看具体项目灵感)";

  const projectsText = input.projects
    .map((p, i) => {
      const merged = mergeProjectParams(p, global);
      const title = merged.series_title?.trim() || "(由你创造)";
      const inspiration = merged.inspiration?.trim() || "(由你发挥, 参考全局灵感)";
      const episodeCount = merged.episode_count ?? "(由你决定 1-10 集)";
      const duration = merged.duration_per_episode_sec
        ? `${merged.duration_per_episode_sec} 秒`
        : "(继承全局或自定)";
      const aspect = merged.aspect_ratio ?? "(继承全局)";
      const platform = merged.platform ?? "(继承全局)";
      const style = merged.style?.trim() || "(继承全局)";

      return [
        `### 项目 ${i + 1}`,
        `- 标题: ${title}`,
        `- 灵感/指示: ${inspiration}`,
        `- 集数: ${episodeCount}`,
        `- 每集时长: ${duration}`,
        `- 画面比例: ${aspect}`,
        `- 投放平台: ${platform}`,
        `- 风格/题材: ${style}`,
      ].join("\n");
    })
    .join("\n\n");

  const n = input.projects.length;
  return [
    `你是短剧批量生成助手。用户希望一次性创建 ${n} 部独立的短剧系列。`,
    "",
    `## 总览: 共 ${n} 部剧`,
    "",
    "## 全局默认参数 (项目层没填的继承全局)",
    "",
    `- 默认画面比例: ${globalAspect}`,
    `- 默认平台: ${globalPlatform}`,
    `- 默认每集时长: ${globalDuration}`,
    `- 默认风格: ${globalStyle}`,
    "",
    "## 全局灵感总指示",
    "",
    globalInspiration,
    "",
    "## 项目列表",
    "",
    projectsText,
    "",
    "## 输出严格 JSON Schema (不要 markdown 包裹, 不要任何说明文字)",
    "",
    "```json",
    JSON.stringify(
      {
        projects: [
          {
            series: {
              title: "第 1 部剧的标题",
              synopsis: "一句话总剧情",
              style_notes: "整体视觉风格",
              aspect_ratio: "9:16 (短剧默认竖屏) | 16:9 | 1:1 | 4:3 | 21:9 — 必填, 跟用户上方参数一致",
              platform: "bilibili | douyin | xhs | youtube | wechat_channels — 必填",
              characters: [
                {
                  name: "角色名",
                  role: "主角 / 配角",
                  appearance: "外貌描述",
                  outfit: "服装",
                  personality: "性格简述",
                  image_briefs: [
                    { angle: "正面 / 标准像", description: "干净中性背景, 五官清晰" },
                  ],
                },
              ],
              scenes: [
                {
                  name: "场景名",
                  location: "拍摄地点",
                  mood: "氛围",
                  visual_style: "视觉风格 prompt 片段",
                  image_briefs: [
                    { angle: "宽景", description: "整体空间布局" },
                  ],
                },
              ],
            },
            episodes: [
              {
                title: "第1集 - 序章",
                synopsis: "一句话集剧情",
                script_md: "完整剧本 markdown, 含场景标题/旁白/对白/动作描述",
                shots: [
                  {
                    index: 1,
                    action: "画面描述, 必填",
                    shot_type: "近景",
                    camera_movement: "缓慢推进",
                    duration_sec: 5,
                    dialogue: "台词 (可选)",
                    voiceover: "旁白 (可选)",
                    character_refs: ["角色名"],
                    scene_ref: "场景名",
                  },
                ],
              },
            ],
          },
          `// 第 2 部剧 ... 直到第 ${n} 部 (每部结构同上, projects 数组必须正好 ${n} 个元素)`,
        ],
      },
      null,
      2,
    ),
    "```",
    "",
    "## 硬性要求",
    "",
    "- **直接输出 JSON 对象**, 不要 markdown 代码块包裹",
    '- 不要写 "好的我来帮你..." 之类的开场白',
    "- 不要在 JSON 外加任何说明文字",
    `- \`projects\` 数组必须正好有 ${n} 个元素, 对应上面列出的 ${n} 部剧`,
    `- **${n} 部剧要独立**, 不要互相串戏, 各自有独立主角和故事线`,
    "- **每部剧的角色/场景独立**, 不要共用 (例如不能两部都有同名角色 '小明')",
    "- `shots[].index` 从 1 开始递增, 每集独立计数",
    "- `shots[].action` 必填, 其余可选",
    "- `character_refs` / `scene_ref` 必须引用同一部剧 `series.characters[].name` / `series.scenes[].name`, 不要跨剧引用",
    "- 每集 shots 数量根据时长合理估算 (1 镜约 3-8 秒)",
    "- 每部剧的集数严格按用户在该项目下指定的集数, 没指定就你自己决定 1-5 集合理范围",
    "",
    "## 关于 script_md (每集剧本 markdown, 必填)",
    "",
    "- **每集 episode 必须包含 `script_md` 字段**, 是该集完整剧本 markdown(面向人类阅读)",
    "- 内容结构: `## 场景X · 地点(时段)` + 旁白/动作描述 + **角色名:** 对白(情绪) 的标准电影剧本格式",
    "- 长度按该集时长 × 5-6 字/秒估算(每集 30s ≈ 200 字, 60s ≈ 360 字, 120s ≈ 700 字), 上限 20000 字",
    "- 与同集 shots 内容呼应 — 同样场景/角色/动作/对白在两边出现, script_md 写给人看(完整段落), shots 写给图像/视频模型看(技术拆分)",
    "- 跨剧不要共用任何台词/场景, 各剧 script_md 完全独立",
    "",
    "## 关于 image_briefs (素材图规划, 重要)",
    "",
    "- 每个 character / scene 必须给 `image_briefs` 数组, 描述「这个素材需要几张参考图、每张要画什么」",
    "- **每张 brief 必填**: `angle` + `description`",
    "- **数量自决**: 角色多形象 → 2-4 张; 简单 prop / 一次性场景 → 1 张. 单 element 上限 8 张",
    "- 第 1 张默认作「典型代表图」(代表外貌锚点), 后续张会自动以第 1 张为 i2i 参考保持五官一致",
    "- 如果实在没想清楚要几张, 至少给 1 张 angle='标准像' 兜底",
  ].join("\n");
}

/**
 * 多项目 preview-prompt — 给前端"复制完整提示词"按钮.
 */
export function composeBatchPromptMultiOnly(input: BatchGenerateMultiInput): {
  prompt: string;
  resolved_params: BatchGenerateMultiInput;
} {
  return {
    prompt: composeBatchPromptMulti(input),
    resolved_params: input,
  };
}
