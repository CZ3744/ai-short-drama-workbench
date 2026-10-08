// v24-batch-all · InboxPage · 按 b3r-1 InboxList 视觉骨架真改造
// 来源: design-skill/video-generate/src/batch3.jsx:614-736 (via design-source/b3r-1.tsx)
// API 接通 (2026-05-13):
//   - 灵感存储: GET/POST/PATCH /api/v2/series/:slug/inspirations, localStorage 仅作镜像兜底
//   - "转剧本" → expandScriptV2(slug, raw_inspiration) → 跳到系列级 script 页
//   - "新建灵感" 弹窗收集 text + tags
//   - "导入截图" 暂置灰 + TODO(api: missing) (需后端 multipart upload + OCR)
// Wave 6-C (2026-05-15):
//   - T1: 灵感多选 + "用选中灵感创建剧本" 对话框
//   - 对话框含: 已选灵感预览 / 额外提示词 / 目标模式 radio / PromptReviewButton / 发送
// Wave 8-E (2026-05-16):
//   - T1: GuidedExpansionModal — 对话式 3 题引导 → 汇总 extra prompt → expand-script
import { useEffect, useMemo, useState } from "react";
import "./InboxPage.css";
import { useToggleSet } from "../../hooks/useToggleSet";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Icon } from "../../components/shared/Icon";
import { Button } from "../../components/ui/button";
import { PromptReviewButton, type PromptPreview } from "../../components/shared/PromptReviewButton";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
// 2026-05-20 Wave T hotfix — Inbox 阶段项目素材库可能没建,@ 引用无意义,且 chip token 会污染 expandScript LLM 输入。
// 退回 plain textarea(server 端 humanizeMentionText 兜底,用户写 `@林深` 当 plain text 也能被识别)
import { GuidedExpansionModal } from "../../components/inbox/GuidedExpansionModal";
import { ModelPicker } from "../../components/studio/ModelPicker";
import { ComposeBox } from "../../components/shot-stage/ComposeBox";
import { PageTransition } from "../../components/studio/PageTransition";
import { useUserProviders } from "../../hooks/useUserProviders";
import {
  createInspiration,
  expandScriptV2,
  listInspirations as fetchInspirations,
  patchInspiration,
  apiPost,
  type InspirationRecord,
} from "../../lib/api";
import { showErrorToast } from "../../lib/errorTranslate";
import { parseProviderFromModelRef, parseModelIdFromModelRef } from "../../lib/modelRef";
import { useAsyncAction } from "../../hooks/useAsyncAction";

type SrcKey = "Twitter" | "微博" | "Pinterest" | "截图" | "灵感" | "朋友圈" | "B 站";

type Inspiration = InspirationRecord;

const SRC_COLOR: Record<SrcKey, string> = {
  Twitter: "#1da1f2", "微博": "#e6162d", Pinterest: "#bd081c", "截图": "var(--ink-500)",
  "灵感": "var(--brand-500)", "朋友圈": "#07c160", "B 站": "#fb7299",
};

const COMMON_TAGS = ["雨夜", "暖光", "便利店", "霓虹", "蒸汽", "暧昧", "等待", "细节", "孤独", "都市"];

// 2026-05-28 audit P2: 统一 localStorage 命名前缀, 跟 tasksStore (video-generate.tasks.v2) 一致.
// 读时兼容老 key 防丢用户偏好.
function storageKey(slug: string | undefined): string {
  return `video-generate.inbox.inspirations:${slug || "_default"}`;
}
function legacyStorageKey(slug: string | undefined): string {
  return `inbox:${slug || "_default"}`;
}

// 2026-05-18 (铁律 #5 真实保存): 新建灵感草稿 — 防 F5 / 关 tab 输入丢失
function draftStorageKey(slug: string | undefined): string {
  return `video-generate.inbox.draft:${slug || "_default"}`;
}
function legacyDraftStorageKey(slug: string | undefined): string {
  return `inbox-draft:${slug || "_default"}`;
}

function loadDraft(slug: string | undefined): { text: string; tags: string } {
  if (typeof window === "undefined") return { text: "", tags: "" };
  try {
    const raw = localStorage.getItem(draftStorageKey(slug)) ?? localStorage.getItem(legacyDraftStorageKey(slug));
    if (!raw) return { text: "", tags: "" };
    const parsed = JSON.parse(raw);
    return {
      text: typeof parsed?.text === "string" ? parsed.text : "",
      tags: typeof parsed?.tags === "string" ? parsed.tags : "",
    };
  } catch {
    return { text: "", tags: "" };
  }
}

function saveDraft(slug: string | undefined, draft: { text: string; tags: string }) {
  if (typeof window === "undefined") return;
  try {
    if (!draft.text && !draft.tags) {
      localStorage.removeItem(draftStorageKey(slug));
    } else {
      localStorage.setItem(draftStorageKey(slug), JSON.stringify(draft));
    }
    // 清理老 key (audit P2 统一前缀)
    localStorage.removeItem(legacyDraftStorageKey(slug));
  } catch (err) {
    /* 后台日志: 草稿写入 localStorage 失败不影响用户编辑, 无需 toast */
    console.warn("[InboxPage] 草稿写入失败", err);
  }
}

// 2026-05-18 创建剧本对话框的 "额外提示词" 草稿 — 同样防 F5 输入丢失
function createScriptDraftKey(slug: string | undefined): string {
  return `video-generate.inbox.create-script-draft:${slug || "_default"}`;
}
function legacyCreateScriptDraftKey(slug: string | undefined): string {
  return `inbox-create-script-draft:${slug || "_default"}`;
}

