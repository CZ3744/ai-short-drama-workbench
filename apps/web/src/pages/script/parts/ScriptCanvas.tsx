import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import CharacterCount from "@tiptap/extension-character-count";
import { Node, mergeAttributes, Extension, type Editor, type Extensions } from "@tiptap/core";
import { Plugin, PluginKey, Selection } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { ReplaceStep } from "prosemirror-transform";
import { cn } from "../../../lib/cn";
import { htmlToPlainText, plainTextToHtml } from "../../../lib/scriptText";
import { MentionPopover } from "../../../components/mention/MentionPopover";
// 2026-05-27 — MentionPreviewBar 删除 (见下方 JSX 内注释)
import {
  findMentionTrigger,
  useMentionSources,
  type MentionOption,
} from "../../../components/mention/mentionTokens";

// ====================================================================
// 自定义 TipTap 节点
// ====================================================================

/** 对白节点: 角色名 + ":" 前缀, 蓝色左边线 */
const DialogueNode = Node.create({
  name: "dialogue",
  group: "block",
  content: "inline*",
  defining: true,

  addAttributes() {
    return {
      character: { default: "角色" },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="dialogue"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "dialogue",
        class: "script-dialogue",
      }),
      [
        "span",
        { class: "script-dialogue-character" },
        `${HTMLAttributes.character || "角色"}: `,
      ],
      ["span", { class: "script-dialogue-text" }, 0],
    ];
  },
});

/** 旁白节点: 灰色斜体 */
const VoiceoverNode = Node.create({
  name: "voiceover",
  group: "block",
  content: "inline*",
  defining: true,

  parseHTML() {
    return [{ tag: 'div[data-type="voiceover"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "voiceover",
        class: "script-voiceover",
      }),
      0,
    ];
  },
});

/** 场景提示节点: 绿色小字 */
const StageDirectionNode = Node.create({
  name: "stage_direction",
  group: "block",
  content: "inline*",
  defining: true,

  parseHTML() {
    return [{ tag: 'div[data-type="stage_direction"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "stage_direction",
        class: "script-stage-direction",
      }),
      0,
    ];
  },
});

// ====================================================================
// P130-Wave2 2C: Emotion highlight extension
// 匹配对话中的 (哭), (怒), (冷), (笑), (哭泣), (愤怒) 等情绪标签并高亮
// ====================================================================

const EMOTION_HIGHLIGHT_RE = /\(([^)]*(?:哭|哭泣|怒|愤怒|生气|冷|冷漠|笑|开心)[^)]*)\)/g;

// 2026-05-28 audit P1: 用 PluginKey 类型参数化 + getState 走 key.getState 替代裸 this 强类型读取.
const EmotionHighlightPluginKey = new PluginKey<DecorationSet>("emotionHighlight");

const EmotionHighlightPlugin = new Plugin<DecorationSet>({
  key: EmotionHighlightPluginKey,
  state: {
    init() {
      return DecorationSet.empty;
    },
    apply(tr, _oldState) {
      const { doc } = tr;
      const decorations: Decoration[] = [];

      doc.descendants((node, pos) => {
        if (!node.isText) return;
        const text = node.text ?? "";
        let match;
        while ((match = EMOTION_HIGHLIGHT_RE.exec(text)) !== null) {
          const from = pos + match.index;
          const to = from + match[0].length;
          decorations.push(
            Decoration.inline(from, to, {
              class: "script-emotion-tag",
            })
          );
        }
      });

      return DecorationSet.create(doc, decorations);
    },
  },
  props: {
    decorations(state) {
      return EmotionHighlightPluginKey.getState(state);
    },
  },
});

const EmotionHighlight = Extension.create({
  name: "emotionHighlight",
  addProseMirrorPlugins() {
    return [EmotionHighlightPlugin];
  },
});

// ====================================================================
// P130-Wave2 2C: Character autocomplete extension
// 输入 "角色名(" 时弹出角色列表 + 情绪选项
// ====================================================================

