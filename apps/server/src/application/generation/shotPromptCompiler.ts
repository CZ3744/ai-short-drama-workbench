/**
 * shotPromptCompiler — 分镜「提示词编译器」(纯函数, 无 I/O).
 *
 * 类比 assetPromptCompiler — 但面向分镜而非素材。
 *
 * 设计要点 (PRODUCT §4.1.1 "提示词预览面板常驻可见可检查"):
 *   - 纯函数, 无 fs / 无 provider / 无网络, 可单测, 可被任何 controller 复用。
 *   - PM 核心诉求「提示词自包含」: 每次发给图像/视频模型的 full_prompt 都必须
 *     可独立喂给一个空上下文模型并正确完成任务。
 *   - 关键参数 (camera_movement / lighting / mood / pace / duration ...)
 *     **必须进入提示词主体**, 而非只作为独立字段。
 *   - 素材引用 (character / scene / element) 已解析的展开数据进 prompt,
 *     **不是 id**。
 *
 * 它产出两种东西:
 *   1. compileShotImagePrompt() — 拼出一段合格的自包含分镜首帧图像提示词。
 *   2. compileShotVideoPrompt() — 拼出一段合格的自包含分镜视频运动提示词。
 *
 * 本文件刻意只认下面这组扁平输入接口, 不 import ShotData / Character / Scene
 * 等聚合根类型, 这样它与 seriesStore / drama types 完全解耦, 谁变都不影响它。
 *
 * 注: 此 compiler 不调 LLM。它只做模板拼接 — 如果上层希望 LLM 润色,
 * 调用方先用 LLM 把零散的 user_extra / 素材描述 polish 成一段中文, 再喂回来。
 */

import { CAMERA_MOVEMENT_PRESET_MAP } from "./cameraMovementPresets.js";

// ─── 输入 / 输出契约 ────────────────────────────────────────────────

export interface ShotPromptInput {
  // 来自 shot 本体
  shot_index?: number;
  title?: string;
  action: string;
  dialogue?: string;
  voiceover?: string;
  notes?: string;

  // 关键参数 — 都进提示词主体
  shot_type?: string;
  camera_movement?: string;
  style?: string;
  time_of_day?: string;
  lighting?: string;
  mood?: string;
  duration_sec?: number;
  pace?: string;
  /**
   * W7 (2026-05-16):画幅必须进 prompt 文本,否则模型可能生成与 orchestrator
   * `resolveRenderSpec(shot.aspect_ratio)` clamp 出的尺寸不匹配的内容。
   * 值如 "16:9" / "9:16" / "1:1" / "4:3" / "3:4"。
   */
  aspect_ratio?: string;

  // 素材引用 (已解析展开, 不是 id)
  characters?: Array<{
    name: string;
    description?: string;
    primary_image_note?: string;
    /**
     * 2026-05-26 W1 组合性 — 该角色本镜穿的服装造型 (caller 已 resolve 出 wardrobe element).
     * 优先级 caller 端处理: shot.wardrobe_id 显式 > character.wardrobe_element_ids[0] 默认 > undefined.
     * undefined 时不在角色描述中拼服装段, 模型按 character.outfit 兜底.
     */
    wardrobe?: { name: string; description?: string };
    /**
     * 2026-05-26 W1 组合性 — 该角色常带的道具 (caller 端读 character.prop_element_ids 后 resolve).
     * 与 shot_props (本镜独立出现的道具) 互补.
     */
    props?: Array<{ name: string; description?: string }>;
  }>;
  scene?: {
    name: string;
    description?: string;
    primary_image_note?: string;
  };
  elements?: Array<{
    kind: string;
    name: string;
    description?: string;
  }>;
  /**
   * 2026-05-26 W1 组合性 — 本镜独立出现的道具 (非任何角色常带).
   * 与 characters[i].props 互补, 互不重复 (caller 端去重).
   * 用例: 角色平时不带枪, 本镜剧情桌上放把枪.
   */
  shot_props?: Array<{ name: string; description?: string }>;

  // 用户额外要求 / 本次修改意见 (例如废案库微调输入框、UI 自由文本框)
  user_extra?: string;

  // i2i / ref 上下文 (可选)
  has_first_frame_ref?: boolean;
  has_end_frame_ref?: boolean;

  /**
   * 2026-05-22 — 同时上传给模型的参考图清单 (按发送顺序排, 1-based 索引对应 reference_images[i]).
   * video prompt 文字会显式列出每张图的角色, 让模型知道"图 #1 是首帧, 图 #2 是尾帧..."
   *
   * 用户原话: "分镜视频生成提示词是不是没在文字中提到要使用同时上传的图片素材?
   * 首帧/尾帧/关键帧等如果有 0~n 张, 如何确保一一正确加入了文字提示词要求参考?"
   *
   * 0 张时 prompt 写"无参考图, 纯文本生视频"; N 张时一一列出.
   */
  reference_images_layout?: Array<{
    /**
     * 2026-05-26 W1 加 character_wardrobe / character_prop / shot_prop 三种新 role,
     * 让角色服装造型 / 角色常带道具 / 本镜独立道具的参考图能在"上传清单"段被明确标注.
     */
    role:
      | "first_frame"
      | "end_frame"
      | "key_frame"
      | "character_primary"
      | "character_wardrobe"
      | "character_prop"
      | "scene_primary"
      | "element_primary"
      | "shot_prop"
      | "user_reference";
    label: string; // 人话: "首帧 (picked first frame)" / "角色「林小鹿」主图" 等
    position_sec?: number; // 关键帧的时间点 (秒), 用于 t=1.5s 这种表述
  }>;