function loadCreateScriptDraft(slug: string | undefined): { extraPrompt: string; mode: CreateScriptMode } {
  if (typeof window === "undefined") return { extraPrompt: "", mode: "new_version" };
  try {
    const raw = localStorage.getItem(createScriptDraftKey(slug)) ?? localStorage.getItem(legacyCreateScriptDraftKey(slug));
    if (!raw) return { extraPrompt: "", mode: "new_version" };
    const parsed = JSON.parse(raw);
    return {
      extraPrompt: typeof parsed?.extraPrompt === "string" ? parsed.extraPrompt : "",
      mode: parsed?.mode === "replace" ? "replace" : "new_version",
    };
  } catch {
    return { extraPrompt: "", mode: "new_version" };
  }
}

function saveCreateScriptDraft(slug: string | undefined, draft: { extraPrompt: string; mode: CreateScriptMode }) {
  if (typeof window === "undefined") return;
  try {
    if (!draft.extraPrompt) {
      localStorage.removeItem(createScriptDraftKey(slug));
    } else {
      localStorage.setItem(createScriptDraftKey(slug), JSON.stringify(draft));
    }
    // 清理老 key (audit P2 统一前缀)
    localStorage.removeItem(legacyCreateScriptDraftKey(slug));
  } catch (err) {
    /* 后台日志: 创建剧本草稿 localStorage 写入失败, 无需 toast */
    console.warn("[InboxPage] 创建剧本草稿写入失败", err);
  }
}