interface AutocompleteState {
  active: boolean;
  range: { from: number; to: number } | null;
  query: string; // the character name before '('
}

const AutocompletePluginKey = new PluginKey<AutocompleteState>("charAutocomplete");

const autocompleteEmotions = ["哭", "怒", "冷", "笑", "哭泣", "愤怒", "生气", "冷漠", "开心"];

const AutocompletePlugin = (characters: Array<{ name: string }>) =>
  new Plugin<AutocompleteState>({
    key: AutocompletePluginKey,
    state: {
      init(): AutocompleteState {
        return { active: false, range: null, query: "" };
      },
      apply(tr, prev): AutocompleteState {
        // Reset on non-insert transactions
        if (!tr.docChanged) return prev;

        const meta = tr.getMeta(AutocompletePluginKey);
        if (meta === "dismiss") {
          return { active: false, range: null, query: "" };
        }

        // Check if user just typed '(' after a word
        // 2026-05-28 audit P1: instanceof ReplaceStep 替代裸 Step 强类型读取 slice/from 字段.
        // 只有 ReplaceStep 才有 slice / from 字段, 走类型 guard 后字段是强类型.
        const steps = tr.steps;
        let insertedChar = "";
        let insertPos = 0;
        for (const step of steps) {
          if (!(step instanceof ReplaceStep)) continue;
          const slice = step.slice;
          if (slice.content.size === 1) {
            const text = slice.content.textBetween(0, 1);
            if (text === "(") {
              insertedChar = "(";
              insertPos = step.from ?? tr.selection.from;
              break;
            }
          }
        }

        if (insertedChar === "(" && insertPos > 0) {
          // Read the word before '(' to see if it matches a known character
          const $pos = tr.doc.resolve(insertPos);
          const nodeBefore = $pos.nodeBefore;
          if (nodeBefore?.isText && nodeBefore.text) {
            // Get the last word before '('
            const textBefore = nodeBefore.text;
            const match = textBefore.match(/([一-鿿\w]+)$/);
            if (match) {
              const name = match[1];
              if (characters.some((c) => c.name === name)) {
                return {
                  active: true,
                  range: { from: insertPos, to: insertPos + 1 },
                  query: name,
                };
              }
            }
          }
        }

        return prev;
      },
    },
  });

const CharacterAutocomplete = Extension.create({
  name: "characterAutocomplete",

  addOptions() {
    return { characters: [] as Array<{ name: string }> };
  },

  addProseMirrorPlugins() {
    return [AutocompletePlugin(this.options.characters)];
  },
});

// ====================================================================
// ScriptCanvas 组件
// ====================================================================

export interface ScriptCanvasProps {
  content: string;
  onChange?: (html: string) => void;
  onSelectionChange?: (text: string, range: { from: number; to: number } | null) => void;
  editable?: boolean;
  className?: string;
  /** 高亮段落(用于 diff 模式, 段落索引数组) */
  highlightParagraphs?: number[];
  /** 选中范围(用于流光效果) */
  streamingRange?: { from: number; to: number } | null;
  /** P130-Wave2 2C: 已创建角色列表, 用于对白自动补全 */
  characters?: Array<{ name: string }>;
  projectSlug?: string;
}

const EMPTY_CHARACTERS: Array<{ name: string }> = [];

// Keep document navigation in the same transaction stream as typing. Native
// Ctrl/Command+End can move the DOM caret before selectionchange updates the
// editor state, so an immediately following Enter otherwise splits the old node.
const DocumentNavigation = Extension.create({
  name: "scriptDocumentNavigation",
  addKeyboardShortcuts() {
    const move = (end: boolean, extend: boolean) => {
      const { doc, selection } = this.editor.state;
      const head = (end ? Selection.atEnd(doc) : Selection.atStart(doc)).head;
      return this.editor.chain().setTextSelection(extend ? { from: selection.anchor, to: head } : head).scrollIntoView().run();
    };
    return {
      "Mod-Home": () => move(false, false),
      "Mod-End": () => move(true, false),
      "Mod-Shift-Home": () => move(false, true),
      "Mod-Shift-End": () => move(true, true),
    };
  },
});

