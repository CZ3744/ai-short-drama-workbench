// v24-batch-all · ScriptCanvasPage · 按 b2a-1/2/3/4 剧本编辑器视觉骨架真改造
// 来源: design-skill/video-generate/src/batch2a.jsx (via design-source/b2a-1.tsx 等)
// 旧版本备份: apps/web/src/_legacy_phase2/script/ScriptCanvasPage.tsx.legacy
// API 接通 (2026-05-14):
//   - useSeriesScript(slug) — GET/PATCH /api/v2/series/:slug/script · 自动保存(5s)
//   - "生成分集与分镜" → POST /api/v2/series/:slug/plan-storyboard · 跳到 shotboard
//   - AI 助手 → shotApi.aiAsk (问 AI 不改主 tree)
//   - "AI 改写" 走 pending_suggestion → accept 通道 (shotApi.aiSuggest / acceptSuggest)
// Wave 6-C (2026-05-15):
//   - T2: VersionSwitcher 组件（W6-H 已切换为真实 import）
//   - T2: "我自己粘贴 AI 结果" 按钮 + 对话框（粘贴 JSON → import-storyboard / script-versions）
// Wave 8-E (2026-05-16):
//   - BeatSheetStrip 已删除(Wave B 决策):前端"假展示" 节拍轴误导用户(按 ## 段数估,
//     不接后端真 beat_sheet 数据)。后端 planEpisodeStoryboard beat_sheet_planner LLM
//     生分镜链路仍在工作(line 227-311), 不受影响。
import { useState, useMemo, useEffect, useRef, lazy, Suspense } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Icon } from "../../components/shared/Icon";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { plainTextToHtml, htmlToPlainText } from "../../lib/scriptText";
const ScriptCanvas = lazy(() => import("./parts/ScriptCanvas").then(module => ({ default: module.ScriptCanvas })));
import { InlineActionBar, type BarAction } from "./parts/InlineActionBar";
import { VersionSwitcher, type VersionSummary } from "../../components/shared/VersionSwitcher";
import { PromptReviewButton, type PromptPreview } from "../../components/shared/PromptReviewButton";
// 2026-05-20 Wave T hotfix — 剧本体量大(5000+ 字),contenteditable + chip 渲染严重性能不行,
// 且 markdown 段落 break 跟 chip 不兼容。退回 plain textarea(server 端 humanize 兜底)。
import { ModelPicker } from "../../components/studio/ModelPicker";
import { ComposeBox } from "../../components/shot-stage/ComposeBox";
import { PageTransition } from "../../components/studio/PageTransition";
import { useSeriesScript } from "../../hooks/useEpisodeScript";
import { useScriptVersions } from "../../hooks/useScriptVersions";
import { useUserProviders } from "../../hooks/useUserProviders";
import { apiPost, ApiError } from "../../lib/api";
import { aiAsk, aiSuggest, acceptSuggest, rejectSuggest, isNotImplemented } from "../../lib/shotApi";
import { invalidateSeries, invalidateShots } from "../../lib/swrInvalidate";
import { showErrorToast } from "../../lib/errorTranslate";
// 2026-07-10 Fable P0-1: 重拆分镜确认门 — 后端 409 拦截, 前端弹页面级确认弹窗
import { useConfirm } from "../../components/ui/ConfirmModal";
// 2026-05-18 EVE-4: 粘贴分镜对话框提取为共享组件,与 ShotboardPage 共用
import { PasteStoryboardDialog } from "../../components/script/PasteStoryboardDialog";
// 2026-05-19: 从剧本一键生成素材 — 与 ElementListPage 共用同一 dialog
import { ExtractFromScriptDialog } from "../../components/element/ExtractFromScriptDialog";

// ─── 纯文本 → HTML 转换 (ScriptCanvas 条件渲染用) ─────────────────────────────
// 服务端存储纯文本/简化 markdown; TipTap 需要 HTML。
// 转换: ## 标题 → <h2>, **粗体** → <strong>, *斜体* → <em>,
//       @Name 标签 → mention chip, 空行 → 段落分隔。
const RICH_TEXT_CHAR_LIMIT = 3000;


// 2026-07-09 audit(#96 第一性原理) — 时长估算只按"会被念出来的"台词/旁白字符估, 排除场景标题(##)、
// 舞台指示([...] / （...）)、角色名前缀等非口播内容. 之前用整篇字符数 / 6, 对描述多的剧本系统性虚高,
// 让创作者据此规划一集体量时被误导 (成片时长只由台词 / 旁白决定, 场景描述与导演批注不发声).
function estimateSpokenChars(text: string): number {
  if (!text) return 0;
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#")) // 排除场景标题 # / ## / ###
    .map((line) =>
      line
        .replace(/\[[^\]]*\]/g, "")             // 去方括号舞台指示  [走向门口]
        .replace(/（[^）]*）/g, "")              // 去全角括号舞台指示 （压低声音）
        .replace(/^[^\s:：]{1,10}[:：]\s*/, "")   // 去行首角色名标签  "林深："/"旁白:"
        .trim(),
    )
    .join("")
    .length;
}

// ─── 主组件 ────────────────────────────────────────────────────────────────────

interface PendingSuggestion {
  id: string;
  text: string;
  reason?: string;
  baseContent: string;
}

export default function ScriptCanvasRoute() {
  const { slug } = useParams();
  return <ScriptCanvasPage key={slug} />;
}