function loadLocalInspirations(slug: string | undefined): Inspiration[] {
  try {
    const raw = localStorage.getItem(storageKey(slug)) ?? localStorage.getItem(legacyStorageKey(slug));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLocalInspirations(slug: string | undefined, list: Inspiration[]) {
  try {
    localStorage.setItem(storageKey(slug), JSON.stringify(list));
    // 清理老 key (audit P2 统一前缀)
    localStorage.removeItem(legacyStorageKey(slug));
  } catch (err) {
    /* 后台日志: 灵感 localStorage 写入失败不影响用户操作, 无需 toast */
    console.warn("[InboxPage] localStorage 写入失败", err);
  }
}

// 2026-05-26 audit #4: 走统一 lib/format.ts:formatRelativeTime, 它已支持 ms number 入参.
import { formatRelativeTime as relTime } from "../../lib/format";

// ─── 多选创建剧本对话框 ────────────────────────────────────────────────────────

type CreateScriptMode = "new_version" | "replace";

interface CreateScriptDialogProps {
  slug: string;
  selected: Inspiration[];
  llmModelRef: string | null;
  onClose: () => void;
  onCreated: () => void;
}

function CreateScriptDialog({ slug, selected, llmModelRef: initialLlmModelRef, onClose, onCreated }: CreateScriptDialogProps) {
  const navigate = useNavigate();
  // 2026-05-18 (铁律 #5 真实保存 + #12 批改+发送一致): 草稿恢复, 防 F5 输入丢失.
  // 主键 slug — 不同系列各自一份草稿; 用户切系列 → 草稿不会窜.
  const initialDraft = useMemo(() => loadCreateScriptDraft(slug), [slug]);
  const [extraPrompt, setExtraPrompt] = useState(initialDraft.extraPrompt);
  const [mode, setMode] = useState<CreateScriptMode>(initialDraft.mode);
  // 2026-05-18: ComposeBox 让用户在 modal 内就近切换 LLM 模型 (而非靠父页面顶部的 picker)
  const [llmModelRef, setLlmModelRef] = useState<string | null>(initialLlmModelRef);

  // 500ms 防抖写盘 — 输入时落 localStorage. 发送成功后由父组件 onCreated 清掉.
  useEffect(() => {
    const t = setTimeout(() => {
      saveCreateScriptDraft(slug, { extraPrompt, mode });
    }, 500);
    return () => clearTimeout(t);
  }, [slug, extraPrompt, mode]);

  const combinedText = selected.map((s) => s.text).join("\n\n---\n\n");

  // useAsyncAction 接管 busy + 错误 toast — 内部 404 fallback 逻辑保留
  const sendAction = useAsyncAction(
    async () => {
      const raw_inspiration = extraPrompt.trim()
        ? `${combinedText}\n\n【用户补充】${extraPrompt.trim()}`
        : combinedText;

      // POST /api/v2/series/:slug/script-versions (W6-B 路由)
      // 兜底：若 W6-B 路由未就绪则 fallback 到 expand-script
      try {
        await apiPost(`/api/v2/series/${encodeURIComponent(slug)}/script-versions`, {
          raw_inspiration,
          mode,
          overrides: llmModelRef ? { llm_provider_id: llmModelRef } : {},
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        // 如果 404 / not implemented，fallback 到 expand-script
        if (msg.includes("404") || msg.includes("not_implemented") || msg.includes("Cannot POST")) {
          await expandScriptV2(slug, {
            raw_inspiration,
            overrides: llmModelRef ? { llm_provider_id: llmModelRef } : {},
          });
        } else {
          throw e;
        }
      }
    },
    {
      errorMessage: "创建剧本失败",
      onSuccess: async () => {
        const { toast } = await import("sonner");
        // V-2.2: 强制跳转改 toast + action (UX 铁律 #1)
        toast.success("剧本版本已创建", {
          duration: 6000,
          action: {
            label: "查看剧本",
            onClick: () => navigate(`/studio/${slug}/script`),
          },
        });
        // 2026-05-18: 创建成功 → 清掉草稿, 下次打开不会残留旧文本
        saveCreateScriptDraft(slug, { extraPrompt: "", mode: "new_version" });
        onCreated();
      },
    },
  );
  const busy = sendAction.busy;
  async function handleSend() {
    await sendAction.run();
  }

  async function loadPromptPreview(): Promise<PromptPreview> {
    try {
      const res = await apiPost<{ preview: PromptPreview }>(
        `/api/v2/series/${encodeURIComponent(slug)}/script-versions/preview`,
        {
          raw_inspiration: combinedText,
          extra_prompt: extraPrompt,
          mode,
          overrides: llmModelRef ? { llm_provider_id: llmModelRef } : {},
        }
      );
      return res.preview;
    } catch {
      // 降级：直接构造本地预览
      return {
        kind: "text",
        full_prompt: `你是一位专业编剧。以下是用户提供的灵感素材：\n\n${combinedText}${extraPrompt ? `\n\n补充要求：${extraPrompt}` : ""}`,
        system_prompt: "你是一位专业短剧编剧，擅长将碎片灵感扩写成完整剧本结构。",
        target_provider: parseProviderFromModelRef(llmModelRef) ?? "（系统默认）",
        target_model: parseModelIdFromModelRef(llmModelRef) ?? "（系统默认）",
      };
    }
  }

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 100,
        display: "grid", placeItems: "center", padding: 24,
        background: "rgba(40,30,24,0.42)",
      }}
    >
      <div
        className="mk-card"
        role="dialog"
        aria-modal="true"
        aria-label="用选中灵感创建剧本"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(580px, calc(100vw - 32px))", borderRadius: 16, padding: 24, boxShadow: "var(--shadow-xl)" }}
      >
        {/* 标题 */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 750, color: "var(--ink-900)" }}>
            用 {selected.length} 条灵感创建剧本
          </h3>
          {/* W8-sweep (2026-05-16): icon-only → icon + 文字 (铁律 #11) */}
          <Button variant="ghost" size="sm" iconLeft="close" title="关闭面板" onClick={onClose}>
            关闭
          </Button>
        </div>

        {/* 已选灵感预览 */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-400)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
            已选灵感
          </div>
          <div
            style={{
              maxHeight: 130, overflowY: "auto", padding: "10px 12px",
              background: "var(--brand-25, rgba(217,119,87,0.04))",
              border: "1px solid var(--brand-100, #f3d9cc)",
              borderRadius: 10,
              fontSize: 12.5, lineHeight: 1.65, color: "var(--ink-800)",
              fontFamily: "'Noto Serif SC', serif",
            }}
          >
            {selected.map((s, i) => (
              <div key={s.id} style={{ marginBottom: i < selected.length - 1 ? 8 : 0 }}>
                {i + 1}. {s.text.length > 100 ? s.text.slice(0, 100) + "…" : s.text}
              </div>
            ))}
          </div>
        </div>

        {/* 目标模式 radio — 保留 */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-400)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
            操作目标
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {([
              ["new_version", "作为新版本并存（推荐）", "保留当前剧本，在版本历史里新建一个版本"],
              ["replace", "替代当前剧本", "覆盖当前剧本内容（原内容不可恢复）"],
            ] as const).map(([val, label, desc]) => (
              <label
                key={val}
                style={{
                  display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 12px",
                  borderRadius: 10, cursor: "pointer",
                  border: `1.5px solid ${mode === val ? "var(--brand-400)" : "var(--ink-150, #e8e3df)"}`,
                  background: mode === val ? "var(--brand-25, rgba(217,119,87,0.04))" : "var(--surface-card)",
                  transition: "border-color 0.15s, background 0.15s",
                }}
              >
                <input
                  type="radio"
                  name="create_script_mode"
                  value={val}
                  checked={mode === val}
                  onChange={() => setMode(val)}
                  style={{ marginTop: 2, accentColor: "var(--brand-500)", flexShrink: 0 }}
                />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-900)" }}>{label}</div>
                  <div style={{ fontSize: 11.5, color: "var(--ink-500)", marginTop: 2 }}>{desc}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* 2026-05-18: ChatGPT 风格 ComposeBox kind="text" 替代 textarea + LLM 模型 + 创建按钮 三段.
            用户原话: "这种逻辑完全可以复用的". 模型就近选, Cmd+Enter 发送, @ 召唤仅插入文本.
            count=1, countPresets=[] 隐藏候选数 (LLM 不抽 N 份). */}
        <ComposeBox
          kind="text"
          slug={slug}
          value={extraPrompt}
          onChange={setExtraPrompt}
          modelRef={llmModelRef}
          onModelChange={setLlmModelRef}
          count={1}
          onCountChange={() => { /* text kind 固定 1 份, 无 N 抽 */ }}
          busy={busy}
          busyLabel="创建中..."
          onDraw={() => void handleSend()}
          placeholder="告诉 AI 你想要的风格、时长、主角设定、特殊要求… (可选)。Ctrl/Cmd + Enter 创建剧本。"
          drawLabel="创建剧本"
          countPresets={[]}
        />

        {/* 2026-07-09 audit C9: ComposeBox 2026-05-27 重构后不再内嵌预览按钮, 旧的 off-screen
            ref-click 技巧 (onPreviewPrompt + left:-9999 隐藏) 永不触发 → "查看完整提示词" 100%
            不可点 (违反铁律 #2 可干预性). 真实按钮内联渲染在"创建剧本"旁, 用户可看/改/复制/外送. */}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
          <PromptReviewButton
            loadPrompt={loadPromptPreview}
            label="查看完整提示词"
            size="sm"
            disabled={busy}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end", marginTop: 10 }}>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
            取消
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── 主组件 ────────────────────────────────────────────────────────────────────

export default function InboxPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();

  const [list, setList] = useState<Inspiration[]>(() => loadLocalInspirations(slug));
  const [filter, setFilter] = useState<"unread" | "saved" | "expanded" | "all">("unread");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  // 2026-05-18 (铁律 #5 真实保存): 草稿恢复 — F5 / 关 tab 后输入不丢
  const initialDraft = useMemo(() => loadDraft(slug), [slug]);
  const [draftText, setDraftText] = useState(initialDraft.text);
  const [draftTags, setDraftTags] = useState(initialDraft.tags);

  // 500ms 防抖把输入写到 localStorage; 草稿空 → 自动清 key.
  useEffect(() => {
    const t = setTimeout(() => {
      saveDraft(slug, { text: draftText, tags: draftTags });
    }, 500);
    return () => clearTimeout(t);
  }, [slug, draftText, draftTags]);

  // 用户写了草稿但没打开 adding 面板 → 下次进来自动展开,提示"上次没写完"
  useEffect(() => {
    if (!adding && (initialDraft.text || initialDraft.tags)) {
      setAdding(true);
    }
    // 只在 slug 切换时跑一次 — 不能依赖 adding 否则关闭面板就立刻又开
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);
  const [expandingId, setExpandingId] = useState<string | null>(null);
  const [llmModelRef, setLlmModelRef] = useState<string | null>(null);
  // T1: 多选
  const { ids: selectedIds, toggle: toggleInspId, clear: clearInspIds, replace: replaceInspIds, has: hasInspSelected, size: selectedInspCount } = useToggleSet<string>();
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  // W8-E T1: 引导弹窗 — { open: bool, sourceItem: Inspiration | null }
  const [guidedItem, setGuidedItem] = useState<{ open: boolean; item: Inspiration | null }>({ open: false, item: null });
  const { providers } = useUserProviders();
  const hasAnyKey = providers.text.some((p) => p.enabled && p.key_present);

  // slug 变化时先读本地镜像, 再以服务端为准
  useEffect(() => {
    let cancelled = false;
    setList(loadLocalInspirations(slug));
    clearInspIds(); // 切系列时清空选中
    if (!slug) return () => { cancelled = true; };
    fetchInspirations(slug)
      .then((res) => {
        if (cancelled) return;
        setList(res.inspirations);
        saveLocalInspirations(slug, res.inspirations);
      })
      .catch((err) => {
        console.warn("[InboxPage] 加载服务端灵感失败, 使用本地镜像", err);
        toast.warning("已显示缓存数据, 服务器暂时不可达");
      });
    return () => { cancelled = true; };
  }, [slug]);

  function updateLocal(next: Inspiration[]) {
    setList(next);
    saveLocalInspirations(slug, next);
  }

  async function addInspiration() {
    const text = draftText.trim();
    if (!text) return;
    const tags = draftTags.split(/[,，#\s]+/).map((t) => t.trim()).filter(Boolean);
    const localItem: Inspiration = {
      id: `insp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      src: "灵感",
      user: "我",
      text,
      tags,
      createdAt: Date.now(),
      unread: true,
      type: "text",
      expandedEpisodeId: null,
    };
    setDraftText("");
    setDraftTags("");
    setAdding(false);
    // 2026-05-18: 保存成功 → 清掉 localStorage 草稿,下次进来不再自动展开 adding
    saveDraft(slug, { text: "", tags: "" });
    if (!slug) {
      updateLocal([localItem, ...list]);
      return;
    }
    try {
      const res = await createInspiration(slug, { src: "灵感", user: "我", text, tags, type: "text" });
      updateLocal([res.inspiration, ...list]);
    } catch (err) {
      updateLocal([localItem, ...list]);
      showErrorToast(err, "服务端保存灵感失败, 已暂存到本地");
    }
  }

  function toggleSave(id: string) {
    const item = list.find((i) => i.id === id);
    if (!item) return;
    const nextSaved = !item.saved;
    const prev = list;
    const next = list.map((i) => (i.id === id ? { ...i, saved: nextSaved } : i));
    updateLocal(next);
    if (slug) {
      patchInspiration(slug, id, { saved: nextSaved }).catch((err) => {
        updateLocal(prev);
        showErrorToast(err, "收藏状态同步失败");
      });
    }
  }

  function archive(id: string) {
    const prev = list;
    const next = list.map((i) => (i.id === id ? { ...i, unread: false } : i));
    updateLocal(next);
    if (slug) {
      patchInspiration(slug, id, { unread: false }).catch((err) => {
        updateLocal(prev);
        showErrorToast(err, "归档状态同步失败");
      });
    }
  }

  // T1: 切换单条选中
  function toggleSelect(id: string) {
    toggleInspId(id);
  }

  // 2026-05-18 (state closure bug): explicit overrideModelRef 优先于闭包 llmModelRef.
  // 历史: GuidedExpansionModal 选了新模型 → setLlmModelRef(modelRef) 是异步 → 立刻 await expandToScript
  // → expandToScript 闭包里 llmModelRef 还是旧值 → 实际调用用错模型. 现: 显式参数兜底.
  //
  // 2026-05-20 P1 铁律 #12 (批改+发送一致): 新增 promptOverride 参数, 由 PromptReviewButton
  // onSend 传入用户在 modal 编辑后的完整 prompt. 默认 undefined 走原 compile 路径.
  async function expandToScript(
    item: Inspiration,
    overrideModelRef?: string | null,
    promptOverride?: string,
  ) {
    if (!slug) {
      showErrorToast("当前不在系列上下文中, 请先创建/选择一个系列");
      return;
    }
    if (expandingId) return;
    // 没 LLM key → toast 引导, 不锁按钮 (PRODUCT_REQUIREMENTS.md 2026-05-13)
    if (!hasAnyKey) {
      const { toast } = await import("sonner");
      toast.error("还没配置 LLM Provider Key, 无法扩写剧本", {
        duration: 6000,
        action: { label: "去设置", onClick: () => navigate("/settings") },
      });
      return;
    }
    const effectiveModelRef = overrideModelRef !== undefined ? overrideModelRef : llmModelRef;
    try {
      setExpandingId(item.id);
      const res = await expandScriptV2(slug, {
        raw_inspiration: item.text,
        overrides: effectiveModelRef ? { llm_provider_id: effectiveModelRef } : {},
        // 铁律 #12: 用户改完点"用修改后版本发送" → 这里把编辑后的 prompt 透传到后端
        ...(promptOverride && promptOverride.trim().length > 0 ? { prompt_override: promptOverride } : {}),
      });
      // 标记已转
      const scriptRef = res.script_id ?? res.episode_id ?? "series";
      const next = list.map((i) => (i.id === item.id ? { ...i, expandedEpisodeId: scriptRef, unread: false } : i));
      updateLocal(next);
      patchInspiration(slug, item.id, { expandedEpisodeId: scriptRef, unread: false }).catch((err) => {
        showErrorToast(err, "标记灵感已转剧本失败");
      });
      // V-2.1: 强制跳转改 toast + action (UX 铁律 #1)
      // 2026-05-26 walkthrough fix: 后端 LLM 失败会 fallback 到原文 (fallback:true / cost.basis: undefined / message含"原始文本") —
      // 必须把假成功改成警告, 否则用户以为 AI 真扩写了但实际拿到的是原始灵感.
      const { toast: expandToast } = await import("sonner");
      const resRec = res as { fallback?: unknown; message?: unknown };
      const isFallback = Boolean(resRec.fallback) ||
        (typeof resRec.message === "string" && resRec.message.includes("原始文本"));
      if (isFallback) {
        expandToast.warning("LLM 不可用 — 已保留你的灵感原文, 但没真扩写", {
          duration: 10000,
          description: "去设置检查你的 Provider Key, 或换个 LLM 模型再试. 你也可以直接在剧本页手改.",
          action: {
            label: "查看剧本",
            onClick: () => navigate(`/studio/${slug}/script`),
          },
        });
      } else {
        expandToast.success("剧本已扩写完成", {
          duration: 6000,
          action: {
            label: "查看剧本",
            onClick: () => navigate(`/studio/${slug}/script`),
          },
        });
      }
    } catch (err) {
      showErrorToast(err, "扩写剧本失败 — 请检查 LLM Provider Key");
    } finally {
      setExpandingId(null);
    }
  }

  const filtered = useMemo(() => {
    let arr = list;
    if (filter === "unread") arr = arr.filter((i) => i.unread);
    else if (filter === "saved") arr = arr.filter((i) => i.saved);
    else if (filter === "expanded") arr = arr.filter((i) => i.expandedEpisodeId);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      arr = arr.filter((i) => i.text.toLowerCase().includes(q) || i.tags.some((t) => t.toLowerCase().includes(q)));
    }
    return arr;
  }, [list, filter, search]);

  // T1: 已选灵感对象列表
  const selectedInspirations = useMemo(
    () => list.filter((i) => hasInspSelected(i.id)),
    [list, selectedIds],
  );

  const unreadCount = list.filter((i) => i.unread).length;
  const savedCount = list.filter((i) => i.saved).length;
  const expandedCount = list.filter((i) => i.expandedEpisodeId).length;

  // 来源/标签聚合
  const sourceCounts = useMemo(() => {
    const m = new Map<SrcKey, number>();
    list.forEach((i) => m.set(i.src, (m.get(i.src) || 0) + 1));
    return m;
  }, [list]);

  return (
    <PageTransition>
      <div className="v24-inbox-page" style={{ width: "100%", height: "100%", display: "flex", background: "var(--surface-canvas)" }}>
        <button type="button" className="inbox-filter-toggle" aria-expanded={filtersOpen} aria-controls="inbox-filters" onClick={() => setFiltersOpen((open) => !open)}>
          <Icon name="filter" size={14} />
          {filtersOpen ? "收起筛选" : "筛选灵感"}
          <span>{({ unread: "未读", saved: "已收藏", expanded: "已转剧本", all: "全部" })[filter]}</span>
          <Icon name="chevDown" size={14} />
        </button>
        {/* 左过滤栏 */}
        <aside id="inbox-filters" className="inbox-filters" data-open={filtersOpen} style={{ width: 240, flexShrink: 0, background: "var(--surface-card)", borderRight: "1px solid var(--ink-100)", padding: "20px 12px", overflowY: "auto" }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: "var(--ink-400)", textTransform: "uppercase", padding: "0 10px 8px" }}>状态</div>
          {([
            ["unread", `未读 (${unreadCount})`],
            ["saved", `已收藏 (${savedCount})`],
            ["expanded", `已转剧本 (${expandedCount})`],
            ["all", `全部 (${list.length})`],
          ] as const).map(([k, t]) => {
            const on = filter === k;
            return (
              <button type="button" aria-pressed={on} key={k} onClick={() => { setFilter(k); setFiltersOpen(false); }} style={{ display: "flex", width: "100%", border: 0, alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: 8, marginBottom: 2, fontSize: 12.5, fontWeight: on ? 600 : 500, color: on ? "var(--brand-700)" : "var(--ink-700)", background: on ? "var(--brand-50)" : "transparent", cursor: "pointer" }}>{t}</button>
            );
          })}

          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: "var(--ink-400)", textTransform: "uppercase", padding: "16px 10px 8px" }}>来源</div>
          {Array.from(sourceCounts.entries()).map(([n, c]) => (
            <div key={n} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: 8, marginBottom: 2, fontSize: 12, color: "var(--ink-700)" }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: SRC_COLOR[n] }} />
              <span style={{ flex: 1 }}>{n}</span>
              <span style={{ fontSize: 10.5, color: "var(--ink-400)", fontFeatureSettings: '"tnum"' }}>{c}</span>
            </div>
          ))}

          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: "var(--ink-400)", textTransform: "uppercase", padding: "16px 10px 8px" }}>常用标签</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "0 6px" }}>
            {COMMON_TAGS.map((t, i) => (
              <span key={i} className="mk-chip" style={{ height: 22, fontSize: 11, cursor: "pointer" }} onClick={() => setSearch(t)}>#{t}</span>
            ))}
          </div>

          <div style={{ marginTop: 16, padding: "8px 10px", fontSize: 10.5, color: "var(--ink-400)", lineHeight: 1.5 }}>
            灵感跟随当前系列保存<br />
            转剧本时会一并保存到系列
          </div>
        </aside>

        {/* 右主区 */}
        <div className="mk-scroll inbox-main" style={{ flex: 1, minWidth: 0, overflow: "auto", padding: "20px 28px" }}>
          {/* 顶部工具栏 */}
          {/* 2026-05-26 — 加副标题说明灵感是什么 + 怎么用 (用户原话: "灵感收件箱有什么用?怎么点不了?")
              定位: 灵感是剧本的种子, 写下碎片想法 → 多选 → 一键扩写成剧本. */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
              <h2 style={{ margin: 0, fontFamily: "'Noto Serif SC', serif", fontSize: 20, fontWeight: 600, color: "var(--ink-900)" }}>灵感收件箱</h2>
              {unreadCount > 0 && <span className="mk-chip mk-chip--brand">{unreadCount} 条未读</span>}
            </div>
            <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink-500)", lineHeight: 1.55, maxWidth: 680 }}>
              把脑子里的画面、对话、场景写下来 —— 多条灵感勾选后, 一键扩写成完整剧本.
              来源支持微博/B站/朋友圈截图等, 按状态/来源/标签过滤.
            </p>
          </div>
          <div className="inbox-toolbar" style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 18 }}>
            <span style={{ display: "none" }} />{/* 占位保持原 div 结构, 防 layout 漂 */}
            <span style={{ flex: 1 }} />
            {!hasAnyKey && (
              <button type="button"
                onClick={() => navigate("/settings?tab=text")}
                title="点击去设置"
                style={{ display: "inline-flex", alignItems: "center", flexShrink: 0, whiteSpace: "nowrap", gap: 4, height: 28, border: 0, padding: "0 8px", borderRadius: 999, background: "var(--warn-bg)", color: "var(--warn)", fontSize: 11, cursor: "pointer" }}
              >
                <Icon name="warning" size={11} />连接文字模型
              </button>
            )}
            {/* 2026-07-09 audit(#90 就近决策修正) — "用哪个 LLM 扩写"是本次页面级默认, 不是 per-灵感 决策
                (state 本就是全局单值 llmModelRef). 之前每张卡各挂一个 ModelPicker 全绑同一值 → 改一个其余全变,
                制造"每卡可各自选模型"的错误心智 + 视觉冗余. 收敛到顶栏工具条单点呈现一次, 卡上只留生成动作. */}
            <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }} title="本次扩写 / 转剧本默认使用的文字模型">
              <span style={{ fontSize: 11.5, color: "var(--ink-500)", whiteSpace: "nowrap" }}>扩写模型</span>
              <ModelPicker kind="text" value={llmModelRef} onChange={setLlmModelRef} size="sm" placeholder="默认模型" />
            </div>
            <div className="inbox-search" style={{ display: "inline-flex", minWidth: 0, maxWidth: "100%", alignItems: "center", gap: 6, padding: "0 12px", height: 32, borderRadius: 10, background: "var(--ink-50)", border: "1px solid var(--ink-100)" }}>
              <Icon name="search" size={13} style={{ color: "var(--ink-400)" }} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索灵感、标签…"
                aria-label="搜索灵感或标签"
                style={{ width: 240, minWidth: 0, maxWidth: "100%", border: "none", outline: "none", background: "transparent", fontSize: 12 }}
              />
            </div>
            {/* T6: 导入截图功能尚未接通（需后端 multipart upload + OCR），暂隐藏，功能上线后再显示 */}
            <Button variant="primary" size="sm" iconLeft="plus" onClick={() => setAdding(true)}>新建灵感</Button>
          </div>

          {/* T1: 多选操作栏 — 选中 ≥1 条时出现 */}
          {selectedInspCount > 0 && (
            <div
              style={{
                display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10,
                padding: "10px 14px", marginBottom: 14,
                background: "var(--brand-25, rgba(217,119,87,0.06))",
                border: "1.5px solid var(--brand-200, #f3d9cc)",
                borderRadius: 12,
              }}
            >
              <Icon name="check" size={14} style={{ color: "var(--brand-600)" }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-800)" }}>
                已选 {selectedInspCount} 条灵感
              </span>
              <span style={{ flex: 1 }} />
              <Button variant="ghost" size="sm" onClick={() => clearInspIds()}>
                取消选择
              </Button>
              <Button
                variant="primary"
                size="sm"
                iconLeft="sparkles"
                onClick={() => {
                  if (!slug) {
                    showErrorToast("请先选择一个系列");
                    return;
                  }
                  setShowCreateDialog(true);
                }}
              >
                用选中灵感创建剧本
              </Button>
            </div>
          )}

          {adding && (
            <div className="mk-card" style={{ padding: 14, marginBottom: 16 }}>
              <Textarea
                value={draftText}
                onChange={(e) => setDraftText(e.target.value)}
                placeholder="把脑子里的画面/对话/场景写下来 — 写得越具体，AI 扩写出的剧本就越准"
                rows={3}
                autoFocus
                className="min-h-[96px] font-serif text-[13px] leading-[1.6]"
              />
              <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
                <Input
                  value={draftTags}
                  onChange={(e) => setDraftTags(e.target.value)}
                  placeholder="标签 (逗号分隔)"
                  className="flex-1 h-8 text-[12px]"
                />
                <Button variant="ghost" size="sm" onClick={() => { setAdding(false); setDraftText(""); setDraftTags(""); saveDraft(slug, { text: "", tags: "" }); }}>取消</Button>
                <Button variant="primary" size="sm" iconLeft="check" disabled={!draftText.trim()} onClick={addInspiration}>
                  保存
                </Button>
              </div>
            </div>
          )}

          {filtered.length === 0 ? (
            <div style={{ padding: "60px 20px", textAlign: "center", color: "var(--ink-500)" }}>
              <div style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 17, marginBottom: 8 }}>
                {list.length === 0 ? "灵感 Inbox 还是空的" : "没有匹配的灵感"}
              </div>
              <div style={{ fontSize: 12.5, color: "var(--ink-400)", marginBottom: 16 }}>
                {list.length === 0
                  ? "把脑子里的画面、对话、场景写下来 — 它们将变成下一部剧的种子"
                  : "试试切换状态过滤或清空搜索词"}
              </div>
              {list.length === 0 && (
                <Button variant="primary" size="sm" iconLeft="plus" onClick={() => setAdding(true)}>
                  写下第一个灵感
                </Button>
              )}
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" /* 2026-07-09 audit(UX): 固定3列窄屏每卡仅330-370px挤压控件, 改响应式随视口自适应列数(每列min300px) */, gap: 14 }}>
              {filtered.map((it) => {
                const expanding = expandingId === it.id;
                const isChecked = hasInspSelected(it.id);
                return (
                  <div
                    key={it.id}
                    className="mk-card"
                    style={{
                      padding: 0, overflow: "hidden", position: "relative",
                      display: "flex", flexDirection: "column",
                      border: isChecked ? "1.5px solid var(--brand-400)" : undefined,
                      background: isChecked ? "var(--brand-25, rgba(217,119,87,0.04))" : undefined,
                      transition: "border-color 0.15s, background 0.15s",
                    }}
                  >
                    {/* T1: 左上角复选框 */}
                    <div
                      style={{ position: "absolute", top: 10, left: 10, zIndex: 3 }}
                      onClick={(e) => { e.stopPropagation(); toggleSelect(it.id); }}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleSelect(it.id)}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`选择灵感: ${it.text.slice(0, 20)}`}
                        style={{
                          width: 16, height: 16,
                          accentColor: "var(--brand-500)",
                          cursor: "pointer",
                        }}
                      />
                    </div>

                    {it.unread && (
                      <span style={{ position: "absolute", top: 8, right: 8, zIndex: 2, width: 8, height: 8, borderRadius: 999, background: "var(--brand-500)", boxShadow: "0 0 0 3px rgba(217,119,87,0.18)" }} />
                    )}
                    <div style={{ height: 130, background: "linear-gradient(135deg, var(--brand-50) 0%, #fff 100%)", padding: "16px 18px 16px 34px", display: "flex", alignItems: "center", fontFamily: "'Noto Serif SC', serif", fontSize: 13, lineHeight: 1.7, color: "var(--ink-800)" }}>
                      &ldquo;{it.text.length > 60 ? it.text.slice(0, 60) + "…" : it.text}&rdquo;
                    </div>
                    <div style={{ padding: 12, flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                        <span style={{ height: 18, padding: "0 8px", borderRadius: 999, background: SRC_COLOR[it.src] ?? "var(--ink-200)", color: "#fff", fontSize: 10, fontWeight: 600, display: "inline-flex", alignItems: "center" }}>{it.src}</span>
                        <span style={{ fontSize: 10.5, color: "var(--ink-500)" }}>{it.user}</span>
                        <span style={{ flex: 1 }} />
                        <span style={{ fontSize: 10, color: "var(--ink-400)" }}>{relTime(it.createdAt)}</span>
                      </div>
                      {it.tags.length > 0 && (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {it.tags.map((tg, j) => (
                            <span key={j} className="mk-chip mk-chip--ghost" style={{ height: 18, fontSize: 10 }}>#{tg}</span>
                          ))}
                        </div>
                      )}
                      {it.expandedEpisodeId && (
                        <div style={{ marginTop: 8, fontSize: 10.5, color: "var(--ok)", display: "inline-flex", alignItems: "center", gap: 4 }}>
                          <Icon name="check" size={10} /> 已转剧本
                        </div>
                      )}
                    </div>
                    <div style={{ padding: "8px 12px", borderTop: "1px solid var(--ink-100)", display: "flex", flexWrap: "wrap", gap: 6, rowGap: 6, background: "var(--ink-50)" }}>
                      <Button variant="ghost" size="xs" iconLeft="check" disabled={!it.unread} title="标记已读" onClick={() => archive(it.id)}>
                        归档
                      </Button>
                      <Button variant="ghost" size="xs" iconLeft="pin" onClick={() => toggleSave(it.id)}>
                        {it.saved ? "已收藏" : "收藏"}
                      </Button>
                      <span style={{ flex: 1 }} />
                      {it.expandedEpisodeId ? (
                        <Button variant="secondary" size="xs" iconLeft="arrowRight" onClick={() => navigate(`/studio/${slug}/script`)}>
                          查看剧本
                        </Button>
                      ) : (
                        <>
                          {/* 铁律 #2: 每个 LLM 调用旁必须有"查看完整提示词"按钮, 可改可复制可外送.
                              onSend: 用户在 modal 内改完提示词点"用修改后版本发送" → 直接触发扩写 (铁律 #12 批改+发送一致). */}
                          <PromptReviewButton
                            size="sm"
                            label="查看提示词"
                            disabled={!slug || !!expandingId}
                            busy={!!expandingId}
                            loadPrompt={async (): Promise<PromptPreview> => {
                              const r = await apiPost<PromptPreview>(
                                `/api/v2/series/${encodeURIComponent(slug ?? "_default")}/preview-expand-prompt`,
                                {
                                  raw_inspiration: it.text,
                                  overrides: llmModelRef ? { llm_provider_id: llmModelRef } : {},
                                },
                              );
                              return r;
                            }}
                            onSend={async (finalPrompt) => {
                              // 2026-05-20 P1 铁律 #12 (批改+发送一致): 把用户在 modal 编辑后的
                              // 完整 prompt (finalPrompt 参数) 真传到后端, 不再只是用闭包闯空门.
                              // expandToScript 第 3 参数 promptOverride → expandScriptV2 → ExpandScriptSchema.prompt_override.
                              await expandToScript(it, undefined, finalPrompt);
                            }}
                          />
                          {/* W8-E T1: 引导扩写按钮 — 品牌色描边，保留原"转剧本"主按钮（铁律 #1）*/}
                          <Button
                            variant="ghost"
                            size="xs"
                            iconLeft="message"
                            disabled={!!expandingId}
                            title={
                              expandingId
                                ? "已有扩写在跑, 等完成后再试 (一次只能扩写一条灵感)"
                                : "先聊聊故事背景，AI 扩写更精准"
                            }
                            onClick={() => setGuidedItem({ open: true, item: it })}
                          >
                            先聊聊
                          </Button>
                          {/* 2026-07-09 audit(#90) — ModelPicker 移到页面顶部工具条 (全局单值, 不该 per-卡复制 N 份).
                              卡上只留生成动作: 查看提示词 / 先聊聊 / 转剧本. */}
                          <Button
                            variant="primary"
                            size="xs"
                            iconLeft="arrowRight"
                            loading={!!expanding}
                            disabled={!!expandingId}
                            title={
                              // P1-35 (2026-05-28 audit wave 4): 串行 expandingId 卡所有按钮时, 用户不知道为啥点不动.
                              expandingId
                                ? "已有扩写在跑, 等完成后再试 (一次只能扩写一条灵感)"
                                : hasAnyKey
                                  ? `用 ${llmModelRef ?? "默认文字模型"} 扩写`
                                  : "点击会引导去设置填 LLM Key"
                            }
                            onClick={() => expandToScript(it)}
                          >
                            {expanding ? "AI 扩写中…" : "转剧本"}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* T1: 多选创建剧本对话框 */}
      {showCreateDialog && slug && (
        <CreateScriptDialog
          slug={slug}
          selected={selectedInspirations}
          llmModelRef={llmModelRef}
          onClose={() => setShowCreateDialog(false)}
          onCreated={() => {
            setShowCreateDialog(false);
            clearInspIds();
          }}
        />
      )}

      {/* W8-E T1: 引导式扩写弹窗 */}
      {guidedItem.open && slug && (
        <GuidedExpansionModal
          slug={slug}
          initialText={guidedItem.item?.text}
          onClose={() => setGuidedItem({ open: false, item: null })}
          onExpand={async (extraPrompt, modelRef) => {
            setGuidedItem({ open: false, item: null });
            if (!guidedItem.item) return;
            // 2026-05-18 (state closure bug 修复):
            //   旧: setLlmModelRef(modelRef) 异步, await expandToScript() 闭包仍用旧 llmModelRef → 模型选错
            //   新: 显式把 modelRef 作参数传给 expandToScript, 函数内部 effectiveModelRef 优先用参数
            const itemWithExtra: Inspiration = {
              ...guidedItem.item,
              text: extraPrompt || guidedItem.item.text,
            };
            await expandToScript(itemWithExtra, modelRef);
          }}
        />
      )}
    </PageTransition>
  );
}
