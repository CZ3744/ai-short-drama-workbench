/**
 * mentionParser — @ mention token 共享解析器(前后端单点定义).
 *
 * ── 两种 token 格式 ─────────────────────────────────────────────────
 *
 * 长格式 (legacy, 向后兼容):
 *   @角色:林深
 *   @角色:林深.img:img_abc123
 *   @场景:酒馆
 *   @物件:旧怀表.img:img_xyz
 *
 * 短格式 (2026-05-20, 用户偏好):
 *   @林深     (不显示 "@角色:" 前缀, kind 由 series 数据反查)
 *   @酒馆
 *   @旧怀表
 *
 * 短格式优点: 简洁可读, 用户输入 @ 后选实体, chip 显示 "@名字" 而不是 "@角色:名字".
 * 短格式约束: kind 必须由 caller 提供的 series 上下文反查; 重名时 fallback 到长格式.
 *
 * ── 提供的函数 ───────────────────────────────────────────────────────
 *
 *   - mentionTokenOf({kind, name, imageId?}) — 序列化长格式 token (legacy)
 *   - shortMentionTokenOf({name}) — 序列化短格式 token (推荐)
 *   - parseMentionTokens(text) — 提取所有长格式 token (legacy)
 *   - parseShortMentionTokens(text, ctx) — 提取短/长格式 token, 用 ctx 反查 kind
 *
 * ── 设计要点 ─────────────────────────────────────────────────────────
 *
 *   - 纯函数, 无 I/O, 前后端共享 import
 *   - 长格式 kind label 用中文人话 (角色 / 场景 / 物件)
 *   - token 内的 name 不允许包含 . / @ / 空格 / 换行 (避免歧义), 不符则 parser silently skip
 *   - imageId 可选, 用于"@小明.img:xxx" 二级展开 (指定具体图)
 *
 * ── 调用方 ───────────────────────────────────────────────────────────
 *
 *   - 前端 MentionTextarea — 用 shortMentionTokenOf 序列化短 token
 *   - 后端 planEpisodeStoryboard — 用 parseShortMentionTokens 从 action/dialogue/voiceover/prompt_img
 *     里提取 @ token → 反查 character_ids / scene_id / element_ids 落盘
 *   - 后端 shotStageController — 用 parseMentionTokens 扫描 prompt 文本 → 加 reference_asset_ids
 */

export type MentionKind = "character" | "scene" | "element";

/** 中文 kind label, 跟 token 字面对应 */
export const KIND_LABEL: Record<MentionKind, string> = {
  character: "角色",
  scene: "场景",
  element: "物件",
};

/** 反向 map: label → kind */
const LABEL_TO_KIND: Record<string, MentionKind> = {
  角色: "character",
  场景: "scene",
  物件: "element",
};

export interface ParsedMentionToken {
  kind: MentionKind;
  name: string;
  /** 可选 — 指定具体图(用于二级 mention) */
  imageId?: string;
  /** 原始 token 字符串(含 @ 前缀), 方便 caller 做替换 */
  raw: string;
}

/**
 * 把 mention 选中信息序列化成 token 字符串.
 *
 * @example
 *   mentionTokenOf({kind: "character", name: "林深"}) → "@角色:林深"
 *   mentionTokenOf({kind: "character", name: "林深", imageId: "img_abc"}) → "@角色:林深.img:img_abc"
 */
export function mentionTokenOf(input: {
  kind: MentionKind;
  name: string;
  imageId?: string;
}): string {
  const label = KIND_LABEL[input.kind];
  const safeName = input.name.replace(/[.@\s\n]/g, "_"); // 防御:name 内不该含分隔符
  const imgPart = input.imageId ? `.img:${input.imageId}` : "";
  return `@${label}:${safeName}${imgPart}`;
}

/**
 * 从任意文本提取所有 mention token.
 *
 * 解析规则:
 *   - 匹配 `@(角色|场景|物件):([^.@\s\n]+)(?:\.img:([^@\s\n]+))?`
 *   - name 必须非空 + 不含 . @ 空格 换行
 *   - imageId 可选, 字符同上但允许 .
 *   - 不匹配的 @ 字符 silently skip(可能是用户写的普通 @)
 *
 * 同一 token 重复出现只算一次(按 raw dedupe).
 *
 * @example
 *   parseMentionTokens("让 @角色:林深 走进 @场景:酒馆") →
 *     [{kind:"character", name:"林深", raw:"@角色:林深"}, {kind:"scene", name:"酒馆", raw:"@场景:酒馆"}]
 */