/** Tiptap nulls schema on destroy; a committed React effect can still hold the old instance. */
function isLiveEditor(editor: Editor | null): editor is Editor {
  return Boolean(editor && !editor.isDestroyed && editor.schema);
}

export function ScriptCanvas({
  content,
  onChange,
  onSelectionChange,
  editable = true,
  className,
  streamingRange,
  characters = EMPTY_CHARACTERS,
  projectSlug,
}: ScriptCanvasProps) {
  const [selectionRect, setSelectionRect] = useState<DOMRect | null>(null);
  const [autocompleteVisible, setAutocompleteVisible] = useState(false);
  const [autocompleteQuery, setAutocompleteQuery] = useState("");
  const [autocompletePos, setAutocompletePos] = useState<{ x: number; y: number } | null>(null);
  const { options: mentionOptions } = useMentionSources(projectSlug);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionRange, setMentionRange] = useState<{ from: number; to: number } | null>(null);
  const [mentionAnchorRect, setMentionAnchorRect] = useState<DOMRect | null>(null);

  // 2026-05-28 audit P1: 用 Extensions (= AnyExtension[]) 替代裸数组强转.
  // StarterKit / Placeholder / CharacterCount 等都是 AnyExtension 子类型, 不需要 any 兜底.
  const extensions = useMemo<Extensions>(() => [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
    }),
    Placeholder.configure({ placeholder: "开始输入剧本..." }),
    CharacterCount,
    DocumentNavigation,
    DialogueNode,
    VoiceoverNode,
    StageDirectionNode,
    EmotionHighlight,
    CharacterAutocomplete.configure({ characters }),
  ], [characters]);

  // The parent persists Markdown and echoes normalized HTML. Reapplying that
  // echo drops trailing empty paragraphs and resets the caret after Enter.
  // Keep only the latest local echo: an older version must still replace it.
  const lastLocalContent = useRef<string | null>(null);

  // ── Autocomplete emotion insertion ──
  const editor = useEditor({
    // Create only after commit. A lazy/Suspense render may outlive Tiptap's
    // scheduled cleanup of a render-time instance before React effects run.
    immediatelyRender: false,
    extensions,
    content,
    editable,
    onUpdate: ({ editor }) => {
      if (!isLiveEditor(editor)) return;
      const html = editor.getHTML();
      lastLocalContent.current = plainTextToHtml(htmlToPlainText(html));
      onChange?.(html);
    },
    onSelectionUpdate: ({ editor }) => {
      if (!isLiveEditor(editor)) return;
      const { from, to } = editor.state.selection;
      if (from !== to) {
        const text = editor.state.doc.textBetween(from, to, " ");
        onSelectionChange?.(text, { from, to });
        // 计算选区位置
        const coords = editor.view.domAtPos(from);
        if (coords.node) {
          const range = document.createRange();
          range.setStart(coords.node, coords.offset);
          const endCoords = editor.view.domAtPos(to);
          range.setEnd(endCoords.node, endCoords.offset);
          const rect = range.getBoundingClientRect();
          setSelectionRect(rect);
        }
      } else {
        onSelectionChange?.("", null);
        setSelectionRect(null);
      }
    },
  });

  const handleInsertEmotion = useCallback(
    (emotion: string) => {
      if (!isLiveEditor(editor)) return;
      editor.commands.insertContent(`${emotion})`);
      setAutocompleteVisible(false);
    },
    [editor]
  );

  const updateMentionState = useCallback(() => {
    if (!isLiveEditor(editor) || !editable || !projectSlug) {
      setMentionOpen(false);
      return;
    }
    const { from, to, $from } = editor.state.selection;
    if (from !== to) {
      setMentionOpen(false);
      return;
    }

    try {
      const blockStart = from - $from.parentOffset;
      const textBefore = editor.state.doc.textBetween(blockStart, from, "\n", "\0");
      const trigger = findMentionTrigger(textBefore, textBefore.length);
      if (!trigger) {
        setMentionOpen(false);
        setMentionRange(null);
        return;
      }

      const docFrom = from - (textBefore.length - trigger.range.from);
      const coords = editor.view.coordsAtPos(from);
      setMentionQuery(trigger.query);
      setMentionRange({ from: docFrom, to: from });
      setMentionAnchorRect(new DOMRect(coords.left, coords.top, 1, coords.bottom - coords.top || 1));
      setMentionOpen(true);
    } catch {
      setMentionOpen(false);
      setMentionRange(null);
    }
  }, [editable, editor, projectSlug]);

  const insertMentionOption = useCallback(
    (option: MentionOption) => {
      if (!isLiveEditor(editor) || !mentionRange) return;
      editor
        .chain()
        .focus()
        .deleteRange(mentionRange)
        .insertContent(option.token)
        .run();
      setMentionOpen(false);
      setMentionRange(null);
    },
    [editor, mentionRange],
  );

  // 外部 content 变化时同步
  useEffect(() => {
    if (isLiveEditor(editor)) editor.setEditable(editable, false);
  }, [editor, editable]);

  useEffect(() => {
    if (!isLiveEditor(editor) || content === lastLocalContent.current) return;
    lastLocalContent.current = null;
    if (content !== editor.getHTML()) {
      editor.commands.setContent(content, { emitUpdate: false });
    }
  }, [content, editor]);

  // ── Autocomplete state monitoring ──
  useEffect(() => {
    if (!isLiveEditor(editor)) return;

    const updateAutocomplete = () => {
      if (!isLiveEditor(editor)) return;
      const state = AutocompletePluginKey.getState(editor.state);
      if (state?.active) {
        setAutocompleteQuery(state.query);
        setAutocompleteVisible(true);

        // Calculate dropdown position from the editor selection
        try {
          const { from } = editor.state.selection;
          const coords = editor.view.coordsAtPos(from + 1);
          const editorRect = editor.view.dom.getBoundingClientRect();
          setAutocompletePos({
            x: coords.left - editorRect.left,
            y: coords.bottom - editorRect.top + 4,
          });
        } catch {
          setAutocompletePos({ x: 0, y: 24 });
        }
      } else {
        setAutocompleteVisible(false);
      }
    };

    // Check on selection update
    editor.on("selectionUpdate", updateAutocomplete);
    // Also check on transaction
    editor.on("transaction", updateAutocomplete);
    editor.on("selectionUpdate", updateMentionState);
    editor.on("transaction", updateMentionState);

    return () => {
      editor.off("selectionUpdate", updateAutocomplete);
      editor.off("transaction", updateAutocomplete);
      editor.off("selectionUpdate", updateMentionState);
      editor.off("transaction", updateMentionState);
    };
  }, [editor, updateMentionState]);

  // 暴露 editor 供外部操作
  const editorContainerRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={editorContainerRef} className={cn("relative", className)}>
      {/* 流光效果 */}
      {streamingRange && isLiveEditor(editor) && (
        <StreamingOverlay editor={editor} range={streamingRange} />
      )}

      {/* P130-Wave2 2C: Autocomplete dropdown for character+emotion */}
      {autocompleteVisible && autocompletePos && characters.length > 0 && (
        <AutocompleteDropdown
          characterName={autocompleteQuery}
          characters={characters}
          position={autocompletePos}
          onSelect={(emotion) => handleInsertEmotion(emotion)}
          onDismiss={() => {
            setAutocompleteVisible(false);
            // Dismiss in plugin state
            if (!isLiveEditor(editor)) return;
            const tr = editor.state.tr.setMeta(AutocompletePluginKey, "dismiss");
            editor.view.dispatch(tr);
          }}
        />
      )}

      {/* 2026-05-19 #6: 把 projectSlug 透传, 让弹窗 footer 暴露"去生成 / 管理素材库" 入口.
          原 mentionOpen && mentionOptions.length > 0 改成 mentionOpen 即可, 让空 options 也能引导. */}
      <MentionPopover
        open={mentionOpen}
        options={mentionOptions}
        query={mentionQuery}
        onPick={insertMentionOption}
        onClose={() => setMentionOpen(false)}
        anchorRect={mentionAnchorRect}
        className="v24-script-mention-popover"
        projectSlug={projectSlug}
      />

      <EditorContent
        editor={editor}
        className={cn(
          "prose prose-sm max-w-none",
          "rounded-[var(--r-lg)] border border-[var(--ink-100)] bg-white p-[var(--sp-4)] min-h-[300px]",
          editable && "focus-within:ring-2 focus-within:ring-[var(--brand-500)]/30 focus-within:border-[var(--brand-500)]",
          "transition-colors",
          // 通用排版
          "[&_p]:text-[var(--ink-950)] [&_p]:leading-[var(--lh-normal)]",
          "[&_h1]:text-[var(--fs-2xl)] [&_h1]:font-bold [&_h1]:text-[var(--ink-950)]",
          "[&_h2]:text-[var(--fs-xl)] [&_h2]:font-semibold [&_h2]:text-[var(--ink-950)]",
          "[&_h3]:text-[var(--fs-lg)] [&_h3]:font-semibold [&_h3]:text-[var(--ink-950)]",
          "[&_blockquote]:border-l-[var(--brand-500)] [&_blockquote]:pl-[var(--sp-4)] [&_blockquote]:italic [&_blockquote]:text-[var(--ink-500)]",
          "[&_code]:bg-[var(--ink-100)] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded-[var(--r-sm)] [&_code]:text-[var(--fs-sm)]",
          "[&_.tiptap]:outline-none",
          // placeholder
          "[&_.tiptap p.is-editor-empty:first-child::before]:text-[var(--ink-300)] [&_.tiptap p.is-editor-empty:first-child::before]:float-left [&_.tiptap p.is-editor-empty:first-child::before]:h-0 [&_.tiptap p.is-editor-empty:first-child::before]:pointer-events-none",
          // 自定义节点样式
          "[&_.script-dialogue]:border-l-3 [&_.script-dialogue]:border-l-[var(--brand-500)] [&_.script-dialogue]:pl-[var(--sp-3)] [&_.script-dialogue]:my-1",
          "[&_.script-dialogue-character]:font-semibold [&_.script-dialogue-character]:text-[var(--brand-700)]",
          "[&_.script-dialogue-text]:text-[var(--ink-900)]",
          "[&_.script-voiceover]:italic [&_.script-voiceover]:text-[var(--ink-500)] [&_.script-voiceover]:my-1",
          "[&_.script-stage-direction]:text-[var(--fs-sm)] [&_.script-stage-direction]:text-[var(--ok)] [&_.script-stage-direction]:my-1",
          // P130-Wave2 2C: Emotion tag highlight in dialogue
          "[&_.script-emotion-tag]:bg-[var(--brand-100)] [&_.script-emotion-tag]:text-[var(--brand-700)] [&_.script-emotion-tag]:font-semibold [&_.script-emotion-tag]:px-0.5 [&_.script-emotion-tag]:rounded-[var(--r-sm)]",
        )}
      />
      {/* 2026-05-27 — MentionPreviewBar 删除 (调死端点 /api/projects/:slug/resolve-references
          v1 不兼容 v2 series, console spam 404 + 功能 nice-to-have, mention chip 已经有视觉反馈) */}
      {editable && projectSlug && null}
    </div>
  );
}

