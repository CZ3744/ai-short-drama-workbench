/**
 * shotText.ts — ShotTextNode 富文本节点工具集.
 *
 * 2026-05-21 Wave Y — 用户原话: "为什么用纯文本? 不应该在 json 里有单独的结构化数据
 * 指定这里有引用吗? 单靠@解析文本太不可靠了"
 *
 * 老架构 (action 是 plain string + @ token, parser 反扫):
 *   - 每个出入口都要 strip/humanize/parse 一遍, 6+ 处 helper 各自维护
 *   - 边界 case (IME / 重名 / substring / LLM 偷懒) 层出不穷
 *
 * 新架构 (主存储 = ShotTextNode[], plain text = derived):
 *   - 一份真理源, 写入时一次 parse, 读取无需再 parse
 *   - entity_id 是 ID 不是字符串 → 重名/同名素材自动消歧
 *   - image_id 是结构字段 → 单镜级 override 不需要拼 ".img:" 字符串
 *
 * 用法:
 *   - LLM 输出端 / migrate 老数据 → plainTextToNodes(text, ctx) parse 一次落盘
 *   - 后端出口 (TTS / 字幕 / display) → 直读 shot.action plain text (已 derived)
 *   - 后端 prompt 拼装 (shotPromptCompiler) → 读 nodes 直接走 entity_id resolve
 *   - 前端 chip 渲染 → nodes.map() 直接 React 节点
 *   - 落盘前 → nodesToPlainText(nodes) 反 derive 写回 action 字段
 */

import type { MentionLookupContext } from "./mentionParser";
import type { ShotTextNode } from "./types";

/**
 * nodes 反 derive 成含 @ 短格式字符串 (给前端 MentionTextarea contenteditable 编辑器用).
 * 编辑器内部已能 parse @ 短格式渲染 chip, 给它含 @ 的字符串即可自动 chip 化.
 *
 * 范例:
 *   [{type:"text",text:"冰箱门猛然被拉开,"},
 *    {type:"mention",entity_id:"char_001",kind:"character",display:"酸奶队长"},
 *    {type:"text",text:"被抓走"}]
 *   → "冰箱门猛然被拉开,@酸奶队长被抓走"
 *
 * mention 节点带 image_id 时输出长格式 "@酸奶队长.img:asset_xxx" 兼容老 ChipDropdown.
 */
export function nodesToShortText(nodes: ShotTextNode[] | undefined | null): string {
  if (!Array.isArray(nodes) || nodes.length === 0) return "";
  return nodes
    .map((n) => {
      if (n.type === "text") return n.text;
      if (n.type === "mention") {
        const base = `@${n.display}`;
        return n.image_id ? `${base}.img:${n.image_id}` : base;
      }
      return "";
    })
    .join("");
}

/**
 * nodes 反 derive 成 plain text (给老 caller / TTS / 字幕 / 字符串 API 用).
 * mention 节点用 display 字段 (用户看到的真名), 不带 @ 前缀.
 *
 * 范例:
 *   [{type:"text",text:"冰箱门猛然被拉开,"},
 *    {type:"mention",entity_id:"char_001",kind:"character",display:"酸奶队长"},
 *    {type:"text",text:"被抓走"}]
 *   → "冰箱门猛然被拉开,酸奶队长被抓走"
 */
export function nodesToPlainText(nodes: ShotTextNode[] | undefined | null): string {
  if (!Array.isArray(nodes) || nodes.length === 0) return "";
  return nodes
    .map((n) => {
      if (n.type === "text") return n.text;
      if (n.type === "mention") return n.display || "";
      return "";
    })
    .join("");
}

/**
 * plain text + entity ctx 转 nodes (LLM 输出端解析 / migrate 老数据 / 用户编辑落盘).
 *
 * 规则:
 *   - 长 name 优先 (避免 "林" 误匹配 "林深" 中的 "林")
 *   - 已带 @ prefix 的 token (老格式 "@林深" / "@角色:林深" / "@角色:林深.img:xxx") 解析为 mention 节点
 *   - 裸 name 出现 (例 "酸奶队长被抓走") → 也识别为 mention 节点 (LLM 偷懒不加 @ 时兜底)
 *   - 前面是汉字/英文/数字/下划线时跳过 (防 substring 误匹配)
 *   - 跨段文字保留为 text 节点
 *
 * @param text plain text (可含 @ token, 也可纯中文)
 * @param ctx entity name → id 反查 (characters/scenes/elements)
 * @returns ShotTextNode[]
 */