export function parseMentionTokens(text: string): ParsedMentionToken[] {
  if (!text || typeof text !== "string") return [];

  const pattern = /@(角色|场景|物件):([^.@\s\n]+)(?:\.img:([^@\s\n]+))?/g;
  const seen = new Set<string>();
  const out: ParsedMentionToken[] = [];

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const label = match[1];
    const name = match[2];
    const imageId = match[3];
    const raw = match[0];
    if (seen.has(raw)) continue;
    seen.add(raw);

    const kind = LABEL_TO_KIND[label];
    if (!kind) continue; // 防御:未知 label

    out.push({ kind, name, imageId, raw });
  }

  return out;
}

/**
 * 从多段文本批量提取 mention token, 自动 dedupe.
 *
 * 用法:扫描 shot 的所有 textarea 字段 (action / dialogue / voiceover / notes / user_extra) 一次性提取.
 */
export function parseMentionTokensFromTexts(...texts: Array<string | undefined>): ParsedMentionToken[] {
  const combined = texts.filter((t): t is string => typeof t === "string" && t.length > 0).join("\n");
  return parseMentionTokens(combined);
}

// ─── 短格式 (2026-05-20 用户偏好) ────────────────────────────────────

/**
 * Caller 反查上下文: series 已有的角色/场景/素材 name 列表.
 * - 用 name 作 key, 反查 kind. 重名时 disambiguator (kind 先后顺序: character > scene > element).
 * - 历史名 (含 placeholder) 都该提供, 否则短 token 解析不出来.
 */
export interface MentionLookupContext {
  characters: ReadonlyArray<{ name: string; id?: string }>;
  scenes: ReadonlyArray<{ name: string; id?: string }>;
  elements: ReadonlyArray<{ name: string; id?: string }>;
}

/**
 * 短格式 token 序列化.
 * 默认输出 `@<name>` 形式; 若 name 含 @ / 空格 / 换行 / 句末标点会被替换为 _ 避免歧义.
 *
 * @example
 *   shortMentionTokenOf({ name: "林深" }) → "@林深"
 *   shortMentionTokenOf({ name: "茶水间" }) → "@茶水间"
 */
export function shortMentionTokenOf(input: { name: string }): string {
  // name 内禁止字符更严格 — 短 token 没有 ":" 分隔符,后面 token 边界靠 name 本身边界识别.
  // 用 cleanShortName 去除冲突字符,避免 "@小 林" 被识别成 "@小" + " 林"
  const safeName = cleanShortName(input.name);
  return `@${safeName}`;
}

/** 清洗 short token name — 去除 token 边界冲突字符 */
function cleanShortName(name: string): string {
  return name.replace(/[@\s\n\r.,:;!?，。！？、；]/g, "_");
}

/**
 * 短/长混合格式 mention token 提取.
 *
 * 解析规则 (按优先级):
 *   1. 长格式 `@(角色|场景|物件):name[.img:imageId]?` — 显式 kind, 直接命中
 *   2. 短格式 `@name` — 用 ctx 反查:
 *      - 命中 ctx.characters[].name → kind=character
 *      - 命中 ctx.scenes[].name → kind=scene
 *      - 命中 ctx.elements[].name → kind=element
 *      - 都没命中 → 跳过 (不抛错)
 *   3. 重名 (同名跨 character/scene/element) → 优先 character > scene > element
 *      (短格式无法消歧, 让 LLM 必要时改用长格式)
 *
 * name 边界识别:
 *   - 长格式 name 不含 . @ 空格 换行
 *   - 短格式 name 不含 @ 空格 换行 标点 (中英文标点都断), 因为没有 ":" 分隔符
 *   - 短格式贪婪匹配 ctx 中存在的最长 name (避免 "@林深好" 被切成 "@林" 然后落到 "深好")
 *
 * @example
 *   parseShortMentionTokens("@林深 看着 @茶水间", {
 *     characters: [{name:"林深"}],
 *     scenes: [{name:"茶水间"}],
 *     elements: []
 *   })
 *   → [
 *       { kind:"character", name:"林深", raw:"@林深" },
 *       { kind:"scene", name:"茶水间", raw:"@茶水间" }
 *     ]
 *
 *   parseShortMentionTokens("@角色:林深 看着 @场景:茶水间", { ... }) — 长格式仍兼容
 */
