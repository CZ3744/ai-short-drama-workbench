/**
 * AIAssistantPanel — AI 润色助手浮窗 (2026-05-27)
 *
 * 用户原话: "再加入一个 ai 润色功能，在创作过程中可以调用我选择的文字模型扫描和
 *           建议对创作内容有什么改动... 入口如何实现这个你来确定".
 *
 * 设计参考 Cursor / Notion AI / Linear 命令面板风格:
 *   - 右下浮动按钮 (在 GlobalQueuePanel 按钮上方, bottom: 88px)
 *   - 点击展开 440×90vh 右侧抽屉
 *   - 聊天 UI: 历史消息 + 输入框 + 模型选择器
 *   - 自动注入当前页面上下文 (slug/epId/shotId 从 pathname 解析)
 *   - 对话历史 localStorage 持久化, 跨刷新保留
 *
 * 后端走 POST /api/v2/ai/ask (现成, 见 aiController.ts) — 不改后端.
 * 上下文打包: 当前页面定位 + (可选) 当前 shot/episode/series 内容摘要.
 */

import { useGlobalTool } from "../shell/GlobalTools";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";
import { toast } from "sonner";
import { Icon } from "../shared/Icon";
import { Button } from "../ui/button";
import { useConfirm } from "../ui/ConfirmModal";
import { Textarea } from "../ui/textarea";
import { ModelPicker } from "../studio/ModelPicker";
import { aiAsk, isNotImplemented } from "../../lib/shotApi";
import { patchShot } from "../../hooks/useShots";
import { formatBeijingTime } from "../../lib/format";
import { useSessionStore } from "../../stores/sessionStore";
import { labelEpisodeId, labelShotId } from "../../lib/sourceLabels";

// ─── 数据类型 ──────────────────────────────────────────────────────

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  ts: number;
  /** AI 消息: 调用花了多少 */
  cost_cny?: number;
  /** AI 消息: 用的模型 ref (展示用) */
  model_ref?: string;
}

const LS_KEY_HISTORY = "video-generate.ai-assistant.history.v1";
const LS_KEY_MODEL = "video-generate.ai-assistant.model.v1";
const MAX_HISTORY = 40; // 最多保留 40 条 (20 轮)

// ─── 历史持久化 ──────────────────────────────────────────────────────

function loadHistory(): ChatMessage[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage?.getItem(LS_KEY_HISTORY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatMessage[];
    return Array.isArray(parsed) ? parsed.slice(-MAX_HISTORY) : [];
  } catch {
    return [];
  }
}

function saveHistory(messages: ChatMessage[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage?.setItem(LS_KEY_HISTORY, JSON.stringify(messages.slice(-MAX_HISTORY)));
  } catch {
    /* 配额满 / 私密模式 - 静默 */
  }
}

function loadModel(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage?.getItem(LS_KEY_MODEL) ?? null;
  } catch {
    return null;
  }
}

function saveModel(value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value) window.localStorage?.setItem(LS_KEY_MODEL, value);
    else window.localStorage?.removeItem(LS_KEY_MODEL);
  } catch { /* noop */ }
}

// ─── 上下文解析 — 从 URL 拿当前页面定位 ──────────────────────────

interface PageContext {
  page: string;             // 当前页面友好名
  series_slug?: string;
  episode_id?: string;
  shot_id?: string;
  /** 一句话描述(第三人称, 含 slug) — 只喂给 LLM 当 system/context 用, 不展示给用户 */
  brief: string;
  /**
   * 2026-07-09 终验: 面向用户展示的当前位置提示(第二人称/去主语, 用系列标题而非 slug)。
   * 之前头部副标题直接显示 `brief`, 会把 slug 和"用户在…"这种第三人称系统日志口吻原样
   * 抛给用户看(违反铁律 #9 toC 兜底)。brief 继续喂给 LLM(第三人称/slug 对 LLM 无害),
   * displayLabel 专门给 UI, 两者不再复用同一字符串。
   */
  displayLabel: string;
}

