import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { getElement, type ElementData } from "../../lib/elementApi";
import { imageThumbUrl } from "../../lib/imageThumb";
import { toast } from "sonner";
import { ChipDropdown } from "./ChipDropdown";
import { MentionPopover } from "./MentionPopover";
// 2026-05-27 — MentionPreviewBar 删除 (调 /api/projects/:slug/resolve-references
// 端点走 v1 project 表, 跟 v2 series store 不兼容, console spam 404; 且功能 nice-to-have,
// MentionTextarea 自己的 chip 视觉反馈已经够)
import {
  useMentionSources,
  splitMentionTokens,
  normalize,
  recordMentionMru,
  type MentionOption,
  type MentionContext,
  type MentionRefType,
} from "./mentionTokens";

/**
 * MentionTextarea (2026-05-20 重写: contenteditable + 真 chip DOM 节点架构).
 *
 * 用户原话(2026-05-20 当面批"糊弄"):
 *   "你自己看我删除的步骤,根本没修好,为什么不能直接插入段落?
 *    这种排版很多地方都有,你不可能不会做,你就这么糊弄我,排版根本没对齐"
 *
 * 旧实现(textarea + mirror layer)架构本质问题:
 *   - textarea 是 char-by-char 文本, mirror 用绝对定位渲染 chip 化文本盖在上面
 *   - chip 视觉块跟 textarea raw char 永远对不齐 → caret 错位 → 退格删不到 chip
 *   - 不是改 padding 能修的
 *
 * 新架构(Slack/Discord/Notion/Twitter 都用这个):
 *   - <div contenteditable> 是编辑器本身
 *   - chip 是真 inline DOM 节点 <span contenteditable="false">, 跟文字自然对齐
 *   - 文字直接是 textNode
 *   - 退格/选区/光标/复制粘贴全浏览器原生行为
 *   - @ trigger 监听 input event 检测 caret 前一字符 = `@`
 *   - 插入 chip 通过 Range.insertNode + 移 caret
 *
 * 核心 helper:
 *   - serializeDOM: editor DOM → value string(textNode + chip.dataset.token + 换行)
 *   - renderValueToDOM: value string → editor DOM (用 splitMentionTokens 拆解)
 *   - findMentionTriggerInDOM: 检测 caret 前是不是 `@` → 计算 anchor rect 弹候选
 *   - insertChipAtCaret: 用 Range.insertNode 插 chip + 空格
 *
 * 删除的旧代码:
 *   - mirror layer renderMentionText(已 inline 真 chip 节点)
 *   - ghost mirror caretAnchorRef(Range.getBoundingClientRect 直接拿)
 *   - pendingDeleteRange 两阶段(浏览器原生 contentEditable=false 节点行为)
 *   - findAdjacentChipRange(浏览器原生)
 *   - syncHeight(div 自然撑高,不再需要)
 *
 * IME 中文输入:
 *   - 监听 compositionstart / compositionend, 期间不触发 trigger 检测
 *
 * 粘贴:
 *   - onPaste 拦截, clipboardData.getData("text") plain text 插入
 *
 * placeholder:
 *   - contenteditable 没原生 placeholder, 用 CSS :empty::before
 */