  // 负向提示词扩展
  extra_negative?: string;

  /**
   * 2026-05-27 — 跨分镜风格一致性 (用户原话: "整部剧的风格就不怎么统一... 通常
   * 这种问题成熟短剧生成流是怎么解决的? 需不需要把全集的剧本作为背景信息喂给
   * 模型?"). 成熟方案 (Runway/Sora/Higgsfield): Style Bible 全剧美学指南 +
   * Episode Brief 本集情绪曲线 + Adjacent Shot Context 邻镜上下文, 一并喂模型,
   * 让单镜决策时知道全局.
   *
   * 字段都是可选, caller 不传走老行为 (无全局注入).
   */
  /** 全剧背景: 题材 / 整体题材色调 (用 series.title + synopsis 派生即可) */
  series_synopsis?: string;
  /** 全剧美学指南 (色调 / 光线 / 摄影 / 服装 / 色板). 没填时省略 */
  series_visual_style?: string;
  /** 本集语境: 一句话情绪/节奏摘要 (例 "开场紧张, 末段揭示反转") */
  episode_brief?: string;
  /** 本镜在本集的位置: { current, total } (例 3/12 让模型知道是中段不是开场) */
  shot_position?: { current: number; total: number };
  /** 前一镜的简述 (action / title), 让模型知道接什么 */
  prev_shot_brief?: string;
  /** 后一镜的简述, 让模型知道接到什么 */
  next_shot_brief?: string;
}

export interface CompiledShotPrompt {
  /** 最终发给模型的完整自包含提示词 */
  full_prompt: string;
  /** 负向提示词 */
  negative_prompt: string;
  /** 拆段 — 给 UI 高亮 / 审核弹窗展示 */
  segments: { label: string; text: string }[];
}

// ─── 通用文案 / 兜底 ──────────────────────────────────────────────

// 2026-05-27 — 加入"反多分镜/反故事板/反拼贴"关键词. 用户截图反馈 gpt-image-1
// 把一帧画成 5-6 格九宫格风格, 这是 ChatGPT image 模型的典型故事板倾向.
// 2026-05-28 — AI 出图打磨: 补业内 SD/FLUX/MJ 标准 negative 集合 (人脸/手指/身体畸形
// /低质量/水印 等), 跟 openclawLocal.ts 本地 SD 路径已有的"lowres, bad anatomy,
// bad hands, missing fingers, extra digit, ..." 对齐. 短剧场景下两个老痛点:
//   1) 角色多张脸 (多 face / face swap drift) — multi-faced characters / two faces
//   2) 配角抢戏 / 凭空多人 (crowd / extra people) — 短剧通常一镜≤2人
const DEFAULT_NEGATIVE_IMAGE =
  // 中文原文 — 保留给主要走中文 prompt 的模型 (Doubao / Kling i2i / ChatGPT image-1)
  "低分辨率, 模糊, 畸变, 多余的肢体, 多余的手指, 缺指, 文字水印, 杂乱背景, 与剧本不符的额外元素, " +
  "多张脸, 双面人, 脸部扭曲, 五官错位, 眼睛不对称, 比例失调, 身体畸形, 业余作品, " +
  "凭空多余人物, 配角抢戏占用主体位置, " +
  "多分镜拼贴, 故事板, 九宫格, 分屏, 多格画面, 连环画, 漫画分格, " +
  // 英文同义 — 给 SD / FLUX / 国际 i2i 通道 (Runway / Pika / Luma) 准确识别
  "lowres, blurry, bad anatomy, bad hands, missing fingers, extra digits, extra limbs, " +
  "deformed face, asymmetric eyes, mutated proportions, malformed body, ugly, amateur, " +
  "text, watermark, signature, username, jpeg artifacts, " +
  "two faces, multiple faces, face swap, duplicate character, " +
  "crowd background actors stealing focus, " +
  "split screen, collage, grid layout, multiple panels, storyboard, comic strip, " +
  "picture-in-picture, image grid, mosaic of frames";

// 2026-05-28 — 视频 negative 同步补"运动模糊过度 / 闪屏 / 多重曝光 / 重复角色"等
// 视频模型 (Runway Gen-3, Kling, Luma Ray, Pika 2.0) 常见 drift 关键词.
const DEFAULT_NEGATIVE_VIDEO =
  "画面抖动, 闪烁, 主体扭曲, 帧间跳变, 多余的转场, 水印, 与首帧风格不一致的镜头, " +
  "重影残影, 角色面部漂移, 突然出现的新人物, 镜头扭曲变形, 速度异常, " +
  "flicker, ghosting, double exposure, motion artifacts, " +
  "character face drift, identity drift, sudden new character appearing, " +
  "uncontrolled camera shake, unnatural speed ramping, distorted geometry";

// ─── 工具 ──────────────────────────────────────────────────────────