export function plainTextToNodes(
  text: string | undefined | null,
  ctx: MentionLookupContext,
): ShotTextNode[] {
  if (!text || typeof text !== "string" || text.length === 0) return [];

  // 收集所有可能的 entity, 按 name 长度倒序 (长名优先).
  // 2026-05-21 P0 修复 (audit Y deep): id 严格非空检查 (trim().length > 0), 防 caller 传
  // 空串 id 导致落盘 mention.entity_id="" 后端反查 silent fail.
  type EntityCandidate = { kind: "character" | "scene" | "element"; name: string; id: string };
  const candidates: EntityCandidate[] = [];
  const validId = (id: unknown): id is string => typeof id === "string" && id.trim().length > 0;
  const validName = (name: unknown): name is string => typeof name === "string" && name.trim().length > 0;
  for (const c of ctx.characters) if (validId(c.id) && validName(c.name)) candidates.push({ kind: "character", name: c.name.trim(), id: c.id });
  for (const s of ctx.scenes) if (validId(s.id) && validName(s.name)) candidates.push({ kind: "scene", name: s.name.trim(), id: s.id });
  for (const e of ctx.elements) if (validId(e.id) && validName(e.name)) candidates.push({ kind: "element", name: e.name.trim(), id: e.id });
  candidates.sort((a, b) => b.name.length - a.name.length);

  if (candidates.length === 0) return [{ type: "text", text }];

  // 扫描 text, 收集所有 mention 命中区间 [start, end, candidate, imageId?]
  type Hit = { start: number; end: number; cand: EntityCandidate; imageId?: string };
  const hits: Hit[] = [];

  // 阶段 1: 优先匹配长格式带 image_id: "@角色:林深.img:asset_xxx" 或 "@角色:林深"
  const longRe = /@(角色|场景|物件|元素)[::]([^@\s,，。!!??\n\r.]+?)(?:\.img:([^@\s,，。!!??\n\r]+))?(?=[\s,，。!!??\n\r.]|$)/g;
  let m: RegExpExecArray | null;
  while ((m = longRe.exec(text)) !== null) {
    const kindHint = m[1];
    const name = m[2];
    const imageId = m[3];
    const cand = candidates.find((c) =>
      c.name === name &&
      ((kindHint === "角色" && c.kind === "character") ||
        (kindHint === "场景" && c.kind === "scene") ||
        ((kindHint === "物件" || kindHint === "元素") && c.kind === "element")),
    );
    if (cand) {
      hits.push({ start: m.index, end: m.index + m[0].length, cand, imageId });
    }
  }

  // 阶段 2: 短格式 "@林深" (无 kind 前缀)
  const shortRe = /@([^@\s::,，。!!??\n\r.]{1,30})/g;
  while ((m = shortRe.exec(text)) !== null) {
    // 跳过已被长格式匹配的范围
    if (hits.some((h) => h.start <= m!.index && h.end > m!.index)) continue;
    const name = m[1];
    const cand = candidates.find((c) => c.name === name);
    if (cand) {
      hits.push({ start: m.index, end: m.index + m[0].length, cand });
    }
  }

  // 阶段 3: 裸 name (无 @ 前缀, LLM 偷懒兜底).
  // 中文叙述里 entity name 经常前后都是汉字 (例 "抓走酸奶队长" 中 "酸奶队长" 前是 "走"),
  // 强制汉字 lookbehind 会漏识别. 取舍:
  //   - 长 name (>=2 字符): 全局匹配 (不要 lookbehind, 真 substring 风险低)
  //   - 单字 name (== 1 字符): 启用 lookbehind 防 substring (例 "林" 不应吃 "林深")
  // candidates 已按长度倒序, 长 name 先匹配占住位置, 单字 name 不会吃到长 name 已占的范围.
  for (const cand of candidates) {
    const escaped = cand.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 单字 name 加 lookbehind 防 substring, 多字直接全局匹配 (除 @ 重复)
    const re = cand.name.length === 1
      ? new RegExp(`(?<![@\\u4e00-\\u9fff\\w])${escaped}(?![\\u4e00-\\u9fff\\w])`, "g")
      // 2026-05-21 P2 修复 (audit Y): 多字 name 也加英文词边界 (?<!\\w)/(?!\\w),
      // 防英文 entity name 误匹配 substring (例 entity "Lin" 不应匹配 "Linden").
      : new RegExp(`(?<![@\\w])${escaped}(?!\\w)`, "g");
    let bareMatch: RegExpExecArray | null;
    while ((bareMatch = re.exec(text)) !== null) {
      const start = bareMatch.index;
      const end = start + cand.name.length;
      // 跳过已被阶段 1/2 / 长 name 匹配过的范围
      if (hits.some((h) => !(h.end <= start || h.start >= end))) continue;
      hits.push({ start, end, cand });
    }
  }

  hits.sort((a, b) => a.start - b.start);

  // 去重叠 — 若两 hit 重叠, 保留 start 早的 (长格式 / 早出现的)
  const dedup: Hit[] = [];
  for (const h of hits) {
    if (dedup.length > 0 && dedup[dedup.length - 1].end > h.start) continue;
    dedup.push(h);
  }

  // 把 hits + text 之间的部分拼成 nodes
  const nodes: ShotTextNode[] = [];
  let cursor = 0;
  for (const h of dedup) {
    if (h.start > cursor) {
      nodes.push({ type: "text", text: text.slice(cursor, h.start) });
    }
    const node: ShotTextNode = {
      type: "mention",
      entity_id: h.cand.id,
      kind: h.cand.kind,
      display: h.cand.name,
    };
    if (h.imageId) node.image_id = h.imageId;
    nodes.push(node);
    cursor = h.end;
  }
  if (cursor < text.length) {
    nodes.push({ type: "text", text: text.slice(cursor) });
  }

  // 折叠相邻 text 节点 (理论上不会有,但稳妥)
  const folded: ShotTextNode[] = [];
  for (const n of nodes) {
    const last = folded[folded.length - 1];
    if (n.type === "text" && last && last.type === "text") {
      last.text += n.text;
    } else {
      folded.push(n);
    }
  }
  return folded;
}