export function MentionTextarea({
  projectSlug,
  value,
  onChange,
  placeholder,
  className,
  rows = 6,
  disabled,
  autoFocus,
  onBlur,
  onFocus,
  onKeyDown,
  onTriggerBatchImage,
  onChipImagePick,
  chipImageOverrides,
  onMentionPick,
  editorClassName,
  editorStyle: editorStyleOverride,
}: {
  projectSlug?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** 估算 minHeight: rows × ~24px(line-height) */
  rows?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  /** 接口保留 (caller 传 HTMLTextAreaElement event handler), 但内部用 HTMLDivElement; type 用宽松 any 兼容 */
  onBlur?: (e: React.FocusEvent<HTMLDivElement>) => void;
  onFocus?: (e: React.FocusEvent<HTMLDivElement>) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  /** 2026-05-19 #6: 可选 — caller 接 BatchElementImageDialog 一键补全 */
  onTriggerBatchImage?: () => void;
  /** 用户从 @ 候选里选中实体后通知 caller,用于同步 shot.character_ids / scene_id / element_ids */
  onMentionPick?: (option: MentionOption) => void;
  /** 编辑器本体的额外 class/style,方便复用到 ChatGPT 风格输入框与剧本文本区 */
  editorClassName?: string;
  editorStyle?: React.CSSProperties;
  /**
   * 2026-05-20: chip click → ChipDropdown 选图后回调.
   * caller 持有 shot 数据, 应在此处 patchShot {reference_overrides} + SWR mutate.
   * - imageId=null: 用默认主图 (从 reference_overrides 移除该 element_id 项)
   * - imageId="img_xxx": 用该图 (添加/更新 reference_overrides 项)
   * 不传则 chip 仅 hover 不弹下拉 (向后兼容旧 caller).
   */
  onChipImagePick?: (elementId: string, imageId: string | null) => void | Promise<void>;
  /**
   * 2026-05-20: 当前 shot 的 reference_overrides (caller 持有),
   * 用于 ChipDropdown 显示哪张图被选中.
   */
  chipImageOverrides?: ReadonlyArray<{ element_id: string; image_id: string }>;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  // chip click → ChipDropdown 选图
  const [chipDropdown, setChipDropdown] = useState<{
    elementId: string;
    elementData: ElementData | null;
    anchorRect: DOMRect | null;
  } | null>(null);
  // IME 中文输入期间不触发 trigger 检测 — 防止"@" 在 composition 中被误判
  const isComposingRef = useRef(false);
  // 2026-05-20 Wave T 第 6 次根因重构 — 完全抛弃 Range/Selection 依赖,改字符串层面替换:
  //
  // 前 5 次修复全都在 Range/Selection 层面打补丁,踩坑无数:
  //   - selection race(input event 触发瞬间 selection 还没 commit)
  //   - editor blur(候选 popover focus 抢走焦点 → selection 跟 editor 脱钩)
  //   - useEffect ctxChanged 重建 DOM 让 savedRange.startContainer 变 detached 节点
  //   - deleteContents / insertNode 浏览器实现差异
  //
  // 第 6 次根本修法:在 handleInput 检测到 trigger 时,保存 (valueAtSave, atIndex)
  //   即"快照当前 value + @ 在 value 字符串里的位置"。
  //   insertChipAtCaret 做字符串拼接 → onChange(新 value) → useEffect 自动重建 DOM。
  //   完全不依赖 DOM 节点 / selection / focus 状态,100% 可靠。
  const savedTriggerInfoRef = useRef<{ valueAtSave: string; atIndex: number } | null>(null);

  // 2026-05-20: 短格式 chip 反查 + click 用 raw entity 数据
  const { options, characters, scenes, elements } = useMentionSources(projectSlug);

  const mentionCtx = useMemo<MentionContext>(() => ({
    characters: characters.map(c => ({ id: c.id, name: c.name })),
    scenes: scenes.map(s => ({ id: s.id, name: s.name })),
    elements: elements.map(el => ({ id: el.id, name: el.name, kind: el.kind })),
  }), [characters, scenes, elements]);

  // 2026-07-22 X9-3 (A4-10 差距#2): chip 内嵌缩略图数据源.
  // options 已按 resourceId 算好各实体"主图"缩略图 (buildMentionOptionsFromData).
  const optionByResourceId = useMemo(() => {
    const m = new Map<string, MentionOption>();
    for (const o of options) if (o.resourceId) m.set(o.resourceId, o);
    return m;
  }, [options]);

  // 解析某 chip 该显示哪张缩略图: override 优先 (与 ChipDropdown 选中项判定一致), 否则实体主图;
  // 无图实体返回 undefined → chip 保持纯色 (不插 img).
  const thumbForChip = useCallback((resolvedId?: string): string | undefined => {
    if (!resolvedId) return undefined;
    if (projectSlug && chipImageOverrides) {
      const ov = chipImageOverrides.find((o) => o.element_id === resolvedId);
      if (ov) return imageThumbUrl(projectSlug, { asset_id: ov.image_id }, { size: 64 });
    }
    return optionByResourceId.get(resolvedId)?.thumbnail;
  }, [projectSlug, chipImageOverrides, optionByResourceId]);

  // ── DOM helpers ──────────────────────────────────────────────────────

  /**
   * serializeDOM(editor): editor 内全部 child → value string.
   * - textNode → 取 textContent
   * - <span class="mention-chip"> → 取 dataset.token (即 `@名字`)
   * - <br> → 换行 "\n"
   * - block element (<div>/<p>) → 递归 + 末尾 "\n"
   */
  const serializeDOM = useCallback((editor: HTMLElement): string => {
    let out = "";
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.textContent ?? "";
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node as HTMLElement;
      if (el.tagName === "BR") {
        out += "\n";
        return;
      }
      if (el.classList.contains("mention-chip")) {
        out += el.dataset.token ?? el.textContent ?? "";
        return;
      }
      // 递归子节点 — block 元素(div/p)末尾补换行
      const isBlock = el.tagName === "DIV" || el.tagName === "P";
      const before = out;
      for (const child of Array.from(el.childNodes)) walk(child);
      if (isBlock && out !== before && !out.endsWith("\n")) {
        // 但若已是 editor 直系 div 包裹了所有内容, 不强加换行 — 用 sibling 判断
        // 简化策略: 仅当下一兄弟也是 block 时加换行
        if (el.nextSibling) out += "\n";
      }
    };
    for (const child of Array.from(editor.childNodes)) walk(child);
    return out;
  }, []);

  /**
   * renderValueToDOM(editor, value, ctx): 用 splitMentionTokens 拆解, 重建 editor 内容.
   * - text part → textNode
   * - mention part → chip span (contenteditable=false)
   * - "\n" → <br>
   */
  const renderValueToDOM = useCallback((
    editor: HTMLElement,
    val: string,
    ctx: MentionContext,
    resolveThumb?: (resolvedId?: string) => string | undefined,
  ) => {
    // 清空
    while (editor.firstChild) editor.removeChild(editor.firstChild);
    if (!val) return;
    const parts = splitMentionTokens(val, ctx);
    for (const part of parts) {
      if (part.type === "mention") {
        const chip = createChipElement(
          part.value,
          part.kind ?? "character",
          part.displayLabel ?? part.value,
          part.resolvedId,
          resolveThumb?.(part.resolvedId),
        );
        editor.appendChild(chip);
      } else {
        // 拆换行 — textNode 不支持 \n 自动换行,需 <br>
        const segments = part.value.split("\n");
        for (let i = 0; i < segments.length; i++) {
          if (segments[i]) {
            editor.appendChild(document.createTextNode(segments[i]));
          }
          if (i < segments.length - 1) {
            editor.appendChild(document.createElement("br"));
          }
        }
      }
    }
  }, []);

  /**
   * 创建 chip DOM 节点 — class 由 kind 决定颜色, contenteditable=false 让浏览器
   * 把它当不可分割单元(选区/退格自然落到整个 chip 上).
   */
  const createChipElement = (
    token: string,
    kind: MentionRefType,
    displayLabel: string,
    resolvedId?: string,
    thumbnailUrl?: string,
  ): HTMLSpanElement => {
    const chip = document.createElement("span");
    chip.className = cn(
      "mention-chip",
      "inline-flex items-center rounded-md border px-1 py-0",
      "text-[var(--fs-md)] font-medium align-baseline",
      "cursor-pointer select-none",
      // kind 颜色 — 跟旧 renderMentionText 完全一致
      kind === "character" && "border-blue-200 bg-blue-50 text-blue-700",
      kind === "scene" && "border-emerald-200 bg-emerald-50 text-emerald-700",
      kind === "element" && "border-purple-200 bg-purple-50 text-purple-700",
      kind === "style" && "border-amber-200 bg-amber-50 text-amber-700",
      kind === "voice" && "border-orange-200 bg-orange-50 text-orange-700",
      kind === "vault" && "border-slate-200 bg-slate-50 text-slate-700",
    );
    chip.contentEditable = "false";
    chip.dataset.token = token;
    chip.dataset.kind = kind;
    if (resolvedId) chip.dataset.resolvedId = resolvedId;
    chip.title = token;
    chip.textContent = displayLabel;
    // 2026-07-22 X9-3 (A4-10 差距#2): 有主图/override 图的实体, chip 内嵌 16px 圆角缩略图.
    // append-on-load: 先挂 onload/onerror 再设 src, 只有成功加载才 prepend 到 chip 头 →
    //   加载失败 (图被删 / 坏链) 静默保持纯色 chip, 零 DOM 变更、不闪不抖;
    //   img 在 contentEditable=false 的 chip 内 → 不破坏光标/Backspace/选区语义;
    //   alt="" 让复制 chip 的 plain-text 不含图污染 (仍是 displayLabel, splitMentionTokens 可再解析);
    //   serializeDOM 对 chip 只读 dataset.token 不递归子节点 → 内嵌 img 对序列化透明.
    if (thumbnailUrl) {
      const img = document.createElement("img");
      img.alt = "";
      img.setAttribute("aria-hidden", "true");
      img.draggable = false;
      img.style.cssText =
        "width:16px;height:16px;border-radius:3px;object-fit:cover;margin-right:3px;flex:0 0 auto;display:block;";
      img.onload = () => { chip.insertBefore(img, chip.firstChild); };
      img.onerror = () => { /* 静默: 不插入, chip 保持纯色 */ };
      img.src = thumbnailUrl;
    }
    return chip;
  };

  // 2026-05-20 Wave T 第 6 次根因重构 — 删 findMentionTriggerInDOM:
  //   trigger 检测 + anchor rect 计算已 inline 到 handleInput 内 (用 atIndex 字符串 offset 取代).
  //   findMentionTriggerInDOM 前 3 次重写都没解决根本问题,因为它返回 { rect } 给 setOpen 但
  //   insertChipAtCaret 还得自己拿 selection (跑两边的 DOM 状态判断 → 必踩 race).
  //   第 6 次改用字符串 atIndex 一处计算多处用,简洁可靠。

  // ── Effects ──────────────────────────────────────────────────────────

  /**
   * 外部 value 变了 → 检查跟 DOM 序列化是否一致, 不一致重建.
   * (避免每次 onChange 都重建 DOM 让 caret 跳)
   *
   * 边界 case: mentionCtx 后到(useMentionSources 异步加载完)时, raw value 没变但
   * splitMentionTokens 现在能识别更多 chip — 需要强制重建。用 mentionCtx 引用变化
   * 触发重跑, 不能 short-circuit return。
   */
  const lastCtxRef = useRef<MentionContext>(mentionCtx);
  // 2026-07-22 X9-3: 缩略图解析器变化 (override 改动 / options 异步加载完) 也要触发重建刷新 chip 小图.
  const lastThumbRef = useRef(thumbForChip);
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const current = serializeDOM(editor);
    const ctxChanged = lastCtxRef.current !== mentionCtx;
    lastCtxRef.current = mentionCtx;
    const thumbChanged = lastThumbRef.current !== thumbForChip;
    lastThumbRef.current = thumbForChip;
    // value 跟 DOM 已一致 + ctx 未变 + 缩略图未变 → 跳过 (避免每次 onChange 都重建 DOM 让 caret 跳)
    if (current === value && !ctxChanged && !thumbChanged) return;
    // 重建前记 focus 状态 + caret 位置(用 textContent length 估算)
    const hadFocus = document.activeElement === editor;
    // 旧 caret 位置: 在 value 字符串里的 offset(简化方案 — 移到末尾, 用户重输时自然就位)
    // 2026-05-20 Wave T 第 4 次重写 — 删 skipNextSerializeRef.current = true(见上面 useRef 处的注释)
    renderValueToDOM(editor, value, mentionCtx, thumbForChip);
    // 2026-05-20 Wave T hotfix — 同步 data-empty(初始挂载 / 外部 set value 为空时)
    editor.setAttribute("data-empty", value === "" ? "true" : "false");
    if (hadFocus) {
      // 重建后 caret 放末尾 — 浏览器 selection API
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }, [value, mentionCtx, serializeDOM, renderValueToDOM, thumbForChip]);

  // autoFocus 处理 — 初次挂载聚焦
  useEffect(() => {
    if (autoFocus) {
      const editor = editorRef.current;
      editor?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Event handlers ───────────────────────────────────────────────────

  const handleInput = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const newValue = serializeDOM(editor);
    if (newValue !== value) {
      onChange(newValue);
    }
    editor.setAttribute("data-empty", newValue === "" ? "true" : "false");
    if (isComposingRef.current) return;

    // 2026-05-20 Wave T 第 6 次根因重构 — 字符串层面找 @ 位置 + 保存 (valueAtSave, atIndex):
    //
    // 用 Range API 拿 caret 在 newValue 字符串里的 offset:
    //   beforeRange = [editor 头, caret] → beforeRange.toString().length = caret 在 value 里的 offset
    // 如果 caret 前一字符 = "@" → 找到 trigger,atIndex = caret - 1
    // 双兜底:
    //   A. Range API 路径 — 精确
    //   B. textContent endsWith @ + caret 在末尾 — 兜底空 editor 首次输 @ 等 race case
    //
    // anchor rect 给 popover 弹窗用,不影响插入逻辑(插入完全用 atIndex 字符串替换)
    const fullText = editor.textContent ?? "";
    let atIndex = -1;
    let anchorRectCandidate: DOMRect | null = null;

    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && sel.isCollapsed) {
      const caretRange = sel.getRangeAt(0);
      if (editor.contains(caretRange.startContainer)) {
        try {
          const beforeRange = document.createRange();
          beforeRange.setStart(editor, 0);
          beforeRange.setEnd(caretRange.startContainer, caretRange.startOffset);
          const beforeText = beforeRange.toString();
          if (beforeText.endsWith("@")) {
            atIndex = beforeText.length - 1;
            const rect = caretRange.getBoundingClientRect();
            anchorRectCandidate = (rect.x === 0 && rect.y === 0 && rect.width === 0 && rect.height === 0)
              ? null
              : rect;
          }
        } catch { /* race — 走 textContent 兜底 */ }
      }
    }

    // textContent 兜底:末尾输 @ 100% 命中
    if (atIndex < 0 && fullText.endsWith("@")) {
      atIndex = fullText.length - 1;
    }

    if (atIndex >= 0) {
      // anchor rect 兜底 — 用 editor 末尾位置
      let rect = anchorRectCandidate;
      if (!rect) {
        const r = document.createRange();
        r.selectNodeContents(editor);
        r.collapse(false);
        rect = r.getBoundingClientRect();
      }
      savedTriggerInfoRef.current = { valueAtSave: newValue, atIndex };
      setQuery("");
      setAnchorRect(rect);
      setOpen(true);
    } else {
      setOpen(false);
    }
  }, [serializeDOM, value, onChange]);

  /**
   * 插 chip — 2026-05-20 Wave T 第 6 次根因重构: 纯字符串拼接,不依赖 DOM selection.
   *
   * 流程:
   *   1. 读 savedTriggerInfoRef (handleInput 保存的 { valueAtSave, atIndex })
   *   2. 字符串替换: before + token + " " + after
   *   3. onChange(newValue) → useEffect 自动重建 DOM
   *   4. setOpen(false) 关弹窗
   *
   * 优点:
   *   - 不依赖 window.getSelection() / Range / editor.focus()
   *   - 不踩 contenteditable 浏览器实现差异
   *   - 100% 可靠(纯字符串运算)
   *
   * 不足:
   *   - caret 在重建 DOM 时被 useEffect 移到末尾(用户继续输入位置正确)
   *   - 若 chip 不在 value 末尾,caret 不在 chip 之后(下波再优化 caret 位置)
   */
  const insertChipAtCaret = useCallback((option: MentionOption) => {
    const info = savedTriggerInfoRef.current;
    const editor = editorRef.current;
    let newValue: string;

    if (info && info.atIndex >= 0 && info.atIndex < info.valueAtSave.length && info.valueAtSave[info.atIndex] === "@") {
      // 用保存的 trigger 信息 — 字符串替换 @ 为 chip token
      const before = info.valueAtSave.slice(0, info.atIndex);
      const after = info.valueAtSave.slice(info.atIndex + 1);
      newValue = `${before}${option.token} ${after}`;
    } else if (editor) {
      // 兜底:从当前 editor 拿 value,append chip token 到末尾
      const currentValue = serializeDOM(editor);
      const lastAt = currentValue.lastIndexOf("@");
      if (lastAt >= 0) {
        const before = currentValue.slice(0, lastAt);
        const after = currentValue.slice(lastAt + 1);
        newValue = `${before}${option.token} ${after}`;
      } else {
        // 完全找不到 @,直接 append(用户体验:@ 弹窗后用户键盘 Enter 选中,但 @ 已被某种途径删了)
        newValue = `${currentValue}${currentValue.endsWith(" ") ? "" : " "}${option.token} `;
      }
    } else {
      return; // editor 不存在,放弃
    }

    savedTriggerInfoRef.current = null;
    setOpen(false);
    onChange(newValue);
    // 2026-07-22 X9-2: 编辑器内键盘直选 (弹窗开着时 Enter 选 filtered[0]) 也记 MRU.
    // MentionPopover.selectIndex 是主咽喉; 这里兜底覆盖 popover input 未获焦时的编辑器直插路径
    // (recordMentionMru 幂等, 双记同一项无副作用).
    recordMentionMru(projectSlug, option);
    onMentionPick?.(option);
  }, [onChange, onMentionPick, serializeDOM, projectSlug]);

  // chip click — 弹 ChipDropdown 选具体图
  const handleChipClick = useCallback((chipEl: HTMLElement) => {
    if (!onChipImagePick) return;
    if (!projectSlug) return;
    const resolvedId = chipEl.dataset.resolvedId;
    if (!resolvedId) return;
    const rect = chipEl.getBoundingClientRect();
    setChipDropdown({
      elementId: resolvedId,
      elementData: null,
      anchorRect: rect,
    });
    // 异步拉完整 ElementData
    void (async () => {
      try {
        const { element } = await getElement(projectSlug, resolvedId);
        setChipDropdown((prev) => (prev && prev.elementId === resolvedId
          ? { ...prev, elementData: element }
          : prev));
      } catch (e) {
        // 2026-05-27 audit Agent#1 P1 #20: 之前连续两 toast 弹用户视觉炸裂 (warning + error),
        // 改单 toast + 详细 message. 拿不到素材时 fallback 本地缓存 (下面 if (src) 分支真做了),
        // 用户实际拿到部分数据可继续.
        void e;
        toast.warning("素材信息加载失败, 已用本地缓存兜底, 缩略图可能不是最新", { duration: 4000 });
        // fallback — 本地 mock
        const ch = characters.find(c => c.id === resolvedId);
        const sc = scenes.find(s => s.id === resolvedId);
        const el = elements.find(e2 => e2.id === resolvedId);
        const src: any = el ?? ch ?? sc;
        if (src) {
          const elementView = {
            id: src.id,
            name: src.name,
            kind: el ? el.kind : (ch ? "character" : "scene"),
            images: src.images ?? [],
            primary_image_id: src.primary_image_id ?? null,
            image_briefs: src.image_briefs ?? [],
            description: src.description ?? src.appearance_prompt ?? src.location ?? "",
          } as unknown as ElementData;
          setChipDropdown((prev) => (prev && prev.elementId === resolvedId
            ? { ...prev, elementData: elementView }
            : prev));
        }
      }
    })();
  }, [onChipImagePick, projectSlug, characters, scenes, elements]);

  const handleChipImagePick = useCallback(
    async (imageId: string | null) => {
      if (!chipDropdown?.elementId) {
        setChipDropdown(null);
        return;
      }
      try {
        await onChipImagePick?.(chipDropdown.elementId, imageId);
      } catch (e) {
        // 2026-05-27 audit Agent#1 P1 #20: 同上, 单 toast 不再双弹
        const msg = e instanceof Error ? e.message : String(e);
        toast.error(`选图应用失败, 请刷新页面后重试: ${msg}`, { duration: 4000 });
      } finally {
        setChipDropdown(null);
      }
    },
    [chipDropdown, onChipImagePick],
  );

  // 鼠标点击 — 委托检测 chip 点击
  const handleEditorMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.classList && target.classList.contains("mention-chip")) {
      e.preventDefault();
      handleChipClick(target);
    }
  }, [handleChipClick]);

  // 粘贴 — 只接受 plain text
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    // 多行处理 — 按 \n 拆插 textNode + <br>
    const segments = text.split("\n");
    const frag = document.createDocumentFragment();
    for (let i = 0; i < segments.length; i++) {
      if (segments[i]) frag.appendChild(document.createTextNode(segments[i]));
      if (i < segments.length - 1) frag.appendChild(document.createElement("br"));
    }
    const lastNode = frag.lastChild;
    range.insertNode(frag);
    if (lastNode) {
      const after = document.createRange();
      after.setStartAfter(lastNode);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
    }
    handleInput();
  }, [handleInput]);

  // 候选选项过滤
  const filtered = useMemo(() => {
    const needle = normalize(query);
    if (!needle) return options;
    return options.filter((opt) => normalize(`${opt.label} ${opt.token} ${opt.description ?? ""}`).includes(needle));
  }, [options, query]);

  // 容器 / 编辑器 style — 复用 Textarea base 视觉
  const editorStyle: React.CSSProperties = {
    border: `1px solid var(--ink-200, #c7c1b9)`,
    backgroundColor: "var(--surface-card, #ffffff)",
    minHeight: `${Math.max(rows * 24, 120)}px`,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    ...editorStyleOverride,
  };

  return (
    <div className={cn("v24-mention-field flex flex-col gap-2", className)}>
      <div className="relative">
        <div
          ref={editorRef}
          role="textbox"
          aria-multiline="true"
          aria-label={placeholder}
          contentEditable={!disabled}
          suppressContentEditableWarning
          data-placeholder={placeholder || "输入内容..."}
          spellCheck={false}
          onInput={handleInput}
          onMouseDown={handleEditorMouseDown}
          onPaste={handlePaste}
          onCompositionStart={() => { isComposingRef.current = true; }}
          onCompositionEnd={() => {
            isComposingRef.current = false;
            // composition 结束后再做一次 trigger 检测(用户可能输完中文紧接 @)
            handleInput();
          }}
          onFocus={(e) => { onFocus?.(e); }}
          onBlur={(e) => { onBlur?.(e); }}
          onKeyDown={(e) => {
            if (open) {
              if (e.key === "Escape") {
                e.preventDefault();
                setOpen(false);
                return;
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (filtered[0]) insertChipAtCaret(filtered[0]);
                return;
              }
              // ArrowDown / ArrowUp 让 MentionPopover 处理 (它的 input 监听 keydown)
              // 但 contenteditable 也会消费 — 这里不 preventDefault, 让事件冒泡
            }
            // Enter 默认浏览器在 contenteditable 里插 <div>, 改成 <br> 跟 textarea 一致
            if (e.key === "Enter" && !e.shiftKey && !open) {
              e.preventDefault();
              const sel = window.getSelection();
              if (sel && sel.rangeCount > 0) {
                const range = sel.getRangeAt(0);
                range.deleteContents();
                const br = document.createElement("br");
                range.insertNode(br);
                // 在 br 后插 zero-width-space 让 caret 可定位(Firefox 行为差异 fix)
                const after = document.createRange();
                after.setStartAfter(br);
                after.collapse(true);
                sel.removeAllRanges();
                sel.addRange(after);
                handleInput();
              }
            }
            onKeyDown?.(e);
          }}
          className={cn(
            "v24-mention-editor",
            "w-full rounded-[var(--r-md)] px-3 py-2 text-[var(--fs-md)] text-[var(--ink-950)] leading-relaxed",
            "focus:outline-none focus:ring-2 focus:ring-[var(--brand-500)]/30",
            disabled && "cursor-not-allowed opacity-50",
            editorClassName,
          )}
          style={editorStyle}
        />
        {/* 2026-05-19 #6: 即使 filtered 为空也显示弹窗(配 footer 引导用户补图),
            原逻辑 filtered.length > 0 才显示, 改成 open 一律显示. */}
        {open && (
          <MentionPopover
            open={open}
            options={filtered}
            query={query}
            onPick={insertChipAtCaret}
            onClose={() => setOpen(false)}
            anchorRect={anchorRect}
            className="v24-mention-textarea-popover"
            projectSlug={projectSlug}
            onTriggerBatchImage={onTriggerBatchImage}
          />
        )}
        {/* 2026-05-20: ChipDropdown — 点 chip 后弹出选图 */}
        {chipDropdown && projectSlug && (
          <ChipDropdown
            slug={projectSlug}
            element={chipDropdown.elementData}
            currentImageId={(() => {
              const found = chipImageOverrides?.find(o => o.element_id === chipDropdown.elementId);
              return found?.image_id ?? null;
            })()}
            onPick={(imageId) => { void handleChipImagePick(imageId); }}
            onClose={() => setChipDropdown(null)}
            anchorRect={chipDropdown.anchorRect}
          />
        )}
      </div>
    </div>
  );
}
