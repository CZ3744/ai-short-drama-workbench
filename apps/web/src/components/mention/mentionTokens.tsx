import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiPost } from "../../lib/api";
import { cn } from "../../lib/cn";
import { type Character } from "../../hooks/useCharacters";
import { type Scene } from "../../hooks/useScenes";
import { listElements, ELEMENT_KIND_LABEL, type ElementData } from "../../lib/elementApi";
import { imageThumbUrl } from "../../lib/imageThumb";
import { type IconName } from "../shared/Icon";

export type MentionRefType = "character" | "scene" | "style" | "voice" | "vault" | "element";

export interface MentionOption {
  kind: MentionRefType;
  groupLabel: string;
  label: string;
  token: string;
  description?: string;
  source?: "project" | "public";
  resourceId?: string;
  /**
   * 2026-05-19 #6: 元素是否已生成图(thumbnail 是否存在).
   *   - hasImage=false: 渲染"暂无图,先生成"灰色提示 + "去生成"按钮
   *   - hasImage=true: 渲染缩略图
   *   - character/scene/element 都用,style/voice/vault 不关心
   */
  hasImage?: boolean;
  /** 元素 / 角色 / 场景的代表图 URL(若已生成) */
  thumbnail?: string;
  /**
   * 2026-05-20: element 子类型 (prop/wardrobe/reference/misc),用于素材库分类 tab filter.
   * - character/scene 的 kind 字段直接对应 tab,不需要此字段
   * - element kind 在 UI 上分裂成 4 个子 tab(道具/服装/参考图/杂项)
   * - style/voice/vault 不在素材库 tab 内,只在"全部" tab 出现
   */
  elementKind?: "prop" | "wardrobe" | "reference" | "misc";
}

export interface ResolvedMentionReference {
  raw: string;
  ref_type: MentionRefType;
  match_method: "exact" | "fuzzy" | "cross_project";
  resolved: boolean;
  resource_id?: string;
  resource_name?: string;
  resource_data?: Record<string, unknown>;
  error?: string;
}

export interface ResolveReferencesResult {
  ref_count: number;
  resolved_count: number;
  unresolved_count: number;
  references: ResolvedMentionReference[];
  unresolved_hints: Array<{ raw: string; error?: string }>;
}

interface VaultEntry {
  vault_id: string;
  kind: "image" | "video";
  status?: string;
  tags: string[];
  context?: {
    kind?: string;
    series_slug?: string;
    character_id?: string;
    scene_id?: string;
    shot_id?: string;
    user_note?: string;
  };
  created_at?: string;
}

interface MentionSourceState {
  loading: boolean;
  options: MentionOption[];
}

export const GROUP_PRIORITY: MentionRefType[] = ["character", "scene", "element", "style", "voice", "vault"];

export const GROUP_META: Record<MentionRefType, { label: string; icon: IconName }> = {
  character: { label: "角色", icon: "user" },
  scene: { label: "场景", icon: "image" },
  element: { label: "素材", icon: "layers" },
  style: { label: "风格", icon: "sparkles" },
  voice: { label: "音色", icon: "volume" },
  vault: { label: "公共素材库", icon: "archive" },
};

export function normalize(text: string): string {
  return text.trim().toLowerCase();
}

export function compactJoin(values: Array<string | undefined | null>, fallback = "未填写"): string {
  const parts = values.map((v) => (v ?? "").trim()).filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : fallback;
}