/**
 * 从 nodes 提取所有 mention 节点的 entity_id / image_id 引用.
 * 给后端 prompt 拼装 / orchestrator 反查 reference_overrides 用.
 */
export function extractMentionRefs(nodes: ShotTextNode[] | undefined | null): Array<{
  entity_id: string;
  kind: "character" | "scene" | "element";
  display: string;
  image_id?: string;
}> {
  if (!Array.isArray(nodes)) return [];
  const refs: Array<{ entity_id: string; kind: "character" | "scene" | "element"; display: string; image_id?: string }> = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    if (n.type !== "mention") continue;
    const dedupeKey = `${n.kind}:${n.entity_id}:${n.image_id ?? ""}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    refs.push({
      entity_id: n.entity_id,
      kind: n.kind,
      display: n.display,
      image_id: n.image_id,
    });
  }
  return refs;
}

/**
 * 兼容路径: 若 shot.action_nodes 不存在 (老数据),
 * 用 plainTextToNodes 从 shot.action 反 derive 一次, 给读取方临时用.
 * 不写回磁盘 (写回是 migrate 脚本的事).
 */
export function getNodesOrDerive(
  nodes: ShotTextNode[] | undefined | null,
  plainText: string | undefined | null,
  ctx: MentionLookupContext,
): ShotTextNode[] {
  if (Array.isArray(nodes) && nodes.length > 0) return nodes;
  if (plainText && plainText.trim()) return plainTextToNodes(plainText, ctx);
  return [];
}