export function parseShortMentionTokens(
  text: string,
  ctx: MentionLookupContext,
): ParsedMentionToken[] {
  if (!text || typeof text !== "string") return [];

  const out: ParsedMentionToken[] = [];
  const seen = new Set<string>();

  // 1) 先扫长格式 (优先), 因为长格式 token 内含 ":" 不会被短格式扫到
  const longPattern = /@(角色|场景|物件):([^.@\s\n]+)(?:\.img:([^@\s\n]+))?/g;
  const longMatches: Array<{ start: number; end: number }> = [];
  let mLong: RegExpExecArray | null;
  while ((mLong = longPattern.exec(text)) !== null) {
    const raw = mLong[0];
    const label = mLong[1];
    const name = mLong[2];
    const imageId = mLong[3];
    longMatches.push({ start: mLong.index, end: mLong.index + raw.length });
    if (seen.has(raw)) continue;
    seen.add(raw);
    const kind = LABEL_TO_KIND[label];
    if (!kind) continue;
    out.push({ kind, name, imageId, raw });
  }

  // 2) 短格式 — 跳过长格式 token 占用的 range
  // 短格式必须命中 ctx — 把 ctx 三池合并成 name → kind 优先级 map
  // 重名时 character > scene > element (短格式无法消歧, 用此优先级)
  const nameToKind = new Map<string, MentionKind>();
  // 注意倒序填充: 优先级低的先填,优先级高的覆盖
  for (const el of ctx.elements ?? []) {
    const n = (el?.name ?? "").trim();
    if (n) nameToKind.set(n, "element");
  }
  for (const sc of ctx.scenes ?? []) {
    const n = (sc?.name ?? "").trim();
    if (n) nameToKind.set(n, "scene");
  }
  for (const ch of ctx.characters ?? []) {
    const n = (ch?.name ?? "").trim();
    if (n) nameToKind.set(n, "character");
  }

  if (nameToKind.size === 0) return out;

  // 按 name 长度降序排,贪婪匹配最长 (避免 "@林深" 被切成 "@林" + "深")
  const namesByLengthDesc = Array.from(nameToKind.keys()).sort((a, b) => b.length - a.length);

  // 短格式扫描: 找 @ 字符,在每个 @ 后尝试匹配最长 ctx name
  // 短格式 token 边界靠 ctx name 长度本身 (e.g. 扫到 "@林深" 后 cursor 跳到 "林深" 之后)
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== "@") { i++; continue; }
    // 跳过长格式 token 的 @ (避免重复扫)
    if (longMatches.some(r => i >= r.start && i < r.end)) {
      i++;
      continue;
    }
    // 在 i+1 处尝试匹配 namesByLengthDesc
    let matched: { name: string; kind: MentionKind } | null = null;
    for (const candidate of namesByLengthDesc) {
      if (text.startsWith(candidate, i + 1)) {
        matched = { name: candidate, kind: nameToKind.get(candidate)! };
        break;
      }
    }
    if (matched) {
      const raw = `@${matched.name}`;
      if (!seen.has(raw)) {
        seen.add(raw);
        out.push({ kind: matched.kind, name: matched.name, raw });
      }
      i += 1 + matched.name.length;
    } else {
      i++;
    }
  }

  return out;
}

/**
 * 便利 wrapper — 从多段文本批量提取短/长 mention token (dedupe).
 *
 * 用法: planEpisodeStoryboard 落盘 shot 前一次性扫描 action/dialogue/voiceover/prompt_img.
 */
export function parseShortMentionTokensFromTexts(
  ctx: MentionLookupContext,
  ...texts: Array<string | undefined>
): ParsedMentionToken[] {
  const combined = texts.filter((t): t is string => typeof t === "string" && t.length > 0).join("\n");
  return parseShortMentionTokens(combined, ctx);
}