// ====================================================================
// P130-Wave2 2C: Autocomplete dropdown
// ====================================================================

const EMOTIONS = ["哭", "怒", "冷", "笑", "哭泣", "愤怒", "生气", "冷漠", "开心"];

function AutocompleteDropdown({
  characterName,
  characters,
  position,
  onSelect,
  onDismiss,
}: {
  characterName: string;
  characters: Array<{ name: string }>;
  position: { x: number; y: number };
  onSelect: (emotion: string) => void;
  onDismiss: () => void;
}) {
  // Filter characters matching the query (fuzzy)
  const matchingChars = characters.filter((c) =>
    c.name.toLowerCase().includes(characterName.toLowerCase()) ||
    characterName.toLowerCase().includes(c.name.toLowerCase())
  );

  // If only one character found (exact match), show emotion list
  const exactMatch = characters.find((c) => c.name === characterName);
  const showChars = !exactMatch && matchingChars.length > 0;

  return (
    <>
      {/* Backdrop to dismiss */}
      <div className="fixed inset-0 z-40" onClick={onDismiss} />

      <div
        className="absolute z-50 bg-white border border-[var(--ink-200)] rounded-[var(--r-md)] shadow-lg p-[var(--sp-2)] min-w-[160px]"
        style={{ left: position.x, top: position.y }}
      >
        {showChars ? (
          <>
            <div className="text-[var(--fs-xs)] text-[var(--ink-400)] px-2 py-1">
              匹配角色
            </div>
            {/* 保留原因 (2 个 dropdown 列表项): autocomplete 浮层选项 w-full text-left + 自定义 hover 主题色 (ink-50 / brand-50),Button ghost 是 center 对齐改后视觉破坏 dropdown list-item 形态 */}
            {matchingChars.slice(0, 8).map((c) => (
              <button
                key={c.name}
                className="w-full text-left px-2 py-1.5 text-[var(--fs-sm)] text-[var(--ink-800)] hover:bg-[var(--ink-50)] rounded-[var(--r-sm)]"
                onClick={() => {
                  // 2026-05-28 audit P1: 删除死代码 — pmViewDesc 取出来从未使用, onDismiss 才是真行为.
                  // 之前赋值 const view = ... 是历史插入逻辑残留, 现在角色插入走 AutocompletePlugin
                  // 内部 dispatch, 这里只负责关闭弹窗.
                  onDismiss();
                }}
              >
                {c.name}
              </button>
            ))}
          </>
        ) : exactMatch ? (
          <>
            <div className="text-[var(--fs-xs)] text-[var(--ink-400)] px-2 py-1">
              选择「{exactMatch.name}」的情绪
            </div>
            {EMOTIONS.map((em) => (
              <button
                key={em}
                className="w-full text-left px-2 py-1.5 text-[var(--fs-sm)] text-[var(--ink-800)] hover:bg-[var(--brand-50)] rounded-[var(--r-sm)] flex items-center gap-1.5"
                onClick={() => onSelect(em)}
              >
                <span className="text-[var(--fs-xs)] bg-[var(--brand-100)] text-[var(--brand-700)] px-1.5 py-0.5 rounded-[var(--r-sm)]">
                  ({em})
                </span>
                <span>插入</span>
              </button>
            ))}
          </>
        ) : null}
      </div>
    </>
  );
}

// ====================================================================
// 流光效果覆盖层
// ====================================================================

function StreamingOverlay({
  editor,
  range,
}: {
  editor: Editor;
  range: { from: number; to: number };
}) {
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!isLiveEditor(editor)) return;
    try {
      const startCoords = editor.view.domAtPos(range.from);
      const endCoords = editor.view.domAtPos(range.to);
      const domRange = document.createRange();
      domRange.setStart(startCoords.node, startCoords.offset);
      domRange.setEnd(endCoords.node, endCoords.offset);
      const r = domRange.getBoundingClientRect();
      const editorRect = editor.view.dom.getBoundingClientRect();
      setRect(
        new DOMRect(r.left - editorRect.left, r.top - editorRect.top, r.width, r.height)
      );
    } catch {
      setRect(null);
    }
  }, [editor, range.from, range.to]);

  if (!rect) return null;

  return (
    <div
      className="pointer-events-none absolute z-10 rounded"
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        background:
          "linear-gradient(90deg, transparent, var(--brand-200), var(--brand-400), var(--brand-200), transparent)",
        backgroundSize: "200% 100%",
        animation: "streaming-glow 1.5s linear infinite",
        opacity: 0.4,
      }}
    />
  );
}