function parsePageContext(pathname: string, seriesTitle?: string): PageContext {
  // /studio/:slug                         - SeriesDetail
  // /studio/:slug/script                  - ScriptCanvas
  // /studio/:slug/storyboard/:ep          - Shotboard (分镜板)
  // /studio/:slug/shot-stage/:ep/:shotId  - 单镜创作
  // /studio/:slug/compose/:ep             - 合成页
  // /studio/:slug/elements                - 素材库
  // /inbox                                - 灵感页
  const parts = pathname.split("/").filter(Boolean);
  const out: PageContext = { page: "工作台首页", brief: "用户在工作台首页", displayLabel: "当前: 工作台首页" };
  if (parts[0] === "inbox") {
    out.page = "灵感页";
    out.brief = "用户在灵感页 — 写创意 / 扩写成剧本";
    out.displayLabel = "当前: 灵感页";
    return out;
  }
  if (parts[0] === "studio" && parts[1]) {
    const slug = decodeURIComponent(parts[1]);
    out.series_slug = slug;
    // seriesTitle 拿不到(页面刚加载/请求还没回来)时 fallback 显示"当前系列", 不编造剧名假数据。
    const titleLabel = seriesTitle ? `《${seriesTitle}》` : "当前系列";
    if (parts.length === 2) {
      out.page = "系列总览";
      out.brief = `用户在系列 「${slug}」 的总览页`;
      out.displayLabel = `当前: ${titleLabel} · 总览`;
      return out;
    }
    const section = parts[2];
    if (section === "script") {
      out.page = "剧本编辑";
      out.brief = `用户在系列 「${slug}」 的剧本编辑页, 正在写整集剧本文案`;
      out.displayLabel = `当前: ${titleLabel} · 剧本编辑`;
    } else if (section === "storyboard" && parts[3]) {
      out.episode_id = parts[3];
      out.page = "分镜板";
      out.brief = `用户在系列 「${slug}」 第 ${parts[3]} 集的分镜板, 浏览/管理所有分镜`;
      out.displayLabel = `当前: ${titleLabel} · ${labelEpisodeId(parts[3])} · 分镜板`;
    } else if (section === "shot-stage" && parts[3] && parts[4]) {
      out.episode_id = parts[3];
      out.shot_id = parts[4];
      out.page = "单镜创作";
      out.brief = `用户在系列 「${slug}」 第 ${parts[3]} 集 ${parts[4]} 镜的单镜创作页, 写画面描述/抽首帧/抽视频`;
      out.displayLabel = `当前: ${titleLabel} · ${labelEpisodeId(parts[3])} · ${labelShotId(parts[4])} · 单镜创作`;
    } else if (section === "compose" && parts[3]) {
      out.episode_id = parts[3];
      out.page = "合成页";
      out.brief = `用户在系列 「${slug}」 第 ${parts[3]} 集的合成页, 把分镜合成完整视频`;
      out.displayLabel = `当前: ${titleLabel} · ${labelEpisodeId(parts[3])} · 合成`;
    } else if (section === "elements") {
      out.page = "素材库";
      out.brief = `用户在系列 「${slug}」 的素材库, 管理角色/场景/物品的代表图`;
      out.displayLabel = `当前: ${titleLabel} · 素材库`;
    } else {
      // 未识别的子路由 — 至少显示系列标题, 不落回默认的"工作台首页"(那是更大的误导).
      out.displayLabel = `当前: ${titleLabel}`;
    }
  }
  return out;
}

// ─── 背景提示词 — 让 LLM 理解他是谁 + 当前用户在干啥 ───────────

function buildSystemPrompt(ctx: PageContext): string {
  return [
    "你是 AI 短剧创作助手。这是一个本地 Windows 工作台:",
    "灵感 → LLM 扩写剧本 → 拆分镜 → 抽首帧 → 抽视频 → 合成 1080p 短视频。",
    "",
    `用户当前在: ${ctx.page}。`,
    `具体: ${ctx.brief}`,
    "",
    "你的工作:",
    "1. 听用户问题, 给出**具体、可执行**的建议 (不要笼统的'你可以试试...');",
    "2. 主动问用户能否给你看具体内容 (剧本片段 / 分镜描述 / 角色设定 / 提示词等),",
    "   缺信息就显式列出'你需要告诉我哪些内容才能给好建议';",
    "3. 用户让你润色文字时, 给出'修改前 / 修改后' 对比, 而不是只说'可以改成...';",
    "4. 用户让你扫一段创作, 给出 3-5 条**最重要**的改动建议, 不要罗列所有可改的细节;",
    "5. 短剧创作铁律: 跨分镜一致性 (角色/场景外观要稳), 节奏紧凑 (一镜一目的), 钩子开局,",
    "   情感真实, 转场自然 — 触发这些维度的问题时主动指出.",
    "",
    "回答用简体中文, 不要 emoji, 不要复读用户问题, 不要长篇大论。每段建议 ≤ 80 字。",
  ].join("\n");
}