function ScriptCanvasPage() {
  const { slug, epId } = useParams<{ slug: string; epId?: string }>();
  const navigateRouter = useNavigate();
  // W6-redo · 条 9: view toggle 已移除, 锁定段落视图编辑
  // AI 助手默认展开，铁律 #3：信息直接可见
  const [aiPanel, setAiPanel] = useState<"ask" | "suggest">("ask");
  const [aiInput, setAiInput] = useState("");
  const [aiAnswer, setAiAnswer] = useState<string>("");
  const [aiBusy, setAiBusy] = useState(false);
  const [pending, setPending] = useState<PendingSuggestion | null>(null);
  const [planning, setPlanning] = useState(false);
  const [llmModelRef, setLlmModelRef] = useState<string | null>(null);
  // T2: 粘贴 AI 结果对话框
  const [showPasteDialog, setShowPasteDialog] = useState(false);
  // 2026-05-19: 从剧本一键生成素材对话框
  const [showExtractDialog, setShowExtractDialog] = useState(false);
  // P0-1 + InlineActionBar: 选中文字状态 (富文本编辑器模式)
  const [selectionText, setSelectionText] = useState("");
  const [selectionRect, setSelectionRect] = useState<DOMRect | null>(null);
  const { providers } = useUserProviders();
  const hasLlmKey = providers.text.some((p) => p.enabled && p.key_present);
  // 2026-07-10 Fable P0-1: 页面级确认弹窗 (重拆分镜前二次确认, 铁律 #6 数据保留)
  const confirm = useConfirm();

  const { episode, loading, error, localContent, setLocalContent, dirty, save, saving, saveError, recoveryContent, restoreRecovery, discardRecovery, reload } =
    useSeriesScript(slug || "");

  async function navigate(to: string) {
    try {
      await save();
      navigateRouter(to);
    } catch (cause) {
      showErrorToast(cause, "剧本尚未保存，请重试后再离开");
    }
  }

  // T2: 版本列表（W6-H 已切换为真实 hook）
  const { versions: rawVersions, loading: versionsLoading, activate: activateVersion, remove: deleteVersion, create: createVersion } =
    useScriptVersions(slug);

  // ScriptVersionEntry.title → VersionSummary.name 映射
  const versionSummaries = useMemo<VersionSummary[]>(
    () => rawVersions.map((v) => ({ id: v.id, name: v.title, created_at: v.created_at, is_active: v.is_active })),
    [rawVersions],
  );

  // ─── UP-3 (Y3 升级包): 剧本"自己写/粘贴" + 占位剧本不再谎称空 ──────────────────────
  // 铁律 #1 用户控制权 > 系统智能 / #5 状态精确 / #10 优雅空状态 > 强制流程.
  // (a) 空态给两条平级路: 「自己写/粘贴剧本」(解锁空编辑器, 保存即成版本) 与 「去灵感箱让 AI 扩写」.
  const [startWriting, setStartWriting] = useState(false);
  const [savingVersion, setSavingVersion] = useState(false);
  const [switchingVersion, setSwitchingVersion] = useState(false);

  // (b) 占位剧本(粘贴分镜副作用)只落进 script-versions 集合, 没回灌 series.script_md 镜像
  //     (importStoryboard 直调 createScriptVersion repo, 不走会回灌镜像的 HTTP 端点) →
  //     /script 返回空 → localContent="" → 剧本页谎称"还没有剧本", 而版本切换器已有 active 占位版本,
  //     系统与界面自相矛盾 (VERDICT UP-3 伴生 bug, 违反铁律 #5). 这里以 active 版本正文回灌编辑器,
  //     编辑器随即挂载显示占位剧本; 回灌触发既有 autosave 把镜像补齐 → 两套数据自愈一致.
  const activeVersion = useMemo(() => rawVersions.find((v) => v.is_active), [rawVersions]);
  const activeVersionContent = activeVersion?.content_md?.trim() ? activeVersion.content_md : "";
  const seededRef = useRef(false);
  // 切系列: 复位 seed 标记 + 退出手写态 (防跨系列串味)
  useEffect(() => {
    seededRef.current = false;
    setStartWriting(false);
  }, [slug]);
  useEffect(() => {
    if (loading || versionsLoading || error || recoveryContent !== null) return;
    if (seededRef.current) return;
    if (!localContent && activeVersionContent) {
      // 镜像空 + 有 active 版本正文(占位/激活) → 灌进编辑器 (一次性, 之后随用户自由编辑)
      seededRef.current = true;
      setLocalContent(activeVersionContent);
    } else if (localContent) {
      // 镜像本就有正文 → 标记已处理, 不再 seed (防用户清空后被重新灌回旧占位内容)
      seededRef.current = true;
    }
  }, [loading, versionsLoading, error, recoveryContent, localContent, activeVersionContent, setLocalContent]);

  // (a) 保存手写/粘贴剧本: 走既有 save() 落 series.script_md 镜像(刷新不丢) +
  //     createVersion() 成一个 script-versions 版本(版本切换器可见). 与 expandScript 同款"内容→版本"语义.
  async function handleSaveAsVersion() {
    const content = localContent.trim();
    if (savingVersion) return;
    if (!content) {
      toast.info("先写下或粘贴剧本内容再保存");
      return;
    }
    try {
      setSavingVersion(true);
      await save();
      const created = await createVersion({ content_md: localContent, activate: true });
      if (created) {
        toast.success("剧本已保存 — 版本切换器已新增该版本", { duration: 5000 });
        setStartWriting(false); // 退出引导写作态; localContent 非空, 编辑器继续挂载
      }
      // createVersion 失败已在 hook 内 showErrorToast, 这里不重复弹
    } catch (cause) {
      showErrorToast(cause, "剧本未保存，未创建版本");
    } finally {
      setSavingVersion(false);
    }
  }

  async function handleActivateVersion(id: string) {
    if (switchingVersion || savingVersion) return;
    try {
      setSwitchingVersion(true);
      await save();
      // Keep the current edited text as a recoverable version before replacing it.
      if (localContent.trim() && localContent !== activeVersionContent) {
        const backup = await createVersion({ content_md: localContent, activate: false, title: "切换前的剧本备份" });
        if (!backup) return;
      }
      await activateVersion(id);
      await reload();
    } catch (cause) {
      showErrorToast(cause, "尚未切换版本，当前编辑已保留");
    } finally {
      setSwitchingVersion(false);
    }
  }

  async function handleSaveNow() {
    try {
      await save();
      toast.success("剧本已保存");
    } catch (cause) {
      showErrorToast(cause, "保存未完成，文字仍保留在编辑器中");
    }
  }

  // P0-1: beforeunload dirty 兜底 — 5 秒 autosave 间隙关闭页面不丢内容
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty || saving) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty, saving]);

  const sceneCount = (localContent.match(/^##\s/gm) || []).length;
  const charCount = localContent.length;
  // audit #96: 只用台词/旁白字符估朗读时长 (排除标题/舞台指示), 弱化为"约 X 分", 不等于成片总长.
  const spokenChars = useMemo(() => estimateSpokenChars(localContent), [localContent]);
  const estSpokenMin = Math.max(1, Math.round(spokenChars / 6 / 60));

  async function handlePlan() {
    if (!slug || loading || planning) return;
    if (!localContent.trim()) {
      toast.info("先写下或粘贴剧本，再生成分集与分镜");
      return;
    }
    // 没 LLM key → toast 引导, 不锁按钮 (PRODUCT_REQUIREMENTS.md 2026-05-13)
    // P1-34 (2026-05-28 audit wave 4): 文案补全 — 用户看不出没 Key 影响哪些功能.
    if (!hasLlmKey) {
      toast.error("先连接一个文字模型，即可使用 AI 助手、拆分镜和灵感扩写", {
        duration: 6000,
        action: { label: "去设置", onClick: () => navigate("/settings") },
      });
      return;
    }
    // T4: 无条件先保存一次，确保后端拿到最新版本（铁律 #12 批改+发送一致）
    try {
      await save();
      await runPlan(false);
    } catch (cause) {
      showErrorToast(cause, "剧本未保存，尚未开始生成分镜");
    }
  }

  // 2026-07-10 Fable P0-1 — 真正发拆分镜请求的部分, 拆出来以支持 force 重发.
  // 系列已有分镜时后端返 409 (StoryboardAlreadyExists), 这里弹页面级确认门:
  // 讲清"旧分镜会整套移入分镜垃圾桶(可恢复)、已生成文件仍在归档柜", 用户确认后带 force=true 重发.
  async function runPlan(force: boolean) {
    if (!slug) return;
    setPlanning(true);
    try {
      const res = await apiPost<any>(`/api/v2/series/${slug}/plan-storyboard`, {
        overrides: llmModelRef ? { llm_provider_id: llmModelRef } : {},
        ...(force ? { force: true } : {}),
      });
      // B12: 失效系列+分集 SWR 缓存，让 StudioHome / SeriesDetail 回来时能拿到最新数据
      await invalidateSeries(slug);
      // V-1.2: 同时失效分镜 SWR 缓存
      if (epId) await invalidateShots(slug, epId);
      // 2026-05-26 walkthrough fix: 后端 LLM 失败会用 buildFallbackShotPlan 启发式拆 (返回 fallback:true) —
      // 这种情况分镜质量很差 (action 直接截灵感文字 / 角色全是 char_fallback_1 技术 id), 必须显式提示用户.
      const isFallback = Boolean(res?.fallback) ||
        (Array.isArray(res?.episodes) && res.episodes.some((e: any) => e?.fallback));
      // P0-1 边界 case③: 新计划集数比原来少时, 多出来的旧集原样保留(未被覆盖) — 如实告知.
      const leftover = Number(res?.leftover_episode_count) || 0;
      if (isFallback) {
        toast.warning("LLM 不可用 — 已按启发式拆分镜, 但质量很粗糙", {
          duration: 10000,
          description: "可在下方模型选择器换一个 LLM 后重试, 或先查看启发式结果.",
          action: {
            // 用户已明确要重抽, 直接带 force 重拆 (旧分镜同样进垃圾桶), 不再二次弹确认.
            label: "换 LLM 重抽",
            onClick: () => void runPlan(true),
          },
          cancel: {
            label: "查看分镜板",
            onClick: () => navigate(`/studio/${slug}/storyboard`),
          },
        });
      } else {
        // V-2.3: 强制跳转改 toast + action (UX 铁律 #1)
        toast.success("分集与分镜已生成", {
          duration: 6000,
          description: leftover > 0
            ? `注意: 新计划比原来少 ${leftover} 集,多出来的旧集分镜仍原样保留(未改动),可到分镜板确认或删除。`
            : undefined,
          action: {
            label: "查看分镜板",
            onClick: () => navigate(`/studio/${slug}/storyboard`),
          },
        });
      }
    } catch (err) {
      // P0-1: 已有分镜 → 后端 409 拦截. 弹页面级确认门, 确认后带 force 重发.
      if (err instanceof ApiError && err.status === 409 && err.code === "StoryboardAlreadyExists") {
        setPlanning(false); // 先收起按钮 loading, 再弹确认门
        const d = (err.details ?? {}) as {
          existing_count?: number;
          generation_count?: number;
          episode_breakdown?: Array<{ index?: number; title?: string; shot_count?: number; generation_count?: number }>;
        };
        const total = d.existing_count ?? 0;
        const gen = d.generation_count ?? 0;
        const lines = (d.episode_breakdown ?? []).map((e) => {
          const name = (e.title ?? "").trim() || `第 ${e.index ?? "?"} 集`;
          const g = e.generation_count && e.generation_count > 0 ? `,其中 ${e.generation_count} 镜已生成结果` : "";
          return `· ${name}:${e.shot_count ?? 0} 镜${g}`;
        });
        const description = [
          `当前系列已有 ${total} 个分镜${gen > 0 ? `,其中 ${gen} 镜已经生成过首帧/视频结果` : ""}。`,
          ...(lines.length > 0 ? ["", ...lines] : []),
          "",
          "重新拆分会把现有分镜整体移入「分镜垃圾桶」(可恢复) — 你之前挑选的候选、裁剪、命名会一起进垃圾桶;已生成的图片/视频文件仍然保留在归档柜。各集标题与剧本也会按新计划覆盖。",
        ].join("\n");
        const ok = await confirm({
          title: "要重新拆分现有分镜吗?",
          description,
          variant: "warning",
          confirmLabel: "移入垃圾桶并重拆",
          cancelLabel: "保留现有分镜",
        });
        if (ok) await runPlan(true);
        return;
      }
      showErrorToast(err, "分镜规划失败 — 请检查 LLM Provider Key");
    } finally {
      setPlanning(false);
    }
  }

  async function handleAsk() {
    if (!aiInput.trim() || aiBusy) return;
    try {
      setAiBusy(true);
      setAiAnswer("");
      const res = await aiAsk({
        context: localContent.slice(0, 4000),
        question: aiInput,
        scope: { kind: "script", id: "series" },
        llm_provider_id: llmModelRef ?? undefined,
      });
      if (isNotImplemented(res)) {
        showErrorToast("AI 问答功能暂不可用,请稍后再试");
        return;
      }
      setAiAnswer(res.answer);
    } catch (err) {
      showErrorToast(err, "AI 提问失败");
    } finally {
      setAiBusy(false);
    }
  }

  async function handleSuggest() {
    if (!aiInput.trim() || aiBusy) return;
    try {
      setAiBusy(true);
      const res = await aiSuggest({
        context: localContent.slice(0, 4000),
        instruction: aiInput,
        scope: { kind: "script", id: "series" },
        llm_provider_id: llmModelRef ?? undefined,
      });
      if (isNotImplemented(res)) {
        showErrorToast("AI 改写功能暂不可用,请稍后再试");
        return;
      }
      // 取第一个 patch 作为提案展示
      const first = res.patches?.[0];
      if (!first) {
        toast.info("AI 没有给出修改建议");
        return;
      }
      setPending({
        id: res.suggestion_id,
        text: first.after || "",
        reason: first.title || "",
        baseContent: localContent,
      });
    } catch (err) {
      showErrorToast(err, "AI 改写失败");
    } finally {
      setAiBusy(false);
    }
  }

  async function acceptPending() {
    if (!pending || switchingVersion || savingVersion) return;
    try {
      const editedSinceSuggestion = localContent !== pending.baseContent;
      if (editedSinceSuggestion && !await confirm({
        title: "保留新编辑后再采纳建议？",
        description: "建议生成后，你又修改了剧本。我们会先把当前内容保存为一个版本，方便随时恢复，再应用这条建议。",
        confirmLabel: "备份并采纳",
        cancelLabel: "继续编辑",
      })) return;
      setSwitchingVersion(true);
      await save();
      if (editedSinceSuggestion && localContent.trim()) {
        const backup = await createVersion({ content_md: localContent, activate: false, title: "采纳建议前的剧本备份" });
        if (!backup) return;
      }
      const res = await acceptSuggest(pending.id, undefined, slug ? { slug, episode_id: "series" } : undefined);
      if (isNotImplemented(res)) {
        showErrorToast("采纳建议功能暂不可用,请稍后再试");
        return;
      }
      // accept 后刷新 episode (后端已落库)
      await reload();
      toast.success("已采纳建议");
      setPending(null);
      setAiInput("");
    } catch (err) {
      showErrorToast(err, "采纳失败");
    } finally {
      setSwitchingVersion(false);
    }
  }

  async function rejectPending() {
    if (!pending) return;
    try {
      await rejectSuggest(pending.id);
    } catch { /* 忽略 reject 失败 — 仅本地丢弃 */ }
    setPending(null);
  }

  // P0-1 InlineActionBar: 选中文字操作 → 走 aiSuggest 通道 (跟右栏 AI 改写同管道)
  async function handleInlineAction(action: BarAction, extra?: { tone?: string; customPrompt?: string }) {
    if (!selectionText.trim() || aiBusy) return;
    const actionMap: Record<BarAction, string> = {
      rewrite: extra?.customPrompt || "改写这段内容",
      expand: "扩写这段内容，保留原意并增加细节",
      condense: "缩写这段内容，保留核心信息",
      change_tone: `把这段内容改成${extra?.tone || "中性"}语气`,
      set_dialogue: "把这段内容改成对白格式",
      set_voiceover: "把这段内容改成旁白格式",
      delete: "",
    };
    const instruction = actionMap[action];
    if (!instruction || action === "delete") {
      // 删除: 直接从 localContent 中移除选中文字
      setLocalContent(localContent.replace(selectionText, ""));
      setSelectionText("");
      setSelectionRect(null);
      return;
    }
    try {
      setAiBusy(true);
      const res = await aiSuggest({
        context: localContent.slice(0, 4000),
        instruction: `${instruction}\n\n原文片段:\n${selectionText}`,
        scope: { kind: "script", id: "series" },
        llm_provider_id: llmModelRef ?? undefined,
      });
      if (isNotImplemented(res)) {
        showErrorToast("AI 改写功能暂不可用，请稍后再试");
        return;
      }
      const first = res.patches?.[0];
      if (!first) {
        toast.info("AI 没有给出修改建议");
        return;
      }
      // 展示 AI 建议 (pending → 采纳/弃用)
      setPending({
        id: res.suggestion_id,
        text: first.after || "",
        reason: first.title || instruction,
        baseContent: localContent,
      });
    } catch (err) {
      showErrorToast(err, "AI 改写失败");
    } finally {
      setAiBusy(false);
      setSelectionText("");
      setSelectionRect(null);
    }
  }

  // 2026-07-09 audit(#11 第一性原理) — 长剧本(≥3000字)退纯文本模式时, 之前把"选中→AI改写"整块砍掉
  // (InlineActionBar 只在富文本模式渲染). 但选区改写只吃"选中的文本 + localContent 字符串", 跟 TipTap
  // 引擎无关. 这里让 Textarea 也能取选区并浮起操作条, 保住创作者在正片体量时最需要的就地改写.
  // 定位: textarea 内部选区不进 document.getSelection, 取不到真实 rect —— 用鼠标释放点(有则贴 near),
  // 键盘选区退回 textarea 顶部居中锚定 (夹到视口内, 避免贴左边缘时飘出屏幕).
  function updateTextareaSelection(ta: HTMLTextAreaElement, pointer?: { x: number; y: number }) {
    const start = ta.selectionStart ?? 0;
    const end = ta.selectionEnd ?? 0;
    const text = start !== end ? ta.value.substring(start, end) : "";
    if (text.trim()) {
      setSelectionText(text);
      const taRect = ta.getBoundingClientRect();
      setSelectionRect(
        pointer
          ? new DOMRect(pointer.x, pointer.y, 0, 0)
          : new DOMRect(taRect.left + taRect.width / 2, Math.max(taRect.top + 44, 60), 0, 0),
      );
    } else {
      setSelectionText("");
      setSelectionRect(null);
    }
  }

  // 空态卡仅在: 无正文 && 无占位/激活版本 && 用户未选择手写 && 版本列表已加载完
  // (加 !versionsLoading + !activeVersionContent 是为了防"占位版本 seed 前"闪现一下"还没有剧本"打脸)
  const scriptEmpty = !loading && !error && !versionsLoading && !localContent && !activeVersionContent && !startWriting;

  return (
    <PageTransition>
      <div className="v24-script-page" style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "var(--surface-canvas)" }}>
        {/* TopBar */}
        <div style={{ padding: "12px 28px", borderBottom: "1px solid var(--ink-100)", background: "var(--surface-card)", display: "flex", alignItems: "center", gap: 14 }}>
          {/* 2026-05-18 (铁律 #11 每个按钮都有名字): icon-only → icon + 文字 "灵感箱" */}
          <Button variant="ghost" size="sm" iconLeft="back" title="返回灵感箱" onClick={() => navigate(`/studio/${slug}/inbox`)}>
            灵感箱
          </Button>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--ink-500)", marginBottom: 1 }}>
              <span>{slug}</span><Icon name="chevRight" size={10} /><span>系列剧本</span>
            </div>
            <h1 style={{ fontSize: 17, fontWeight: 700, color: "var(--ink-900)", margin: 0, letterSpacing: "-0.01em", fontFamily: "'Noto Serif SC', serif" }}>
              {episode?.title || "系列剧本"}
            </h1>
          </div>

          {/* T2: VersionSwitcher — W6-H 已接通真实组件 */}
          <VersionSwitcher
            versions={versionSummaries}
            disabled={versionsLoading || loading || switchingVersion || savingVersion}
            onActivate={handleActivateVersion}
            onDelete={deleteVersion}
            onCreate={handleSaveAsVersion}
            label="剧本版本"
          />

          <span style={{ flex: 1 }} />
          {/* W6-redo · 条 9: 删除"段落/剧本/原文" view toggle — 它把同份数据用不同样式渲染但只有段落视图能编辑, 切换无意义 */}
          <span role="status" aria-live="polite" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--ink-500)" }}>
            {loading ? "正在载入…" : error ? "尚未载入" : saving ? (
              <><span style={{ width: 6, height: 6, borderRadius: 999, background: "var(--brand-500)" }} />保存中…</>
            ) : saveError ? (
              <><Icon name="warning" size={12} />保存未完成</>
            ) : dirty ? (
              <><span style={{ width: 6, height: 6, borderRadius: 999, background: "var(--warn)" }} />未保存</>
            ) : (
              <><span style={{ width: 6, height: 6, borderRadius: 999, background: "var(--ok)" }} />已自动保存</>
            )}
          </span>
          {!loading && !error && (dirty || saveError) && (
            <Button variant="secondary" size="sm" iconLeft="save" loading={saving} onClick={handleSaveNow}>
              {saveError ? "重试保存" : "立即保存"}
            </Button>
          )}
          {!hasLlmKey && (
            <button type="button"
              onClick={() => navigate("/settings")}
              title="点击去设置"
              style={{ display: "inline-flex", alignItems: "center", gap: 4, minHeight: 28, padding: "0 8px", border: "1px solid var(--ink-100)", borderRadius: 999, background: "var(--warn-bg)", color: "var(--warn)", fontSize: 11, cursor: "pointer" }}
            >
              <Icon name="settings" size={11} />连接文字模型
            </button>
          )}
        </div>

        {/* Body */}
        <div className="mk-scroll script-columns" style={{ flex: 1, overflow: "auto", padding: "20px 28px", display: "flex", gap: 20 }}>
          {/* Script column */}
          <div className="script-editor-column" style={{ flex: 1, minWidth: 0, maxWidth: 800, display: "flex", flexDirection: "column", gap: 14 }}>
            {recoveryContent !== null && (
              <div role="status" className="mk-card" style={{ padding: "14px 16px", background: "var(--brand-50)", borderColor: "var(--brand-200)" }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>找到此标签页尚未保存的剧本草稿</div>
                <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--ink-600)", lineHeight: 1.6 }}>下面显示的是已保存的剧本。你可以恢复草稿继续编辑，或保留当前版本。</p>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Button variant="primary" size="sm" iconLeft="refresh" onClick={() => { restoreRecovery(); setStartWriting(true); }}>恢复草稿</Button>
                  <Button variant="secondary" size="sm" iconLeft="check" onClick={discardRecovery}>保留已保存版本</Button>
                </div>
              </div>
            )}
            {saveError && (
              <div role="alert" className="mk-card" style={{ padding: "12px 16px", background: "var(--warn-bg)", borderColor: "var(--warn)" }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>文字仍保留在编辑器中，请先完成保存</div>
                <div style={{ fontSize: 12, color: "var(--ink-600)", lineHeight: 1.6 }}>{saveError}。可点击上方「重试保存」，保存成功前请保留此页面。</div>
              </div>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", background: "var(--surface-card)", border: "1px solid var(--ink-100)", borderRadius: "var(--r-lg)" }}>
              <span style={{ fontSize: 12, color: "var(--ink-600)" }}>{sceneCount} 个场景</span>
              <span style={{ width: 4, height: 4, borderRadius: 999, background: "var(--ink-200)" }} />
              <span
                style={{ fontSize: 12, color: "var(--ink-600)" }}
                title="按台词 / 旁白字符估算的朗读时长 (不含场景标题、舞台指示), 仅供参考, 不等于成片总长"
              >约 {estSpokenMin} 分<span style={{ color: "var(--ink-400)", marginLeft: 2 }}>（按台词估）</span></span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 11, color: "var(--ink-400)" }}>{charCount} 字</span>
              {/* P0-1: 富文本/纯文本模式指示 (条件渲染) */}
              {!loading && !error && localContent && (
                <span style={{
                  display: "inline-flex", alignItems: "center", gap: 3,
                  height: 18, padding: "0 7px", borderRadius: 9,
                  fontSize: 10, fontWeight: 600,
                  background: charCount < RICH_TEXT_CHAR_LIMIT ? "var(--brand-50)" : "var(--ink-50)",
                  color: charCount < RICH_TEXT_CHAR_LIMIT ? "var(--brand-700)" : "var(--ink-500)",
                  border: `1px solid ${charCount < RICH_TEXT_CHAR_LIMIT ? "var(--brand-200)" : "var(--ink-150)"}`,
                }}>
                  <Icon name={charCount < RICH_TEXT_CHAR_LIMIT ? "sparkles" : "edit"} size={10} />
                  {charCount < RICH_TEXT_CHAR_LIMIT ? "富文本" : "纯文本"}
                </span>
              )}
            </div>

            {loading && (
              <div className="mk-card" style={{ padding: 60, textAlign: "center", color: "var(--ink-400)" }}>
                <Icon name="refresh" size={20} />
                <div style={{ marginTop: 8 }}>加载剧本中…</div>
              </div>
            )}

            {error && (
              <div className="mk-card" style={{ padding: 24, color: "var(--err)" }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>加载失败</div>
                <div style={{ fontSize: 12 }}>{error}</div>
                <Button variant="secondary" size="sm" iconLeft="refresh" style={{ marginTop: 10 }} onClick={() => reload()}>重试</Button>
              </div>
            )}

            {/* 空状态 — 两条平级路, 不强制跳转（铁律 #1 用户控制权 / #10 优雅空状态）:
                「自己写/粘贴剧本」直接展开既有编辑器(保存即成版本) · 「去灵感箱让 AI 扩写」.
                两按钮均图标+文字(铁律 #11), 复用该页既有 primary/secondary 按钮体系(铁律 #8). */}
            {scriptEmpty && (
              <div className="mk-card" style={{ padding: 56, textAlign: "center", color: "var(--ink-500)" }}>
                <div style={{ fontSize: 40, marginBottom: 16, opacity: 0.25 }}>✍️</div>
                <div style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 20, fontWeight: 600, color: "var(--ink-800)", marginBottom: 10 }}>
                  还没有剧本
                </div>
                <div style={{ fontSize: 13.5, color: "var(--ink-500)", lineHeight: 1.7, marginBottom: 22, maxWidth: 340, margin: "0 auto 22px" }}>
                  你可以自己写 / 粘贴一份剧本，也可以去灵感箱让 AI 帮你扩写成剧本
                </div>
                <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
                  <Button variant="primary" iconLeft="edit" onClick={() => setStartWriting(true)}>
                    自己写 / 粘贴剧本
                  </Button>
                  <Button variant="secondary" iconLeft="inbox" onClick={() => navigate(`/studio/${slug}/inbox`)}>
                    去灵感箱让 AI 扩写
                  </Button>
                </div>
              </div>
            )}

            {/* P0-1: 条件渲染 — < 3000 字用 TipTap 富文本 (Final Draft 级体验), >= 3000 用 Textarea (防卡顿).
                Y3(UP-3): 渲染闸从 localContent 放宽为 (localContent || startWriting || activeVersionContent) —
                用户选择"自己写"时可挂载空编辑器; 占位剧本(active 版本有正文)时也挂载(seed 前不留空窗). */}
            {!loading && !error && (localContent || startWriting || activeVersionContent) && (
              <div className="mk-card" style={{ padding: "16px 20px", background: "var(--surface-card)", position: "relative" }}>
                {/* Y3(UP-3 a): 手写态头部 — 保存为剧本版本(走 save()+createVersion(), 版本切换器可见) + 取消返回空态.
                    图标+文字(铁律 #11), primary/ghost 复用既有按钮体系(铁律 #8). */}
                {startWriting && (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, paddingBottom: 12, borderBottom: "1px solid var(--ink-100)", flexWrap: "wrap" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, color: "var(--ink-800)" }}>
                      <Icon name="edit" size={14} style={{ color: "var(--brand-600)" }} />
                      自己写 / 粘贴剧本
                    </span>
                    <span style={{ fontSize: 11.5, color: "var(--ink-400)" }}>直接输入或粘贴，保存后成为一个剧本版本</span>
                    <span style={{ flex: 1 }} />
                    <Button variant="ghost" size="sm" iconLeft="back" onClick={() => setStartWriting(false)}>
                      取消
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      iconLeft="save"
                      loading={savingVersion}
                      disabled={savingVersion || !localContent.trim()}
                      title={!localContent.trim() ? "先写下或粘贴剧本内容再保存" : "保存为一个剧本版本"}
                      onClick={handleSaveAsVersion}
                    >
                      保存为剧本版本
                    </Button>
                  </div>
                )}
                {charCount < RICH_TEXT_CHAR_LIMIT ? (
                  <Suspense fallback={<div role="status">正在载入剧本编辑器…</div>}>
                  <ScriptCanvas
                    content={plainTextToHtml(localContent)}
                    onChange={(html) => {
                      // HTML → 纯文本: 去标签保留内容。
                      // 2026-06-01 收尾修: 反向必须跟 plainTextToHtml 对称, 否则富文本编辑一次就静默改坏结构 +
                      // 破坏 round-trip 幂等致光标跳。① 标题保留层级(原来 h1/h2/h3 全压成 ## 丢层级);
                      // ② 空行段落保留(原来 <p><br></p> 被删, 致所有空行被吞)。
                      setLocalContent(htmlToPlainText(html));
                    }}
                    onSelectionChange={(text, range) => {
                      setSelectionText(text);
                      if (text && range) {
                        // 计算选区视口位置 → 给 InlineActionBar 定位
                        try {
                          const sel = window.getSelection();
                          if (sel && sel.rangeCount > 0) {
                            setSelectionRect(sel.getRangeAt(0).getBoundingClientRect());
                          }
                        } catch { setSelectionRect(null); }
                      } else {
                        setSelectionRect(null);
                      }
                    }}
                    editable={!switchingVersion && !savingVersion}
                    projectSlug={slug ?? undefined}
                  />
                  </Suspense>
                ) : (
                  // audit #11: 纯文本(长剧本)模式也挂选区监听 — 鼠标释放 / 键盘选取都回填 selectionText,
                  // 让下方 InlineActionBar 照常浮起, 选中改写不再随富文本模式一起丢失.
                  <Textarea
                    value={localContent}
                    disabled={switchingVersion || savingVersion}
                    onChange={(e) => setLocalContent(e.target.value)}
                    onMouseUp={(e) => updateTextareaSelection(e.currentTarget, { x: e.clientX, y: e.clientY })}
                    onKeyUp={(e) => updateTextareaSelection(e.currentTarget)}
                    rows={20}
                    placeholder="写下或粘贴完整剧本。可以直接写 @角色名 / @场景名 引用素材(LLM 拆分镜时自动识别)"
                    className="min-h-[480px] font-serif text-[15px] leading-[1.85] text-[var(--ink-900)]"
                    style={{ border: "none", background: "transparent" }}
                  />
                )}
                {/* 选中文字浮起操作条 (Notion / Canvas 风格) — 富文本 + 纯文本(长剧本)两种模式都可用.
                    audit #11: 长剧本恰是最需要"选中一段让 AI 改写"的时候, 之前在此时被整块砍掉, 现补回;
                    left 夹到视口内, 防纯文本模式鼠标贴左/右边缘时操作条飘出屏幕. */}
                <InlineActionBar
                  visible={!!selectionText && !!selectionRect}
                  selectedText={selectionText}
                  seriesSlug={slug ?? undefined}
                  contextText={localContent.slice(0, 4000)}
                  llmModelRef={llmModelRef}
                  onAction={handleInlineAction}
                  onClose={() => { setSelectionText(""); setSelectionRect(null); }}
                  style={selectionRect ? {
                    position: "fixed",
                    left: Math.max(8, Math.min(
                      selectionRect.left + selectionRect.width / 2 - 180,
                      (typeof window !== "undefined" ? window.innerWidth : 1280) - 480,
                    )),
                    top: selectionRect.top - 44,
                    zIndex: 100,
                  } : undefined}
                />
                <div style={{ marginTop: 8, fontSize: 11, color: "var(--ink-400)" }}>
                  {charCount < RICH_TEXT_CHAR_LIMIT
                    ? "富文本模式：情绪高亮 · 角色补全 · @mention · 选中文字可改写。自动保存每 5 秒。"
                    : "剧本较长，已切换纯文本模式（防卡顿）：选中文字仍可 AI 改写 / 扩写 / 缩写；暂不显示情绪高亮、@角色 高亮与角色补全。要整篇级修改可用右侧「AI 助手」。自动保存每 5 秒。"}
                </div>
              </div>
            )}
          </div>

          {/* Right rail */}
          <div className="script-assistant-column" style={{ width: 300, display: "flex", flexDirection: "column", gap: 14, flexShrink: 0 }}>
            {/* AI 助手默认展开（铁律 #3 信息直接可见，铁律 #11 每个按钮都有名字） */}
            <div className="mk-card" style={{ padding: 14 }}>
                {/* 2026-05-26 fix: 原 tab 跟标题挤一行在 300px 右栏会溢出.
                    拆成: 标题独占一行, tab 切换器独占下一行 (block 撑满, 两个 tab 各 50%). */}
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                  <Icon name="sparkles" size={13} style={{ color: "var(--brand-600)" }} />
                  <span style={{ fontSize: 12, fontWeight: 600 }}>AI 助手</span>
                </div>
                <div style={{ display: "flex", padding: 2, background: "var(--ink-50)", borderRadius: "var(--r-sm)", gap: 2, marginBottom: 10 }}>
                  {(["ask", "suggest"] as const).map((k) => (
                    <button
                      key={k}
                      onClick={() => setAiPanel(k)}
                      style={{
                        flex: 1,
                        height: 26, padding: "0 8px",
                        background: aiPanel === k ? "var(--surface-card)" : "transparent",
                        border: "none", fontSize: 11.5,
                        fontWeight: aiPanel === k ? 600 : 500,
                        color: aiPanel === k ? "var(--ink-900)" : "var(--ink-500)",
                        borderRadius: "var(--r-xs)", cursor: "pointer",
                        boxShadow: aiPanel === k ? "0 1px 2px rgba(0,0,0,0.04)" : "none",
                      }}
                    >
                      {k === "ask" ? "问问题" : "AI 改写"}
                    </button>
                  ))}
                </div>

                {/* 2026-05-18: ChatGPT 风格 ComposeBox kind="text" 替代原 textarea + ModelPicker + 提交按钮.
                    AI 助手 ask/suggest 两 mode 由顶部 tab 切换, ComposeBox.onDraw 根据当前 mode 路由.
                    Cmd+Enter 提交, 不点 ModelPicker 走系列默认 LLM. */}
                <ComposeBox
                  kind="text"
                  slug={slug ?? "_default"}
                  value={aiInput}
                  onChange={setAiInput}
                  modelRef={llmModelRef}
                  onModelChange={setLlmModelRef}
                  count={1}
                  onCountChange={() => { /* text 不抽 N 份 */ }}
                  busy={aiBusy}
                  busyLabel="思考中..."
                  onDraw={() => void (aiPanel === "ask" ? handleAsk() : handleSuggest())}
                  placeholder={aiPanel === "ask" ? "对剧本提个问题…Ctrl/Cmd + Enter 提问" : "告诉 AI 想怎么改…Ctrl/Cmd + Enter 生成建议"}
                  drawLabel={aiPanel === "ask" ? "提问" : "生成建议"}
                  countPresets={[]}
                />

                {/* 2026-07-09 audit C9: ComposeBox 2026-05-27 重构后不再内嵌预览按钮, 旧的 off-screen
                    ref-click 技巧 (onPreviewPrompt + left:-9999 隐藏) 永不触发 → "查看提示词" 不可点
                    (违反铁律 #2 可干预性). 真实按钮内联渲染进 AI 助手卡片, 紧邻"提问/生成建议". */}
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
                  <PromptReviewButton
                    size="sm"
                    label="查看提示词"
                    disabled={!aiInput.trim() || aiBusy}
                    loadPrompt={async (): Promise<PromptPreview> => {
                      const r = await apiPost<PromptPreview>(
                        `/api/v2/series/${encodeURIComponent(slug ?? "_default")}/preview-ai-chat-prompt`,
                        {
                          context: localContent.slice(0, 4000),
                          ...(aiPanel === "ask" ? { question: aiInput } : { instruction: aiInput }),
                          scope: { kind: "script", id: "series" },
                          llm_provider_id: llmModelRef ?? undefined,
                        },
                      );
                      return r;
                    }}
                  />
                </div>

                {aiPanel === "ask" && aiAnswer && (
                  <div style={{ marginTop: 10, padding: 10, borderRadius: 6, background: "var(--ink-50)", fontSize: 12, lineHeight: 1.6, color: "var(--ink-800)", whiteSpace: "pre-wrap" }}>
                    {aiAnswer}
                  </div>
                )}

                {pending && (
                  <div style={{ marginTop: 10, padding: 10, borderRadius: 6, border: "1px solid var(--brand-200)", background: "var(--brand-50)" }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "var(--brand-700)", marginBottom: 6 }}>
                      AI 提议 — 待你确认
                    </div>
                    {pending.reason && (
                      <div style={{ fontSize: 11, color: "var(--ink-500)", marginBottom: 6 }}>{pending.reason}</div>
                    )}
                    <div style={{ fontSize: 12, lineHeight: 1.55, color: "var(--ink-800)", maxHeight: 180, overflow: "auto", marginBottom: 8, whiteSpace: "pre-wrap" }}>
                      {pending.text}
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <Button variant="primary" size="xs" iconLeft="check" onClick={acceptPending}>
                        采纳
                      </Button>
                      <Button variant="ghost" size="xs" onClick={rejectPending}>
                        弃用
                      </Button>
                    </div>
                  </div>
                )}
              </div>

            {/* 2026-05-19: 一键从剧本分析需要的素材 — 在主"生成分镜"按钮之前先建素材库 */}
            <div className="mk-card" style={{ padding: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "var(--ink-800)", paddingBottom: 6, borderBottom: "1px solid var(--ink-50)", marginBottom: 8 }}>
                <Icon name="sparkles" size={12} style={{ color: "var(--brand-600)" }} />
                素材分析
              </div>
              <div style={{ fontSize: 11.5, color: "var(--ink-600)", lineHeight: 1.6, marginBottom: 8 }}>
                让 AI 读完剧本, 自动分析需要的角色 / 场景 / 物品, 一键创建素材库 (跳过同名)
              </div>
              <Button
                variant="primary"
                size="sm"
                iconLeft="sparkles"
                block
                disabled={!localContent || !slug}
                title={!localContent ? "先写剧本再分析" : "AI 分析剧本生成所需素材"}
                onClick={() => setShowExtractDialog(true)}
              >
                AI 分析需要的素材
              </Button>
            </div>

            {/* P1-2: 续写按钮组 — 快速让 AI 延伸剧本 (NovelAI / Sudowrite 同款) */}
            <div className="mk-card" style={{ padding: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "var(--ink-800)", paddingBottom: 6, borderBottom: "1px solid var(--ink-50)", marginBottom: 8 }}>
                <Icon name="pen" size={12} style={{ color: "var(--brand-600)" }} />
                快速续写
              </div>
              <div style={{ fontSize: 11.5, color: "var(--ink-600)", lineHeight: 1.6, marginBottom: 10 }}>
                AI 基于当前剧本文末自动续写。续写结果作为建议预览，你确认后才采纳。
              </div>
              {[
                { label: "续写 200 字", icon: "edit" as const, prompt: "接着当前剧本续写大约 200 字，保持风格和人物语气一致" },
                { label: "续写 1 段", icon: "doc" as const, prompt: "接着当前剧本文末续写一个完整段落（约 100-150 字），推进剧情" },
                { label: "接下来发生什么", icon: "sparkles" as const, prompt: "根据当前剧本内容，续写接下来的剧情发展（约 200 字），保持叙事张力" },
              ].map((item) => (
                <Button
                  key={item.label}
                  variant="ghost"
                  size="sm"
                  iconLeft={item.icon}
                  block
                  disabled={!localContent || aiBusy}
                  title={!localContent ? "先写剧本再续写" : item.prompt}
                  style={{ marginBottom: 4, justifyContent: "flex-start" }}
                  onClick={async () => {
                    if (!localContent.trim() || aiBusy) return;
                    try {
                      setAiBusy(true);
                      const tail = localContent.slice(-2000);
                      const res = await aiSuggest({
                        context: tail,
                        instruction: item.prompt,
                        scope: { kind: "script", id: "series" },
                        llm_provider_id: llmModelRef ?? undefined,
                      });
                      if (isNotImplemented(res)) {
                        showErrorToast("AI 续写功能暂不可用，请稍后再试");
                        return;
                      }
                      const first = res.patches?.[0];
                      if (!first) {
                        toast.info("AI 没有给出续写内容");
                        return;
                      }
                      setPending({
                        id: res.suggestion_id,
                        text: first.after || "",
                        reason: `续写建议 — ${item.label}`,
                        baseContent: localContent,
                      });
                    } catch (err) {
                      showErrorToast(err, "AI 续写失败");
                    } finally {
                      setAiBusy(false);
                    }
                  }}
                >
                  {item.label}
                </Button>
              ))}
            </div>

            {/* 下一步：模型选择器就近贴在生成按钮旁（铁律 #4 就近决策） */}
            <div className="mk-card" style={{ padding: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "var(--ink-800)", paddingBottom: 6, borderBottom: "1px solid var(--ink-50)", marginBottom: 8 }}>
                <Icon name="bolt" size={12} />
                下一步
              </div>
              <div style={{ fontSize: 11.5, color: "var(--ink-600)", lineHeight: 1.6, marginBottom: 8 }}>
                剧本审定后, 点击 "生成分集与分镜", LLM 会先拆出分集, 再为每一集生成镜头、prompt、时长和角色锚点
              </div>
              {/* 模型选择器就近放在生成按钮左侧，铁律 #4 */}
              <div style={{ marginBottom: 8 }}>
                <ModelPicker kind="text" value={llmModelRef} onChange={setLlmModelRef} size="sm" placeholder="默认文字模型" />
              </div>
              {/* 2026-05-18 (铁律 #2 可干预性): 主链路 LLM 调用 — 发送前查看 plan-storyboard 完整提示词. */}
              <div style={{ marginBottom: 8 }}>
                <PromptReviewButton
                  size="sm"
                  label="查看完整提示词"
                  disabled={planning || !localContent || !slug}
                  loadPrompt={async (): Promise<PromptPreview> => {
                    const r = await apiPost<PromptPreview>(
                      `/api/v2/series/${encodeURIComponent(slug ?? "_default")}/preview-storyboard-prompt`,
                      {
                        script: localContent,
                        overrides: llmModelRef ? { llm_provider_id: llmModelRef } : {},
                      },
                    );
                    return r;
                  }}
                />
              </div>
              {/* 原有生成按钮 — 保留 */}
              <Button
                variant="primary"
                size="sm"
                iconRight="arrowRight"
                block
                loading={planning}
                disabled={planning || !localContent}
                title={!hasLlmKey ? "请先在设置里填 LLM API Key" : `用 ${llmModelRef ?? "默认文字模型"} 生成分集与分镜`}
                style={{ marginBottom: 8 }}
                onClick={handlePlan}
              >
                {planning ? "AI 规划中…" : "生成分集与分镜"}
              </Button>
              {/* T2: 粘贴 AI 结果按钮（额外新增，不替换上面的生成按钮） */}
              <Button
                variant="ghost"
                size="sm"
                iconLeft="doc"
                block
                title="把在其它 AI 生成的分镜 JSON 粘贴进来"
                onClick={() => setShowPasteDialog(true)}
              >
                我自己粘贴 AI 结果
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* T2: 粘贴 AI 结果导入分镜对话框 */}
      {showPasteDialog && slug && (
        <PasteStoryboardDialog
          slug={slug}
          onClose={() => setShowPasteDialog(false)}
          onImported={() => setShowPasteDialog(false)}
        />
      )}

      {/* 2026-05-19: 从剧本一键生成素材 — 完成后引导跳到素材库看新建素材 */}
      {slug && (
        <ExtractFromScriptDialog
          slug={slug}
          open={showExtractDialog}
          onClose={() => setShowExtractDialog(false)}
          onExtracted={(info) => {
            const totalAdded = info.added.characters + info.added.scenes + info.added.props;
            if (totalAdded > 0) {
              toast.success(`已为你创建 ${totalAdded} 个素材`, {
                action: {
                  label: "前往素材库 →",
                  onClick: () => navigate(`/studio/${slug}/elements`),
                },
                duration: 8000,
              });
            }
          }}
        />
      )}
    </PageTransition>
  );
}