function uniqueOptions(items: MentionOption[]): MentionOption[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}:${item.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

// ─── 最近使用 (MRU) — 2026-07-22 X9-2 (A4-10 差距#1) ────────────────────
// per-series localStorage MRU: "选中即记", 下拉时同 kind 内 MRU 前置 + "全部"tab 顶部"最近"分组.
//   key   = mention-mru:<seriesSlug>
//   value = JSON string[] (最近在前, 上限 MRU_LIMIT)
// localStorage 不可用 (隐私模式 / 配额满) 时全部静默降级 —— MRU 失效但绝不抛错.

const MRU_LIMIT = 40;

/** MRU / 缩略图匹配用的稳定标识: 优先 resourceId (character/scene/element 都有), 兜底 token. */
export function mentionOptionKey(o: Pick<MentionOption, "kind" | "resourceId" | "token">): string {
  return `${o.kind}:${o.resourceId ?? o.token}`;
}

function mruStorageKey(seriesKey: string): string {
  return `mention-mru:${seriesKey}`;
}

/** 读该 series 的 MRU id 列表 (最近在前). seriesKey 缺失 / localStorage 不可用 → 返回空. */
export function readMentionMru(seriesKey?: string): string[] {
  if (!seriesKey || typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(mruStorageKey(seriesKey));
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** 记一次"选中" —— 把该项挪到 MRU 最前 (dedupe), 截断到上限. 幂等: 同项重复记结果一致. */
export function recordMentionMru(
  seriesKey: string | undefined,
  option: Pick<MentionOption, "kind" | "resourceId" | "token">,
): void {
  if (!seriesKey || typeof window === "undefined") return;
  try {
    const id = mentionOptionKey(option);
    const prev = readMentionMru(seriesKey).filter((x) => x !== id);
    const next = [id, ...prev].slice(0, MRU_LIMIT);
    window.localStorage.setItem(mruStorageKey(seriesKey), JSON.stringify(next));
  } catch {
    /* localStorage 不可用 → 静默降级, MRU 失效但不崩 */
  }
}

export function labelToToken(kind: MentionRefType, label: string): string {
  // 2026-05-20 短格式优先:character / scene / element 用 `@<名字>`(用户偏好).
  // style / voice / vault 仍走长格式 `@<前缀>.<名字>`,因为没建在 series entity 表里,
  // 短格式无法反查 kind。
  if (kind === "character" || kind === "scene" || kind === "element") {
    // 短 token name 内禁止字符 — 跟 mentionParser.cleanShortName 保持一致
    const safeName = label.replace(/[@\s\n\r.,:;!?,。!?、;]/g, "_");
    return `@${safeName}`;
  }
  const prefix = GROUP_META[kind].label;
  return `@${prefix}.${label}`;
}

export function buildMentionOptionsFromData(input: {
  slug?: string;
  characters?: Character[];
  scenes?: Scene[];
  preferences?: Array<string | undefined | null>;
  vaultEntries?: VaultEntry[];
  elements?: ElementData[];
}): MentionOption[] {
  const options: MentionOption[] = [];
  const slug = input.slug;

  // 2026-05-20: @ 引用画面里出现的"实体" — 角色/场景/道具/服装/参考图/杂项 6 类项目素材库。
  // 不再生成 voice(音色是元数据,不是画面实体)/ style(风格偏好,不是画面里的"东西")/
  // vault(跨项目公共素材,跟本剧一致性无关)— 这些喂给生图模型也没意义。
  // 2026-05-20 修缩略图 bug: character/scene 路径之前漏 thumbnail/hasImage, 弹窗永远 icon fallback
  for (const character of input.characters ?? []) {
    // Wave Z-10: Character = ElementData. 主图走 primary_image_id, 图列表走 images[].image_id
    const primaryRefId = character.primary_image_id ?? character.images?.[0]?.image_id;
    const thumbnail = slug && primaryRefId
      ? imageThumbUrl(slug, { asset_id: primaryRefId })
      : undefined;
    const role = character.tags?.find((t) => t.axis === "role")?.value;
    const personalityRaw = character.attrs?.personality;
    const personality = typeof personalityRaw === "string" ? personalityRaw : undefined;
    options.push({
      kind: "character",
      groupLabel: GROUP_META.character.label,
      label: character.name,
      token: labelToToken("character", character.name),
      description: compactJoin([role, personality]),
      source: "project",
      resourceId: character.id,
      hasImage: !!primaryRefId,
      thumbnail,
    });
  }

  for (const scene of input.scenes ?? []) {
    // Wave Z-10: Scene = ElementData. 主图走 primary_image_id, 图列表走 images[].image_id
    const tag = (axis: string) => scene.tags?.find((t) => t.axis === axis)?.value;
    const primaryRefId: string | undefined = scene.primary_image_id
      ?? scene.images?.[0]?.image_id;
    const thumbnail = slug && primaryRefId
      ? imageThumbUrl(slug, { asset_id: primaryRefId })
      : undefined;
    options.push({
      kind: "scene",
      groupLabel: GROUP_META.scene.label,
      label: scene.name,
      token: labelToToken("scene", scene.name),
      description: compactJoin([tag("location"), tag("time"), tag("mood"), tag("visual")]),
      source: "project",
      resourceId: scene.id,
      hasImage: !!primaryRefId,
      thumbnail,
    });
  }

  for (const el of input.elements ?? []) {
    // character/scene 已通过原有分组展示，prop/wardrobe/reference/misc 统一归 element 分组
    if (el.kind === "character" || el.kind === "scene") continue;
    const kindLabel = ELEMENT_KIND_LABEL[el.kind] ?? el.kind;
    // 2026-05-19 #6: 找元素的代表图(优先 primary_image_id, 否则第一张)
    // 用户原话: "导入剧本的时候还没生图, 确实不知道导入什么素材,
    //          那就改成 @ 后面接的不一定是具体图片素材, 可以直接接元素",
    // 没有图片的时候 "检查和提示用户自己去生成还是一键补全".
    // 所以 element option 必须暴露 hasImage / thumbnail, 让弹窗能区分"已生成"和"待生成".
    const primaryImage = el.images.find((img) => img.image_id === el.primary_image_id) ?? el.images[0];
    options.push({
      kind: "element",
      elementKind: el.kind as "prop" | "wardrobe" | "reference" | "misc",
      groupLabel: GROUP_META.element.label,
      label: el.name,
      token: labelToToken("element", el.name),
      description: `${kindLabel}${el.description ? ` · ${el.description}` : ""}`,
      source: "project",
      resourceId: el.id,
      hasImage: el.images.length > 0 && !!primaryImage?.url,
      thumbnail: primaryImage?.url,
    });
  }

  // 2026-05-20: 不再生成 vault(公共素材库)候选 — 跨项目素材跟本剧角色一致性无关,
  // 喂给生图模型也没意义。input.vaultEntries 字段保留(向后兼容),但不消费。
  void input.vaultEntries;

  return uniqueOptions(options);
}

/**
 * 把文本拆分成 text / mention 段.
 *
 * 2026-05-20 短格式 @ token 支持:
 *   - 旧长格式 `@角色.林深` / `@char:林深` 等仍兼容
 *   - 新短格式 `@林深` — 需要 ctx (characters/scenes/elements name 列表) 反查 kind
 *   - resolvedId / resolvedKind / displayLabel 提供给 chip render & click handler
 *
 * Parts:
 *   - type=text: 普通文本
 *   - type=mention: chip 段, 含 raw (原 token 字符串) / kind / displayLabel (短显示) /
 *     resolvedId (反查到的 element.id, 用于 ChipDropdown 加载) / from/to (在原文中的位置)
 */

export interface MentionContext {
  characters: ReadonlyArray<{ id: string; name: string }>;
  scenes: ReadonlyArray<{ id: string; name: string }>;
  elements: ReadonlyArray<{ id: string; name: string; kind?: string }>;
}

export interface MentionTextPart {
  type: "text" | "mention";
  value: string;       // chip raw token, 或 text 段
  kind?: MentionRefType;
  /** chip 在显示时的简短文本 (@林深 而非 @角色.林深) */
  displayLabel?: string;
  /** 反查到的 element/character/scene id (用于 ChipDropdown 加载) */
  resolvedId?: string;
  /** chip 在原文中的字符范围 (用于 Backspace 选中 / 点击 hit-test) */
  from?: number;
  to?: number;
}

const EMPTY_CTX: MentionContext = { characters: [], scenes: [], elements: [] };

export function splitMentionTokens(text: string, ctx: MentionContext = EMPTY_CTX): MentionTextPart[] {
  const parts: MentionTextPart[] = [];

  // 1) 长格式 token range 扫描
  const longRe = /@(?:角色|场景|素材|风格|音色|素材库)\.[^\s@,，。！？、]+|@char:[^\s@,，。！？、]+|@scene:[^\s@,，。！？、]+/g;
  type Range = { from: number; to: number; raw: string; kind: MentionRefType; resolvedId?: string; displayLabel: string };
  const ranges: Range[] = [];
  let mLong: RegExpExecArray | null;
  while ((mLong = longRe.exec(text)) !== null) {
    const raw = mLong[0];
    const kind: MentionRefType = raw.startsWith("@角色.") || raw.startsWith("@char:")
      ? "character"
      : raw.startsWith("@场景.") || raw.startsWith("@scene:")
        ? "scene"
        : raw.startsWith("@素材.")
          ? "element"
          : raw.startsWith("@风格.")
            ? "style"
            : raw.startsWith("@音色.")
              ? "voice"
              : "vault";
    // 提取 . 或 : 后的 name 作 displayLabel
    const sep = raw.indexOf(".") >= 0 ? "." : ":";
    const sepIdx = raw.indexOf(sep);
    const name = sepIdx >= 0 ? raw.slice(sepIdx + 1) : raw.slice(1);
    const displayLabel = `@${name}`;
    let resolvedId: string | undefined;
    if (kind === "character") {
      resolvedId = ctx.characters.find(c => c.name === name)?.id;
    } else if (kind === "scene") {
      resolvedId = ctx.scenes.find(s => s.name === name)?.id;
    } else if (kind === "element") {
      resolvedId = ctx.elements.find(el => el.name === name)?.id;
    }
    ranges.push({ from: mLong.index, to: mLong.index + raw.length, raw, kind, resolvedId, displayLabel });
  }

  // 2) 短格式 token range 扫描 — 用 ctx name 反查 (避开长格式 range)
  if (ctx.characters.length > 0 || ctx.scenes.length > 0 || ctx.elements.length > 0) {
    // name → {kind, id} 优先级: character > scene > element
    const nameToInfo = new Map<string, { kind: MentionRefType; id: string }>();
    for (const el of ctx.elements) {
      if (el?.name) nameToInfo.set(el.name, { kind: "element", id: el.id });
    }
    for (const sc of ctx.scenes) {
      if (sc?.name) nameToInfo.set(sc.name, { kind: "scene", id: sc.id });
    }
    for (const ch of ctx.characters) {
      if (ch?.name) nameToInfo.set(ch.name, { kind: "character", id: ch.id });
    }
    if (nameToInfo.size > 0) {
      const namesByLengthDesc = Array.from(nameToInfo.keys()).sort((a, b) => b.length - a.length);
      let i = 0;
      while (i < text.length) {
        if (text[i] !== "@") { i++; continue; }
        // 已被长格式 range 覆盖 → skip
        if (ranges.some(r => i >= r.from && i < r.to)) { i++; continue; }
        // 在 i+1 尝试匹配 ctx name
        let matched: { name: string; kind: MentionRefType; id: string } | null = null;
        for (const candidate of namesByLengthDesc) {
          if (text.startsWith(candidate, i + 1)) {
            const info = nameToInfo.get(candidate)!;
            matched = { name: candidate, kind: info.kind, id: info.id };
            break;
          }
        }
        if (matched) {
          const raw = `@${matched.name}`;
          ranges.push({
            from: i,
            to: i + raw.length,
            raw,
            kind: matched.kind,
            resolvedId: matched.id,
            displayLabel: raw,
          });
          i += raw.length;
        } else {
          i++;
        }
      }
    }
  }

  // 3) 按 range 顺序切片
  ranges.sort((a, b) => a.from - b.from);
  let last = 0;
  for (const r of ranges) {
    if (r.from > last) {
      parts.push({ type: "text", value: text.slice(last, r.from) });
    }
    parts.push({
      type: "mention",
      value: r.raw,
      kind: r.kind,
      displayLabel: r.displayLabel,
      resolvedId: r.resolvedId,
      from: r.from,
      to: r.to,
    });
    last = r.to;
  }
  if (last < text.length) {
    parts.push({ type: "text", value: text.slice(last) });
  }
  return parts;
}

export function renderMentionText(
  text: string,
  options: {
    ctx?: MentionContext;
    selectionRange?: { from: number; to: number } | null;
    onChipClick?: (part: MentionTextPart, rect: DOMRect) => void;
  } = {},
) {
  const parts = splitMentionTokens(text, options.ctx ?? EMPTY_CTX);
  const sel = options.selectionRange;
  return parts.map((part, index) => {
    if (part.type === "mention") {
      const kind = part.kind ?? "character";
      // 检测当前 selection 是否覆盖本 chip (Backspace 第一次选中显示效果)
      const selected = !!(sel && part.from !== undefined && part.to !== undefined &&
        sel.from <= part.from && sel.to >= part.to);
      const handleClick = options.onChipClick
        ? (e: React.MouseEvent<HTMLSpanElement>) => {
            e.preventDefault();
            e.stopPropagation();
            const rect = (e.currentTarget as HTMLSpanElement).getBoundingClientRect();
            options.onChipClick!(part, rect);
          }
        : undefined;
      return (
        <span
          key={`chip-${index}-${part.from ?? 0}`}
          onMouseDown={handleClick}
          role={handleClick ? "button" : undefined}
          tabIndex={handleClick ? 0 : undefined}
          title={part.value}
          className={cn(
            // 2026-05-20 排版 + 减视觉错位: chip 跟 textarea raw text 宽度尽量一致避免 caret 错位
            // (textarea char-by-char 不能精确对齐 chip 视觉块, 但 px-1 mx-0 让 chip 视觉占用接近原始字符)
            "inline-flex items-center rounded-md border px-1 py-0",
            "text-[var(--fs-md)] font-medium",
            "align-baseline",
            handleClick && "pointer-events-auto cursor-pointer hover:brightness-95",
            // 默认颜色:蓝色高亮 (用户原话: "所有'@+名称'的部分用蓝色高亮一眼认出")
            !selected && "border-blue-200 bg-blue-50 text-blue-700",
            // 选中态 (Backspace 第一次按下): 深蓝色填充, 提示"再按一次会删除"
            selected && "border-blue-500 bg-blue-500 text-white",
            // kind 区分 (默认情况下 — 选中态盖过)
            !selected && kind === "scene" && "border-emerald-200 bg-emerald-50 text-emerald-700",
            !selected && kind === "element" && "border-purple-200 bg-purple-50 text-purple-700",
            !selected && kind === "style" && "border-amber-200 bg-amber-50 text-amber-700",
            !selected && kind === "voice" && "border-orange-200 bg-orange-50 text-orange-700",
            !selected && kind === "vault" && "border-slate-200 bg-slate-50 text-slate-700",
          )}
        >
          {part.displayLabel ?? part.value}
        </span>
      );
    }
    return (
      <span key={`text-${index}`} className="whitespace-pre-wrap">
        {part.value}
      </span>
    );
  });
}

export function replaceMentionRange(text: string, from: number, to: number, insert: string): string {
  return `${text.slice(0, from)}${insert}${text.slice(to)}`;
}

export function findMentionTrigger(text: string, caret: number): { query: string; range: { from: number; to: number } } | null {
  // 2026-05-20 用户原话:"只要输入@,就立刻有一个下拉框供我选择素材,
  //                       而不是匹配后面如果恰好是素材就直接合并"
  //
  // 极简规则:caret 前一字符是 `@` → trigger。任意位置(行首/中文中间/数字后)都生效。
  // 不限制 @ 前导(中文 textarea 里 @ 前常是汉字)。
  // 不读 @ 后面字符做 query(避免"匹配后面字符合并"误解)。
  // 弹窗内有独立搜索 input 让用户用关键词 filter。
  //
  // - 输 `@$caret`     → trigger(query="" 列全部候选)
  // - 输 `中文@$caret` → trigger
  // - 输 `@林$caret`   → 不 trigger(@ 不在 caret 紧邻)
  // - 输 `@老周$caret` → 不 trigger
  if (caret < 1) return null;
  if (text[caret - 1] !== "@") return null;
  return { query: "", range: { from: caret - 1, to: caret } };
}

// 2026-05-27 — resolveProjectReferences 删除. 后端 /api/projects/:slug/resolve-references
// 端点走 v1 project 表, 跟 v2 series store 不兼容, console spam 404. 调用方 (MentionPreviewBar)
// 也一起删了, 该功能 nice-to-have, MentionTextarea 自己的 chip 视觉反馈已足够.

/**
 * Hook 返回值扩展 — 加 raw data (characters/scenes/elements 原数组) 给 MentionTextarea
 * 用于 chip click → ChipDropdown 加载 & splitMentionTokens ctx 反查.
 *
 * 2026-05-20 短格式 chip 支持
 */
export interface MentionSourceStateExt extends MentionSourceState {
  characters: Character[];
  scenes: Scene[];
  elements: ElementData[];
}

export function useMentionSources(projectSlug?: string): MentionSourceStateExt {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [elements, setElements] = useState<ElementData[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!projectSlug) { setLoading(false); return; }
      setLoading(true);
      try {
        // Wave Z-10: 收口到 element API. 单次 listElements(无 kind filter) 后端已聚合
        // character + scene + repo element 三源,去重 3→1 HTTP 调用.
        const { elements: all } = await listElements(projectSlug).catch(() => ({ elements: [] as ElementData[] }));
        if (cancelled) return;
        type El = ElementData;
        setCharacters(all.filter((e: El) => e.kind === "character"));
        setScenes(all.filter((e: El) => e.kind === "scene"));
        setElements(all.filter((e: El) => e.kind !== "character" && e.kind !== "scene"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [projectSlug]);

  // 2026-05-20: 传 slug 让 buildMentionOptionsFromData 能拼 character/scene 缩略图 URL
  const options = useMemo(() => buildMentionOptionsFromData({
    slug: projectSlug,
    characters,
    scenes,
    elements,
  }), [projectSlug, characters, scenes, elements]);

  return { loading, options, characters, scenes, elements };
}