/**
 * 2026-05-21 — 给纯文本里出现的 entity name 自动加 @ prefix.
 *
 * LLM 经常不完全遵守 "action 里必须用短格式 @ 标注实体" 的 prompt 要求,
 * 输出 "冰箱门猛然被拉开,酸奶队长被抓走" 这种纯中文,但同时用 `characters` 数组兜底.
 * 结果: 后端 character_ids 正确, 但 action 文本里没 @ → 前端 MentionTextarea 无法 chip 化,
 * 违反 entity-first 一致性 (用户看不到"哪些名字被识别为引用").
 *
 * 本 helper 在落盘前 fallback annotate, 给所有已识别 entity name 加 @ prefix.
 * 用法: planEpisodeStoryboard / planSeriesStoryboard / batchSeries / importStoryboard
 * 在 character_ids / scene_id / element_ids 确定后, 对 action / dialogue / voiceover /
 * visual_focus / prompt_img / prompt_vid 调一次, 把结果作为落盘的最终文本.
 *
 * 边界规则:
 *   - 长 name 优先 (`林深` 比 `林` 先匹配, 避免误吃)
 *   - 已带 `@` 的 name 跳过 (LLM 已标过的不重复加 → 不会出现 `@@林深`)
 *   - 前面是汉字 / 英文字母 / 数字 / 下划线时跳过 (防 substring 误匹配: `林` 不匹配 `林深` 的 `林`)
 *   - 全局替换 (一个 name 在文本里出现 N 次, 每次独立位置都 annotate)
 */
export function annotateEntityMentions(
  text: string,
  ctx: MentionLookupContext,
): string {
  if (!text || typeof text !== "string") return text ?? "";
  const names = [
    ...ctx.characters.map((c) => c.name),
    ...ctx.scenes.map((s) => s.name),
    ...ctx.elements.map((e) => e.name),
  ]
    .filter((n): n is string => typeof n === "string" && n.trim().length > 0)
    .map((n) => n.trim())
    .sort((a, b) => b.length - a.length);
  if (names.length === 0) return text;
  let result = text;
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // (?<!@) — 跳过已带 @ 的 name; (?<![一-鿿\w]) — 前面不能是汉字/英文/数字/下划线(防 substring)
    const re = new RegExp(`(?<![@\\u4e00-\\u9fff\\w])${escaped}`, "g");
    result = result.replace(re, `@${name}`);
  }
  return result;
}

/**
 * 把 mention token 剥成可直接给字幕 / TTS 展示的人话。
 *
 * 与 humanizeMentionText 的差异: 不需要 series ctx,短格式 `@林深` 也会直接变成 `林深`。
 * 这适合已经进入最终渲染链路的文本,避免成片字幕里出现 `@角色:林深` 或 `@林深` 字面。
 */
export function stripMentionTokens(text: string): string {
  if (!text || typeof text !== "string") return text ?? "";
  return text
    .replace(/@[角色场景物件元素]:([^@\s，。；;、]+)(?:\.img:[^\s，。；;、]+)?/g, "$1")
    .replace(/@(?:char|character|scene|element|prop):([^@\s，。；;、]+)(?:\.img:[^\s，。；;、]+)?/gi, "$1")
    .replace(/@([^\s@,，。!！?？\n\r]{1,30})/g, "$1");
}

/**
 * 2026-05-20 Wave T hotfix — 把 @ chip token 转回人话给 LLM / TTS / 字幕用.
 *
 * **核心铁律**: 任何流向外部 API(LLM / TTS / 字幕烧录)的字符串都必须先经此函数,
 * 防止 chip token 字面流出导致:
 *   - LLM 看到 `@角色:林深` 字面被当垃圾内容
 *   - TTS 念出 "at 角色 冒号 林深"
 *   - 字幕烧出 `@角色:林深` 字面
 *
 * 转换规则:
 *   - `@角色:林深.img:xyz` → `林深`(长格式 + image_id)
 *   - `@角色:林深` → `林深`(长格式)
 *   - `@场景:茶水间` → `茶水间`
 *   - `@物件:旧怀表` → `旧怀表`
 *   - `@char:xxx` / `@scene:xxx` → 同上(英文 alias)
 *   - `@林深` (短格式, ctx 命中) → `林深`
 *   - `@xxx` (短格式, ctx 不命中) → 保留原文(避免误删真 @ 字符)
 *
 * @param text 原始含 chip token 的字符串
 * @param ctx 可选 ctx — 提供时支持短格式反查;不提供时只处理长格式
 */
export function humanizeMentionText(
  text: string,
  ctx?: MentionLookupContext,
): string {
  if (!text || typeof text !== "string") return text ?? "";

  let out = text;

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

  // 3) 短格式 `@林深` — 需要 ctx 反查;不提供 ctx 时跳过
  if (ctx) {
    const tokens = parseShortMentionTokens(out, ctx);
    for (const t of tokens) {
      // 跳过长格式(上面已替换);只处理短格式 `@<name>`
      if (t.raw === `@${t.name}`) {
        // 全局 replace,处理多次出现的同 name
        out = out.split(t.raw).join(t.name);
      }
    }
  }

  return out;
}