// ─── 主组件 ────────────────────────────────────────────────────────

export function AIAssistantPanel() {
  const location = useLocation();
  // 2026-07-09 终验: seriesList 由 SeriesDetail.tsx loadSeries() 写入 sessionStore(与
  // AppTopBar 顶栏系列名同一份数据源), 用来把 URL 里的 slug 换回真实系列标题给用户看。
  const seriesList = useSessionStore((s) => s.seriesList);
  const ctx = useMemo(() => {
    const parts = location.pathname.split("/").filter(Boolean);
    const slug = parts[0] === "studio" && parts[1] ? decodeURIComponent(parts[1]) : undefined;
    const seriesTitle = slug ? seriesList.find((s) => s.slug === slug)?.title : undefined;
    return parsePageContext(location.pathname, seriesTitle);
  }, [location.pathname, seriesList]);

  const { open, setOpen } = useGlobalTool("assistant");
  const [messages, setMessages] = useState<ChatMessage[]>(loadHistory);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [modelRef, setModelRef] = useState<string | null>(loadModel);
  const scrollRef = useRef<HTMLDivElement>(null);
  const confirm = useConfirm();

  // 持久化
  useEffect(() => { saveHistory(messages); }, [messages]);
  useEffect(() => { saveModel(modelRef); }, [modelRef]);

  // 打开抽屉时自动滚到底部
  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [open, messages.length]);

  // 全局快捷键 Alt+I 打开/收起 (Alt 避免跟浏览器 Ctrl/Cmd+I 撞)
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.altKey && (e.key === "i" || e.key === "I")) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    const userMsg: ChatMessage = {
      id: `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: "user",
      content: text,
      ts: Date.now(),
    };
    // 立即把用户消息推入 UI, 让用户看到自己说了什么
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setSending(true);

    try {
      // 上下文打包: 当前页面定位 + 历史对话 (近 10 轮, 让 AI 记住前文)
      const history = [...messages, userMsg].slice(-10);
      const transcript = history
        .map((m) => `${m.role === "user" ? "用户" : "助手"}: ${m.content}`)
        .join("\n\n");
      const contextStr = [
        `# 当前页面`,
        ctx.brief,
        ctx.series_slug ? `- 系列 slug: ${ctx.series_slug}` : "",
        ctx.episode_id ? `- 分集 id: ${ctx.episode_id}` : "",
        ctx.shot_id ? `- 分镜 id: ${ctx.shot_id}` : "",
        "",
        `# 系统角色`,
        buildSystemPrompt(ctx),
        "",
        `# 对话历史 (近 ${history.length} 轮)`,
        transcript,
      ].filter(Boolean).join("\n");

      const res = await aiAsk({
        context: contextStr,
        question: text,
        llm_provider_id: modelRef ?? undefined,
        scope: ctx.shot_id
          ? { kind: "shot", id: ctx.shot_id }
          : ctx.series_slug
            ? { kind: "script", id: ctx.series_slug }
            : undefined,
      });
      if (isNotImplemented(res)) {
        throw new Error(res.reason);
      }
      const aiMsg: ChatMessage = {
        id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: "assistant",
        content: res.answer || "(模型没返回内容)",
        ts: Date.now(),
        cost_cny: res.cost_cny,
        model_ref: modelRef ?? undefined,
      };
      setMessages((prev) => [...prev, aiMsg]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`AI 助手出错: ${msg}`);
      // 把错误也放进消息流, 让用户看到上下文
      setMessages((prev) => [...prev, {
        id: `e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: "assistant",
        content: `(调用失败: ${msg}. 试试换个模型或在设置里检查 API Key)`,
        ts: Date.now(),
      }]);
    } finally {
      setSending(false);
    }
  }, [input, sending, messages, ctx, modelRef]);

  async function clearHistory() {
    if (messages.length === 0) return;
    // 2026-05-27 — 改 useConfirm() 网页级弹窗, 不再 window.confirm 浏览器原生弹窗
    // (CLAUDE.md 铁律 #6 + 用户原话: 弹窗要做页面级别).
    const ok = await confirm({
      title: "清空对话历史?",
      description: "本地缓存也一起清, 不可恢复。",
      confirmLabel: "清空",
      cancelLabel: "保留",
      variant: "destructive",
    });
    if (!ok) return;
    setMessages([]);
    saveHistory([]);
  }

  function copyMessage(content: string) {
    navigator.clipboard?.writeText(content).then(
      () => toast.success("已复制"),
      () => toast.error("复制失败"),
    );
  }

  /**
   * 2026-05-27 — 应用 AI 建议到当前分镜画面描述. 用户原话"AI 助手只能复制粘贴".
   *
   * 走 localStorage 中转 + 用户主动确认:
   *   1. AI 助手把内容写 localStorage["ai-suggestion-for:<slug>:<ep>:<shotId>"]
   *   2. ShotStagePage mount / 检测时, 看到 suggestion 就在 ComposeBox 上方
   *      显示一条"AI 助手有一条建议想插入到画面, [追加] [忽略]" banner.
   *   3. 用户点 [追加] 才真改 draft.action (追加到末尾, 不覆盖原有).
   *
   * 这样: AI 助手不直接动数据, 用户主动控制是否 apply, 且 ShotStagePage 那边能
   * 拿到当前完整 draft 做真"追加"而非覆盖. 非侵入 + 数据完整.
   */
  async function applyToShot(content: string) {
    if (!ctx.series_slug || !ctx.episode_id || !ctx.shot_id) {
      toast.error("当前不在单镜创作页, 切到某一镜的创作页再试");
      return;
    }
    try {
      const key = `ai-suggestion-for:${ctx.series_slug}:${ctx.episode_id}:${ctx.shot_id}`;
      const payload = {
        content: content.trim(),
        ts: Date.now(),
      };
      window.localStorage?.setItem(key, JSON.stringify(payload));
      toast.success("已暂存到本镜, 切回分镜页面顶部会有「追加」按钮", { duration: 5000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`暂存失败: ${msg}`);
    }
  }

  // 静默 patchShot 未用 lint
  void patchShot;

  // ── 浮动按钮 (常驻右下) ───────────────────────────────
  if (!open) {
    return (
      <button
        type="button"
        data-tool-trigger="assistant"
        onClick={() => setOpen(true)}
        style={{
          position: "relative",
          height: 44,
          minWidth: 96,
          padding: "0 14px",
          borderRadius: 999,
          background: "linear-gradient(135deg, var(--brand-600) 0%, var(--brand-500) 100%)",
          color: "#fff",
          border: "1px solid var(--brand-700)",
          boxShadow: "0 6px 18px rgba(217,119,87,0.32)",
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          fontSize: 13,
          fontWeight: 700,
          cursor: "pointer",
          zIndex: 50,
        }}
        title="AI 润色助手 — 看当前页面/扫剧本/给建议 (Alt+I 打开)"
      >
        <Icon name="sparkles" size={15} />
        AI 助手
      </button>
    );
  }

  // ── 抽屉 (右侧滑出) ─────────────────────────────────
  return createPortal(
    <div role="dialog" aria-label="AI 润色助手" data-tool-panel="assistant" tabIndex={-1}
      style={{
        position: "fixed",
        right: 12,
        bottom: 12,
        width: "min(440px, calc(100vw - 24px))",
        height: "min(720px, calc(100dvh - 48px))",
        display: "flex",
        flexDirection: "column",
        background: "var(--surface-card)",
        border: "1px solid var(--ink-100)",
        borderRadius: 14,
        boxShadow: "0 12px 36px rgba(40,32,24,0.22)",
        overflow: "hidden",
        zIndex: 200,
      }}
    >
      {/* 头部 */}
      <header
        style={{
          padding: "12px 14px",
          borderBottom: "1px solid var(--ink-100)",
          background: "linear-gradient(135deg, rgba(217,119,87,0.06) 0%, rgba(217,119,87,0.02) 100%)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Icon name="sparkles" size={15} style={{ color: "var(--brand-700)" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink-900)" }}>
            AI 润色助手
          </div>
          <div style={{ fontSize: 11, color: "var(--ink-500)", marginTop: 1 }}>
            {/* 2026-07-09 终验: 之前这里显示 ctx.brief(slug + 第三人称"用户在…"系统日志口吻),
                改用面向用户的 displayLabel(系列标题 + 第二人称"当前:…")。 */}
            {ctx.displayLabel}
          </div>
        </div>
        <Button variant="ghost" size="xs" iconLeft="close" onClick={() => setOpen(false)}>
          收起
        </Button>
      </header>

      {/* 模型 + 工具栏 */}
      <div
        style={{
          padding: "8px 14px",
          borderBottom: "1px solid var(--ink-100)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <ModelPicker
            kind="text"
            value={modelRef}
            onChange={setModelRef}
            size="sm"
            placeholder="选择文字模型 (留空走系统默认链)"
          />
        </div>
        <Button
          variant="ghost"
          size="xs"
          iconLeft="trash"
          onClick={() => void clearHistory()}
          disabled={messages.length === 0}
          title="清空对话历史"
        >
          清空
        </Button>
      </div>

      {/* 聊天区 */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "12px 14px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
          background: "var(--ink-50)",
        }}
      >
        {messages.length === 0 && (
          <EmptyHints
            onPick={(text) => setInput(text)}
            ctx={ctx}
          />
        )}
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            onCopy={() => copyMessage(m.content)}
            // 只有 ctx 指向具体单镜时才让"插入到本镜"按钮出现 — 否则 applyToShot 会 toast 报错
            // 这里把"是否能 apply"作为属性透传, 不让按钮永远在 (避免给用户错觉)
            canApplyToShot={!!ctx.shot_id}
            onApplyToShot={() => void applyToShot(m.content)}
          />
        ))}
        {sending && (
          <div style={{
            alignSelf: "flex-start",
            padding: "8px 12px",
            background: "var(--surface-card)",
            border: "1px solid var(--ink-100)",
            borderRadius: 10,
            fontSize: 12,
            color: "var(--ink-500)",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}>
            <Icon name="sparkles" size={12} className="mk-spin" style={{ color: "var(--brand-600)" }} />
            AI 思考中…
          </div>
        )}
      </div>

      {/* 输入区 */}
      <div
        style={{
          padding: "10px 14px 12px",
          borderTop: "1px solid var(--ink-100)",
          background: "var(--surface-card)",
        }}
      >
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={
            ctx.page === "单镜创作"
              ? "问 AI: 帮我把这一镜的画面描述润色 / 给我 3 个钩子开场建议 / 这段配音怎么改更紧凑?"
              : ctx.page === "剧本编辑"
                ? "问 AI: 扫这一集剧本看节奏有什么问题 / 这段对话像 NPC 在念稿, 帮我改自然点"
                : "问 AI: 我在做这个项目, 你看页面上的内容, 给我提建议 (Ctrl/⌘+Enter 发送)"
          }
          className="min-h-[80px] max-h-[160px] text-[12.5px]"
          disabled={sending}
        />
        <div style={{
          marginTop: 6,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}>
          <span style={{ fontSize: 10.5, color: "var(--ink-400)", flex: 1 }}>
            Ctrl/⌘ + Enter 发送 · 对话保留在本地 (跨刷新)
          </span>
          <Button
            variant="primary"
            size="sm"
            iconLeft="arrowRight"
            onClick={() => void send()}
            disabled={!input.trim() || sending}
            loading={sending}
          >
            {sending ? "发送中…" : "发送"}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ─── 子组件: 空状态推荐问题 ───────────────────────────────────

function EmptyHints({
  onPick, ctx,
}: { onPick: (text: string) => void; ctx: PageContext }) {
  const hints = useMemo(() => {
    if (ctx.page === "单镜创作") {
      return [
        "帮我把这一镜的画面描述润色得更具体, 给 AI 模型更清晰的指令",
        "这一镜的对白偏说明书, 帮我改得更自然像真人在说话",
        "给我 3 个不同情绪走向的备选 (紧张/温情/讽刺)",
        "运镜怎么设计能让这一镜更有冲击力?",
      ];
    }
    if (ctx.page === "剧本编辑") {
      return [
        "扫这一集剧本, 给我 3-5 条最重要的节奏问题",
        "开场不够抓人, 给我 3 个钩子方案 (前 5 秒)",
        "角色的对白都太书面, 帮我改自然点",
        "结尾不够干净, 给个收束建议",
      ];
    }
    if (ctx.page === "分镜板") {
      return [
        "扫这一集所有分镜, 看节奏 / 重复 / 跳跃感有什么问题",
        "哪几镜可以合并? 哪几镜信息密度太低?",
        "首尾两镜的呼应可以怎么加强?",
      ];
    }
    if (ctx.page === "灵感页") {
      return [
        "我有个题材想法, 你帮我评估能不能扩展成 3 分钟短剧",
        "这种题材在短视频平台最近的爆款套路是什么?",
        "给我 3 个钩子开场, 让用户前 3 秒不划走",
      ];
    }
    if (ctx.page === "合成页") {
      return [
        "整集片段的节奏感我看不出, 你扫一遍配音/字幕给我建议",
        "字幕停留时长怎么调更舒服?",
        "BGM 选什么风格能跟这一集情绪匹配?",
      ];
    }
    return [
      "我在写一个短剧项目, 你能看着我的页面给我建议吗",
      "帮我扫一下当前的内容, 找 3 条最值得改的地方",
      "给我推荐一些 AI 短剧创作的常见套路 / 避坑点",
    ];
  }, [ctx.page]);

  return (
    <div style={{ padding: 8 }}>
      <div style={{
        fontSize: 12,
        color: "var(--ink-600)",
        fontWeight: 600,
        marginBottom: 8,
      }}>
        <Icon name="sparkles" size={12} style={{ marginRight: 4, color: "var(--brand-600)" }} />
        试试问点这个 (点一下自动填入输入框)
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {hints.map((h, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onPick(h)}
            style={{
              textAlign: "left",
              padding: "8px 10px",
              background: "var(--surface-card)",
              border: "1px solid var(--ink-100)",
              borderRadius: 8,
              fontSize: 12,
              lineHeight: 1.5,
              color: "var(--ink-800)",
              cursor: "pointer",
              transition: "all 0.15s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = "var(--brand-400)";
              e.currentTarget.style.background = "rgba(217,119,87,0.05)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "var(--ink-100)";
              e.currentTarget.style.background = "var(--surface-card)";
            }}
          >
            {h}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── 子组件: 单条消息气泡 ─────────────────────────────────────

function MessageBubble({
  message, onCopy, canApplyToShot, onApplyToShot,
}: {
  message: ChatMessage;
  onCopy: () => void;
  /** 用户当前在不在单镜创作页 — 控制"插入到本镜"按钮是否显示 */
  canApplyToShot: boolean;
  onApplyToShot: () => void;
}) {
  const isUser = message.role === "user";
  return (
    <div
      style={{
        alignSelf: isUser ? "flex-end" : "flex-start",
        maxWidth: "92%",
        display: "flex",
        flexDirection: "column",
        gap: 3,
      }}
    >
      <div
        style={{
          padding: "8px 12px",
          background: isUser
            ? "linear-gradient(135deg, var(--brand-600), var(--brand-500))"
            : "var(--surface-card)",
          color: isUser ? "#fff" : "var(--ink-900)",
          border: isUser ? "none" : "1px solid var(--ink-100)",
          borderRadius: 10,
          fontSize: 12.5,
          lineHeight: 1.6,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {message.content}
      </div>
      <div
        style={{
          fontSize: 10,
          color: "var(--ink-400)",
          display: "flex",
          gap: 8,
          alignItems: "center",
          justifyContent: isUser ? "flex-end" : "flex-start",
        }}
      >
        <span>{formatBeijingTime(message.ts, { mode: "time" })}</span>
        {!isUser && (
          <>
            {message.cost_cny != null && (
              <span title="本次调用花费">¥{message.cost_cny.toFixed(4)}</span>
            )}
            <button
              type="button"
              onClick={onCopy}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                fontSize: 10,
                color: "var(--brand-700)",
                cursor: "pointer",
                textDecoration: "underline",
              }}
              title="复制 AI 回答"
            >
              复制
            </button>
            {canApplyToShot && (
              <button
                type="button"
                onClick={onApplyToShot}
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  fontSize: 10,
                  color: "var(--brand-700)",
                  cursor: "pointer",
                  textDecoration: "underline",
                  fontWeight: 600,
                }}
                title="把这段建议暂存到当前分镜, 回到分镜创作页一键追加"
              >
                插入到本镜
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