function trimToNonEmpty(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

/**
 * 2026-05-20 Wave T hotfix — 把 @ chip token 转回人话给 LLM 看.
 *
 * **核心铁律**: 任何流向 LLM / TTS / 字幕的字符串必须先经此函数,
 * 防止 chip token 字面流出污染外部 API.
 *
 * 转换规则:
 *   - `@角色:林深.img:xyz` → `林深`(长格式 + image_id)
 *   - `@角色:林深` → `林深`(长格式)
 *   - `@场景:茶水间` → `茶水间`
 *   - `@物件:旧怀表` → `旧怀表`
 *   - `@char:xxx` / `@scene:xxx` → 同上(英文 alias)
 *   - `@林深`(短格式, input.characters/scenes/elements 命中)→ `林深`
 *   - `@xxx`(短格式, 不命中)→ 保留(可能是用户在写邮件地址等真 @)
 */
function humanizeMentionTokens(value: string, input?: ShotPromptInput): string {
  if (!value) return value;
  let out = value;

  // 1) 长格式中文 `@角色:林深` / `@场景:xxx` / `@物件:xxx`(含可选 .img:xxx)
  out = out.replace(
    /@(?:角色|场景|物件):([^.@\s\n，。；;、]+)(?:\.img:[A-Za-z0-9_-]+)?/g,
    "$1",
  );

  // 2) 长格式英文 alias `@char:xxx` / `@scene:xxx`
  out = out.replace(
    /@(?:char|scene):([^.@\s\n，。；;、]+)(?:\.img:[A-Za-z0-9_-]+)?/g,
    "$1",
  );

  // 3) 短格式 `@林深` — 用 input 的 characters / scene / elements 反查
  if (input) {
    const names = new Set<string>();
    for (const c of input.characters ?? []) {
      const n = (c.name ?? "").trim();
      if (n) names.add(n);
    }
    if (input.scene?.name) names.add(input.scene.name.trim());
    for (const el of input.elements ?? []) {
      const n = (el.name ?? "").trim();
      if (n) names.add(n);
    }
    // 按 name 长度降序避免 "@林深" 被切成 "@林"
    const namesByLengthDesc = Array.from(names).sort((a, b) => b.length - a.length);
    for (const name of namesByLengthDesc) {
      const raw = `@${name}`;
      if (out.includes(raw)) out = out.split(raw).join(name);
    }
  }

  return out;
}

function joinNonEmpty(parts: Array<string | undefined | null>, sep = "\n"): string {
  return parts
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter((p) => p.length > 0)
    .join(sep);
}

function describeCharacters(
  chars: ShotPromptInput["characters"],
): string {
  if (!chars || chars.length === 0) return "";
  const lines: string[] = [];
  for (const c of chars) {
    const name = trimToNonEmpty(c.name);
    if (!name) continue;
    const desc = trimToNonEmpty(c.description);
    const note = trimToNonEmpty(c.primary_image_note);
    const parts: string[] = [`- ${name}`];
    if (desc) parts.push(`  外观: ${desc}`);
    // 2026-05-26 W1 组合性: 拼服装造型 (caller 已 resolve 出 wardrobe element)
    if (c.wardrobe) {
      const wName = trimToNonEmpty(c.wardrobe.name);
      const wDesc = trimToNonEmpty(c.wardrobe.description);
      if (wName || wDesc) {
        const label = wName && wDesc ? `${wName} (${wDesc})` : (wName || wDesc);
        parts.push(`  服装: ${label}`);
      }
    }
    // 2026-05-26 W1 组合性: 拼常带道具
    if (c.props && c.props.length > 0) {
      const propLabels = c.props
        .map((p) => {
          const pn = trimToNonEmpty(p.name);
          const pd = trimToNonEmpty(p.description);
          if (!pn && !pd) return "";
          return pn && pd ? `${pn} (${pd})` : (pn || pd);
        })
        .filter(Boolean);
      if (propLabels.length > 0) parts.push(`  常带道具: ${propLabels.join(", ")}`);
    }
    if (note) parts.push(`  锚定主图: ${note}`);
    lines.push(parts.join("\n"));
  }
  return lines.join("\n");
}

/**
 * 2026-05-26 W1 组合性 — 本镜独立道具 (与角色常带道具分开列, 让模型清楚"这是本镜特有的").
 */
function describeShotProps(props: ShotPromptInput["shot_props"]): string {
  if (!props || props.length === 0) return "";
  const lines: string[] = [];
  for (const p of props) {
    const name = trimToNonEmpty(p.name);
    const desc = trimToNonEmpty(p.description);
    if (!name && !desc) continue;
    lines.push(name && desc ? `- ${name}: ${desc}` : `- ${name || desc}`);
  }
  return lines.join("\n");
}

function describeScene(scene: ShotPromptInput["scene"]): string {
  if (!scene) return "";
  const name = trimToNonEmpty(scene.name);
  if (!name) return "";
  const lines: string[] = [`场景: ${name}`];
  const desc = trimToNonEmpty(scene.description);
  if (desc) lines.push(`描述: ${desc}`);
  const note = trimToNonEmpty(scene.primary_image_note);
  if (note) lines.push(`锚定主图: ${note}`);
  return lines.join("\n");
}

function describeElements(els: ShotPromptInput["elements"]): string {
  if (!els || els.length === 0) return "";
  const lines: string[] = [];
  for (const el of els) {
    const name = trimToNonEmpty(el.name);
    if (!name) continue;
    const kind = trimToNonEmpty(el.kind) || "素材";
    const desc = trimToNonEmpty(el.description);
    lines.push(desc ? `- ${kind} · ${name}: ${desc}` : `- ${kind} · ${name}`);
  }
  return lines.join("\n");
}

function describeCameraParams(input: ShotPromptInput, includeDuration: boolean): string {
  const parts: string[] = [];
  if (trimToNonEmpty(input.shot_type)) parts.push(`景别: ${input.shot_type!.trim()}`);
  if (trimToNonEmpty(input.camera_movement)) {
    const v = input.camera_movement!.trim();
    const preset = CAMERA_MOVEMENT_PRESET_MAP[v];
    if (preset) {
      parts.push(`运镜: ${preset.label}（${preset.description}）`);
    } else {
      parts.push(`运镜: ${v}`);
    }
  }
  if (trimToNonEmpty(input.style)) parts.push(`视觉风格: ${input.style!.trim()}`);
  if (trimToNonEmpty(input.time_of_day)) parts.push(`时间: ${input.time_of_day!.trim()}`);
  if (trimToNonEmpty(input.lighting)) parts.push(`打光: ${input.lighting!.trim()}`);
  if (trimToNonEmpty(input.mood)) parts.push(`情绪: ${input.mood!.trim()}`);
  if (trimToNonEmpty(input.pace)) parts.push(`节奏: ${input.pace!.trim()}`);
  // W7 (2026-05-16): 画幅进 prompt — 防止模型生成与目标 aspect_ratio 不匹配的画面。
  if (trimToNonEmpty(input.aspect_ratio)) parts.push(`画幅: ${input.aspect_ratio!.trim()}`);
  if (includeDuration && typeof input.duration_sec === "number" && input.duration_sec > 0) {
    parts.push(`时长: ${input.duration_sec} 秒`);
  }
  return parts.join("\n");
}

function describeDialogueAndSubtext(input: ShotPromptInput): string {
  // 2026-05-20 Wave T hotfix — 对白 / 旁白 / 批注全过 humanizeMentionTokens,
  // 防止 `@角色:林深` 字面流向 LLM(也覆盖前端 chip token 漏入的情况)
  const parts: string[] = [];
  if (trimToNonEmpty(input.dialogue)) parts.push(`对白: ${humanizeMentionTokens(input.dialogue!.trim(), input)}`);
  if (trimToNonEmpty(input.voiceover)) parts.push(`旁白: ${humanizeMentionTokens(input.voiceover!.trim(), input)}`);
  if (trimToNonEmpty(input.notes)) parts.push(`用户批注: ${humanizeMentionTokens(input.notes!.trim(), input)}`);
  return parts.join("\n");
}

// ─── 通用启动词 (universal preamble) ─────────────────────────────

function buildImagePreamble(hasFirstFrameRef: boolean): string {
  const lines: string[] = [
    `你是一个图像生成工具, 正在为一部 AI 短剧的某一镜生成首帧画面。`,
    `这是单段几秒视频的起始静帧, 需要严格符合剧本节奏与全剧视觉一致性。`,
    // 2026-05-27 — 用户反馈"为什么生成的图片分镜是这种大分镜". ChatGPT 4o /
    // gpt-image-1 在描述带"动作 + 镜头"时容易把一帧拆成 5-6 格的"故事板/九宫格"
    // 拼贴风格. 显式禁止: 单帧 / 单镜头 / 单时刻, 不画分镜/故事板/拼贴/分屏.
    `严格要求: 输出**单张完整画面**, 是这一镜某一瞬间的单帧静止图. ` +
      `不要画成多分镜拼贴、不要画成故事板分格、不要画成连环画、不要画成分屏/九宫格. ` +
      `画面就是一个独立完整的电影画幅, 占满整张图.`,
    `Output rules: SINGLE FRAME ONLY. No storyboard, no collage, no grid, no split screen, ` +
      `no multiple panels, no comic strip layout. Just one cinematic still image filling the canvas.`,
    // 2026-05-28 — AI 出图打磨: 业内中文短剧 (即梦 / 可灵 / 智谱清影) 标准 prompt
    // 五段式: [主体]+[场景]+[氛围]+[镜头]+[质量]. 教模型按这个层级理解 prompt
    // 各段, 而不是把"角色描述 + 场景描述 + 运镜参数"当成一堆并列短句乱解析.
    // 五段式是 Doubao / Kling / ChatGPT image 模型在中文短剧场景下经验性最稳的结构.
    `理解优先级 (按业内中文短剧 prompt 五段式): ` +
      `【主体: 谁/什么】 → 【场景: 哪里/环境】 → 【氛围: 情绪/光线/色调】 → ` +
      `【镜头: 景别/运镜/角度】 → 【质量: 写实/动漫/电影感/分辨率】. ` +
      `下文按"出场人物 / 场景 / 关键参数"分段, 请对照五段式合并理解, 严格保留每段约束.`,
  ];
  if (hasFirstFrameRef) {
    lines.push(
      `我同时上传了参考图。请在保持其主体一致性的前提下, 按下方关键参数与用户要求微调; 不要改动未提及的部分。`,
    );
  }
  lines.push(`请严格按下述要求出图; 不要添加未要求的额外元素。`);
  return lines.join("\n");
}

/**
 * 2026-05-27 — 跨分镜一致性 segments builder.
 *
 * 把 series / episode / 邻镜信息渲成 prompt segments, 让模型生成单镜时知道:
 *   - 自己在整部剧的什么题材里 (series_synopsis)
 *   - 全剧统一的视觉语言 (series_visual_style)
 *   - 这一集要走什么情绪曲线 (episode_brief)
 *   - 这一镜在本集的什么位置 (shot_position)
 *   - 上一镜画什么, 下一镜画什么 (prev/next_shot_brief)
 *
 * 没有传入字段时跳过对应段, 不强制要求 caller 全填.
 */
function buildContextSegments(input: ShotPromptInput): { label: string; text: string }[] {
  const segments: { label: string; text: string }[] = [];

  const synopsis = trimToNonEmpty(input.series_synopsis);
  const visualStyle = trimToNonEmpty(input.series_visual_style);
  if (synopsis || visualStyle) {
    const lines: string[] = [];
    if (synopsis) lines.push(`题材 / 故事背景: ${synopsis}`);
    if (visualStyle) lines.push(`全剧视觉风格 (必须严格遵守, 跨分镜一致): ${visualStyle}`);
    segments.push({ label: "全剧基调 (跨分镜风格锚定)", text: lines.join("\n") });
  }

  const epBrief = trimToNonEmpty(input.episode_brief);
  const pos = input.shot_position;
  if (epBrief || pos) {
    const lines: string[] = [];
    if (epBrief) lines.push(`本集情绪 / 节奏: ${epBrief}`);
    if (pos && typeof pos.current === "number" && typeof pos.total === "number") {
      const phase =
        pos.current === 1
          ? "开场镜 (需要钩子吸引观众)"
          : pos.current === pos.total
            ? "结尾镜 (需要收束 / 留白)"
            : pos.current <= Math.ceil(pos.total / 3)
              ? "前段 (铺垫氛围)"
              : pos.current >= Math.ceil((pos.total * 2) / 3)
                ? "后段 (推向高潮 / 收尾)"
                : "中段 (推进剧情)";
      lines.push(`本镜在本集位置: 第 ${pos.current} / ${pos.total} 镜 — ${phase}`);
    }
    segments.push({ label: "本集语境", text: lines.join("\n") });
  }

  const prev = trimToNonEmpty(input.prev_shot_brief);
  const next = trimToNonEmpty(input.next_shot_brief);
  if (prev || next) {
    const lines: string[] = [];
    if (prev) lines.push(`上一镜画的是: ${prev}`);
    if (next) lines.push(`下一镜画的是: ${next}`);
    lines.push(`请让本镜视觉跟上下镜自然连接 (光线 / 色调 / 主体位置 不要突变).`);
    segments.push({ label: "前后镜上下文 (保持连续)", text: lines.join("\n") });
  }

  return segments;
}

function buildVideoPreamble(
  durationSec: number | undefined,
  hasFirstFrameRef: boolean,
  hasEndFrameRef: boolean,
): string {
  const d = typeof durationSec === "number" && durationSec > 0 ? `${durationSec}` : "几";
  const lines: string[] = [
    `你是一个视频生成工具, 正在为一部 AI 短剧的某一镜生成 ${d} 秒短视频。`,
  ];
  if (hasFirstFrameRef && hasEndFrameRef) {
    lines.push(
      `已锁定首帧与尾帧, 请在两帧之间完成镜头运动, 保持主体一致, 不要插入额外镜头切换。`,
    );
  } else if (hasFirstFrameRef) {
    lines.push(
      `已锁定首帧, 请在此基础上完成镜头运动, 保持主体一致, 不要切换到陌生场景。`,
    );
  } else {
    lines.push(`本次为纯文本生视频, 请按下述要求合成一段连贯镜头。`);
  }
  lines.push(`请严格按下述要求出镜; 不要添加未要求的额外转场或镜头。`);
  return lines.join("\n");
}

/**
 * 2026-05-22 — 把同时上传的参考图列成文字清单, 让模型知道"图 #1 是首帧 / 图 #2 是
 * 尾帧 / 图 #3-5 是关键帧 / 图 #6 是角色主图..."
 *
 * 用户原话: "首帧/尾帧/关键帧等如果有 0~n 张, 如何确保一一正确加入了文字提示词要求参考?"
 *
 * 2026-05-28 — AI 出图打磨: 每个 role 加默认权重 + 业内常见 IP-Adapter / Reference
 * Net 权重对照 (0-1). 即使 HTTP image API 不接 weight 字段, prompt 文字里说清楚
 * "图 #1 角色主图 — 强约束 ≈0.85" 可以让 ChatGPT 4o vision 等模型在 narrative
 * 层面理解优先级, 不会把"角色服装参考图"当主体画.
 */
interface RoleSpec {
  label: string;
  /** 业内 IP-Adapter / Reference Net 推荐权重 (0-1), 仅文字提示给模型理解优先级 */
  default_weight: number;
  /** 给模型的语义说明 — "强约束 vs 仅参考" */
  strength_note: string;
}

const ROLE_SPEC: Record<string, RoleSpec> = {
  first_frame: {
    label: "首帧锚点(视频从此帧开始)",
    default_weight: 1.0,
    strength_note: "极强约束 — 视频必须以此帧为第 1 帧, 主体/构图/色调严格保留",
  },
  end_frame: {
    label: "尾帧锚点(视频在此帧结束)",
    default_weight: 1.0,
    strength_note: "极强约束 — 视频必须以此帧为最末帧, 中间过渡平滑到此帧",
  },
  key_frame: {
    label: "关键帧(必须在视频运动中经过)",
    default_weight: 0.9,
    strength_note: "强约束 — 视频运动到对应时间点时必须呈现此帧主体/构图",
  },
  character_primary: {
    label: "角色主图(用于人物外观一致性)",
    default_weight: 0.85,
    strength_note: "强约束 — 人物面部/发型/体型/气质严格保留, 表情/姿势可按本镜动作变化",
  },
  // 2026-05-26 W1 组合性 — 三个新 role
  character_wardrobe: {
    label: "角色服装造型(用于服装外观一致性)",
    default_weight: 0.6,
    strength_note: "中等约束 — 仅参考服装款式/颜色/纹理, 不参考此图的人物身份或姿势",
  },
  character_prop: {
    label: "角色常带道具(用于道具外观一致性)",
    default_weight: 0.55,
    strength_note: "中等约束 — 仅参考此道具的外形/颜色/质感, 道具在画面中的位置由本镜动作决定",
  },
  scene_primary: {
    label: "场景主图(用于场景视觉一致性)",
    default_weight: 0.7,
    strength_note: "强约束 — 场景的建筑/家具/光线/色调/视角范围严格保留, 人物位置可按本镜动作变化",
  },
  element_primary: {
    label: "选用素材主图(用于素材外观一致性)",
    default_weight: 0.6,
    strength_note: "中等约束 — 参考素材的外形/材质/颜色, 在画面中的位置/大小由本镜动作决定",
  },
  shot_prop: {
    label: "本镜独立道具(本镜剧情特有,非角色常带)",
    default_weight: 0.6,
    strength_note: "中等约束 — 仅本镜出现的道具, 参考其外形/颜色, 不要在后续镜头延续",
  },
  user_reference: {
    label: "用户附加参考图",
    default_weight: 0.5,
    strength_note: "弱-中等约束 — 用户主动附加, 仅作风格 / 氛围 / 局部参考",
  },
};

/**
 * 2026-05-28 — 优先级排序: 锚点帧 > 角色主图 > 场景主图 > 服装/道具/素材 > 用户附加.
 * 列表顺序直接影响模型对"哪张更重要"的理解 (业内 LLM 视觉输入按 index 1 优先级最高).
 */
const ROLE_PRIORITY: Record<string, number> = {
  first_frame: 1,
  end_frame: 2,
  key_frame: 3,
  character_primary: 4,
  scene_primary: 5,
  character_wardrobe: 6,
  character_prop: 7,
  element_primary: 8,
  shot_prop: 9,
  user_reference: 10,
};

function buildReferenceImagesSection(
  layout: NonNullable<ShotPromptInput["reference_images_layout"]>,
): string {
  if (layout.length === 0) {
    return "本次未附参考图, 完全按上方文字描述生成。";
  }
  // 2026-05-28 — 按 ROLE_PRIORITY 稳定排序, 让模型在 narrative 层面拿到优先级最高的图
  // 在最前 (业内 vision 模型对 index 1 的图权重最高).
  const sortedLayout = layout
    .map((ref, originalIndex) => ({ ref, originalIndex }))
    .sort((a, b) => {
      const pa = ROLE_PRIORITY[a.ref.role] ?? 99;
      const pb = ROLE_PRIORITY[b.ref.role] ?? 99;
      if (pa !== pb) return pa - pb;
      return a.originalIndex - b.originalIndex;
    })
    .map((entry) => entry.ref);

  const lines: string[] = [
    `本次同时上传了 ${sortedLayout.length} 张参考图 (按下方顺序对应 reference_images[0]~reference_images[${sortedLayout.length - 1}], 顺序已按重要性排序, 越靠前权重越高):`,
  ];
  sortedLayout.forEach((ref, i) => {
    const spec = ROLE_SPEC[ref.role];
    const roleLabel = spec?.label ?? "参考图";
    const weightTag = spec ? ` · 推荐权重 ${spec.default_weight.toFixed(2)}` : "";
    const timeNote = typeof ref.position_sec === "number" && ref.position_sec > 0
      ? ` · 在 t=${ref.position_sec}s 处`
      : "";
    lines.push(`  - 图 #${i + 1}: ${roleLabel}${weightTag}${timeNote} — ${ref.label}`);
    if (spec?.strength_note) {
      lines.push(`    约束说明: ${spec.strength_note}`);
    }
  });
  lines.push(`请严格按上述说明区分每张图的约束强度: 锚点帧/角色/场景类是"必须像"的强约束, ` +
    `服装/道具/用户附加类是"仅参考相应元素"的中弱约束 (不要把服装参考图的人脸或姿势画进画面)。 ` +
    `不要混淆顺序, 不要忽略任何一张。`);
  return lines.join("\n");
}

// ─── 1. 首帧图像提示词 ──────────────────────────────────────────

export function compileShotImagePrompt(
  input: ShotPromptInput,
): CompiledShotPrompt {
  const segments: { label: string; text: string }[] = [];

  const preamble = buildImagePreamble(!!input.has_first_frame_ref);
  segments.push({ label: "通用启动词", text: preamble });

  // 2026-05-27 — 跨分镜一致性: 全剧基调 / 本集语境 / 前后镜上下文 注入到 prompt 前段,
  // 让模型生成单镜时知道全局位置. 解决用户反馈"不同分镜独立生成, 整部剧风格不统一".
  const contextSegments = buildContextSegments(input);
  for (const seg of contextSegments) segments.push(seg);

  // 分镜上下文 = 编号 + 标题 + action
  const shotCtxParts: string[] = [];
  if (typeof input.shot_index === "number") {
    shotCtxParts.push(`分镜序号: ${input.shot_index}`);
  }
  if (trimToNonEmpty(input.title)) {
    shotCtxParts.push(`分镜标题: ${input.title!.trim()}`);
  }
  if (trimToNonEmpty(input.action)) {
    shotCtxParts.push(`画面动作: ${humanizeMentionTokens(input.action!.trim(), input)}`);
  }
  const shotCtx = shotCtxParts.join("\n");
  if (shotCtx) segments.push({ label: "分镜上下文", text: shotCtx });

  const cameraParams = describeCameraParams(input, false);
  if (cameraParams) segments.push({ label: "关键参数", text: cameraParams });

  const charsText = describeCharacters(input.characters);
  if (charsText) segments.push({ label: "出场人物", text: charsText });

  const sceneText = describeScene(input.scene);
  if (sceneText) segments.push({ label: "场景", text: sceneText });

  const elementsText = describeElements(input.elements);
  if (elementsText) segments.push({ label: "选用素材", text: elementsText });

  // 2026-05-26 W1 组合性 — 本镜独立道具 (角色常带道具已并入"出场人物"段)
  const shotPropsText = describeShotProps(input.shot_props);
  if (shotPropsText) segments.push({ label: "本镜独立道具 (非角色常带)", text: shotPropsText });

  const subtext = describeDialogueAndSubtext(input);
  if (subtext) segments.push({ label: "潜台词参考 (供画面氛围)", text: subtext });

  // 2026-05-22 — 同 video, image prompt 也说明 reference_images 每张的角色
  if (input.reference_images_layout) {
    segments.push({
      label: "同时上传的参考图清单",
      text: buildReferenceImagesSection(input.reference_images_layout),
    });
  }

  const extra = trimToNonEmpty(input.user_extra);
  if (extra) segments.push({ label: "用户额外要求", text: extra });

  const full_prompt = segments
    .map((s) => `【${s.label}】\n${s.text}`)
    .join("\n\n")
    .trim();

  const negative_prompt = joinNonEmpty(
    [DEFAULT_NEGATIVE_IMAGE, trimToNonEmpty(input.extra_negative)],
    ", ",
  );

  return { full_prompt, negative_prompt, segments };
}

// ─── 1b. Shot prompt LLM 润色 meta-prompt ───────────────────────
//
// 2026-05-28 — AI 出图打磨: caller (前端 ShotStagePage / autoPipelineRunner / 用户
// 点"LLM 润色") 可调本函数, 把零散字段 → 让文字 LLM 润色成业内 5 段式高质量
// prompt 再喂图像/视频模型. 对标 assetPromptCompiler.buildLlmPolishMessages.
//
// 用途: 当用户在 user_extra 写得很碎 (e.g. "再压暗,夜景,人冷漠"), 或自动 pipeline
// 想统一拔高 prompt 质量时, 调本函数走 LLM 一遍. LLM 输出的 polished_prompt 再喂
// compileShotImagePrompt 的 user_extra (或直接当 full_prompt 用).
//
// LLM 推荐: 用 LLM provider 链 (qclaw_gateway > openclaw_gateway > claude_code 等),
// 廉价快速模型即可 (Gemini Flash / Haiku / 国产廉价模型), 不需 Opus 级.

export interface ShotLlmPolishMessages {
  system: string;
  user: string;
}

/**
 * 2026-05-28 — 给文字 LLM 的润色 prompt. system 教 LLM 按业内 5 段式写
 * (subject/scene/style/camera/quality), user 提供本镜的所有结构化字段.
 *
 * 输出: LLM 应返一段中文 prompt 正文 (无 markdown, 无 explanation), caller 把
 * 它当 user_extra 喂 compileShotImagePrompt 或直接覆盖 full_prompt.
 *
 * 解耦边界: 不调 LLM (纯 helper), caller 自己用 packages/providers LLM 调链.
 */
export function buildShotLlmPolishMessages(
  input: ShotPromptInput,
  mode: "image" | "video" = "image",
): ShotLlmPolishMessages {
  const isVideo = mode === "video";
  const system = [
    `我在做一个 AI 短剧的单镜${isVideo ? "视频" : "首帧画面"}生成. 请按业内中文短剧 prompt 五段式, ` +
      `把下面这些零散结构化字段, 润色成一段【自包含、可以直接发给${isVideo ? "视频" : "图像"}生成模型】的中文 prompt.`,
    "",
    "硬性要求:",
    "- 严格按 5 段式: 【主体: 谁/什么】 → 【场景: 哪里/环境】 → 【氛围: 情绪/光线/色调】 → " +
      `【镜头: 景别/运镜/角度${isVideo ? "/时长" : ""}】 → 【质量: 风格/分辨率/电影感】.`,
    "- 角色 / 场景 / 服装 / 道具 的描述必须用具体外观特征 (发型/颜色/材质/形状), 不要只用名字.",
    "- 严禁出现「故事板/分镜拼贴/分屏/九宫格/连环画」等多帧布局描述; 这是单帧/单镜.",
    "- 输出只含 prompt 正文, 不要 markdown 标题、不要前后缀解释、不要 \"以下是…\" 这种引子.",
    `- 输出长度控制在 250-600 字之间 (短剧${isVideo ? "视频" : "首帧"}模型上下文偏好这个区间).`,
    isVideo
      ? "- 视频专属: 必须明确写出镜头运动 (推/拉/摇/移/跟) 和节奏 (slow/moderate/fast), 若锁定首/尾帧需明示."
      : "- 首帧专属: 必须描述画面中主体的姿势/表情/位置, 让模型知道 \"这个瞬间\" 是什么样子.",
  ].join("\n");

  const lines: string[] = [];

  // 全剧 / 本集 上下文 (注入到 LLM, 让 LLM 润色时知道全剧锚定)
  const synopsis = trimToNonEmpty(input.series_synopsis);
  if (synopsis) lines.push(`【全剧背景】 ${synopsis}`);
  const visualStyle = trimToNonEmpty(input.series_visual_style);
  if (visualStyle) lines.push(`【全剧视觉风格 (必须严格遵守)】 ${visualStyle}`);
  const epBrief = trimToNonEmpty(input.episode_brief);
  if (epBrief) lines.push(`【本集情绪 / 节奏】 ${epBrief}`);
  if (input.shot_position) {
    lines.push(`【本镜在本集位置】 第 ${input.shot_position.current} / ${input.shot_position.total} 镜`);
  }

  // 分镜本身
  if (typeof input.shot_index === "number") lines.push(`分镜序号: ${input.shot_index}`);
  if (trimToNonEmpty(input.title)) lines.push(`分镜标题: ${input.title!.trim()}`);
  if (trimToNonEmpty(input.action)) {
    lines.push(`画面动作: ${humanizeMentionTokens(input.action!.trim(), input)}`);
  }
  if (trimToNonEmpty(input.shot_type)) lines.push(`景别: ${input.shot_type!.trim()}`);
  if (trimToNonEmpty(input.camera_movement)) lines.push(`运镜: ${input.camera_movement!.trim()}`);
  if (trimToNonEmpty(input.style)) lines.push(`视觉风格: ${input.style!.trim()}`);
  if (trimToNonEmpty(input.time_of_day)) lines.push(`时间: ${input.time_of_day!.trim()}`);
  if (trimToNonEmpty(input.lighting)) lines.push(`打光: ${input.lighting!.trim()}`);
  if (trimToNonEmpty(input.mood)) lines.push(`情绪: ${input.mood!.trim()}`);
  if (isVideo && typeof input.duration_sec === "number" && input.duration_sec > 0) {
    lines.push(`时长: ${input.duration_sec} 秒`);
  }
  if (isVideo && trimToNonEmpty(input.pace)) lines.push(`节奏: ${input.pace!.trim()}`);
  if (trimToNonEmpty(input.aspect_ratio)) lines.push(`画幅: ${input.aspect_ratio!.trim()}`);

  // entity
  const charsText = describeCharacters(input.characters);
  if (charsText) lines.push(`\n出场人物:\n${charsText}`);
  const sceneText = describeScene(input.scene);
  if (sceneText) lines.push(`\n${sceneText}`);
  const elementsText = describeElements(input.elements);
  if (elementsText) lines.push(`\n选用素材:\n${elementsText}`);
  const shotPropsText = describeShotProps(input.shot_props);
  if (shotPropsText) lines.push(`\n本镜独立道具:\n${shotPropsText}`);

  // 对白 / 旁白 (LLM 用作潜台词参考, 不输出对白文字)
  const subtext = describeDialogueAndSubtext(input);
  if (subtext) lines.push(`\n对白 / 旁白 (作为画面氛围参考, prompt 不要直出对白文字):\n${subtext}`);

  // 用户的本次额外要求 (最高优先级)
  const extra = trimToNonEmpty(input.user_extra);
  if (extra) lines.push(`\n【用户本次要求 (最重要, 请严格落到 prompt 里)】 ${extra}`);

  if (lines.length === 0) {
    lines.push(`(本镜无结构化数据, 请按 ${isVideo ? "视频" : "首帧"} 默认 5 段式生成一段通用 prompt)`);
  }

  return { system, user: lines.join("\n") };
}

// ─── 2. 视频运动提示词 ──────────────────────────────────────────

export function compileShotVideoPrompt(
  input: ShotPromptInput,
): CompiledShotPrompt {
  const segments: { label: string; text: string }[] = [];

  const preamble = buildVideoPreamble(
    input.duration_sec,
    !!input.has_first_frame_ref,
    !!input.has_end_frame_ref,
  );
  segments.push({ label: "通用启动词", text: preamble });

  // 2026-05-27 — 跨分镜一致性: 全剧基调 / 本集语境 / 前后镜上下文 (同 image)
  const contextSegments = buildContextSegments(input);
  for (const seg of contextSegments) segments.push(seg);

  const shotCtxParts: string[] = [];
  if (typeof input.shot_index === "number") {
    shotCtxParts.push(`分镜序号: ${input.shot_index}`);
  }
  if (trimToNonEmpty(input.title)) {
    shotCtxParts.push(`分镜标题: ${input.title!.trim()}`);
  }
  if (trimToNonEmpty(input.action)) {
    shotCtxParts.push(`画面动作: ${humanizeMentionTokens(input.action!.trim(), input)}`);
  }
  const shotCtx = shotCtxParts.join("\n");
  if (shotCtx) segments.push({ label: "分镜上下文", text: shotCtx });

  // 视频专属: camera_params 必须含 duration / 运镜 / pace
  const cameraParams = describeCameraParams(input, true);
  if (cameraParams) segments.push({ label: "关键参数 (运镜 / 时长 / 节奏)", text: cameraParams });

  const charsText = describeCharacters(input.characters);
  if (charsText) segments.push({ label: "出场人物", text: charsText });

  const sceneText = describeScene(input.scene);
  if (sceneText) segments.push({ label: "场景", text: sceneText });

  const elementsText = describeElements(input.elements);
  if (elementsText) segments.push({ label: "选用素材", text: elementsText });

  // 2026-05-26 W1 组合性 — 本镜独立道具 (角色常带道具已并入"出场人物"段)
  const shotPropsText = describeShotProps(input.shot_props);
  if (shotPropsText) segments.push({ label: "本镜独立道具 (非角色常带)", text: shotPropsText });

  const subtext = describeDialogueAndSubtext(input);
  if (subtext) segments.push({ label: "对白 / 旁白 / 潜台词", text: subtext });

  // 2026-05-22 — 参考图清单 (用户原话: "首帧/尾帧/关键帧等如果有 0~n 张, 如何确保
  // 一一正确加入了文字提示词要求参考?"). 在 user_extra 之前插入, 让模型清楚知道
  // reference_images 数组里每张图的角色 + 时间点.
  if (input.reference_images_layout) {
    segments.push({
      label: "同时上传的参考图清单",
      text: buildReferenceImagesSection(input.reference_images_layout),
    });
  }

  const extra = trimToNonEmpty(input.user_extra);
  if (extra) segments.push({ label: "用户额外要求", text: extra });

  const full_prompt = segments
    .map((s) => `【${s.label}】\n${s.text}`)
    .join("\n\n")
    .trim();

  const negative_prompt = joinNonEmpty(
    [DEFAULT_NEGATIVE_VIDEO, trimToNonEmpty(input.extra_negative)],
    ", ",
  );

  return { full_prompt, negative_prompt, segments };
}
