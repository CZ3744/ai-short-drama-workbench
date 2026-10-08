/**
 * BatchSeriesDialog — 一站式批量 AI 生成系列 (2026-05-19 反馈 #9 + 多剧扩展).
 *
 * 用户原话 (2026-05-19 后续):
 * > "批量生成项目里的参数为什么没有项目数?我可以同时要求生成多部不同的剧、
 * >  每剧不同的集数,想想怎么管理和添加上"
 *
 * 设计原则覆盖:
 *   - 铁律 #1 用户控制权: 不强制跳转, 取消可关闭
 *   - 铁律 #2 可干预性: "复制完整提示词" 按钮 + 外部导入 fallback
 *   - 铁律 #3 信息直接可见: 项目列表 + 集数永远可见, 高级参数折叠
 *   - 铁律 #4 就近决策: ModelPicker kind="text" 紧贴在 Dialog 顶部
 *   - 铁律 #11 按钮都有名字: icon + 文字 label, 不允许 icon-only
 *
 * 后端契约:
 *   - POST /api/v2/series/batch-generate
 *     body: { projects: [...], global?: {...}, model_ref?: string } → 多项目模式
 *   - POST /api/v2/series/batch-generate/preview-prompt → 零成本返完整 prompt
 *
 * Wave Z-8: 拆子组件 ProjectCard / GlobalDefaultsPanel / AutoRunPanel / batchStats.
 */

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Icon } from "../../shared/Icon";
import { ModelPicker } from "../ModelPicker";
import { PasteStoryboardDialog } from "../../script/PasteStoryboardDialog";
import { PromptReviewButton } from "../../shared/PromptReviewButton";
import { BatchImportMultiDialog } from "../BatchImportMultiDialog";
import { apiPost } from "../../../lib/api";
import { showErrorToast } from "../../../lib/errorTranslate";
import { useAsyncAction } from "../../../hooks/useAsyncAction";
import { BaseDialog } from "../../ui/BaseDialog";
import { Button } from "../../ui/button";
import { Textarea } from "../../ui/textarea";
import { getLastUsedSeriesDefaults, rememberLastUsedSeriesDefaults } from "../../../lib/lastUsedSeriesDefaults";
// 优化 1 (2026-05-19): 批量创建后一键继续跑全集
import { startAutoPipelineBatch } from "../../../lib/autoPipelineApi";
import { TitleConflictHint } from "../TitleConflictHint";
import { ProjectCard } from "./ProjectCard";
import { GlobalDefaultsPanel } from "./GlobalDefaultsPanel";
import { AutoRunPanel } from "./AutoRunPanel";
import { computeBatchStats, type ProjectSlot, type GlobalDefaults } from "./batchStats";

export interface BatchSeriesDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated?: (info: { series_slug: string; series_title: string; episodes_created: number }) => void;
  /** 2026-05-21 — 已有系列 title 列表 (重名检查, 跟其他 dialog 一致) */
  existingTitles?: string[];
}

interface MultiProjectResponse {
  ok: true;
  mode: "multi";
  projects_created: number;
  series: Array<{
    series_slug: string;
    series_title: string;
    episodes_created: number;
    total_shots: number;
  }>;
  total_episodes: number;
  total_shots: number;
  series_slugs: string[];
  prompt_used: string;
  duration_ms: number;
}

interface SingleResponse {
  ok: true;
  series_slug: string;
  series_title: string;
  episodes_created: number;
  total_shots: number;
}

type BatchGenerateResponse = MultiProjectResponse | SingleResponse;

interface PreviewPromptResponse {
  prompt: string;
}

function newProjectSlot(): ProjectSlot {
  return {
    id:
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    series_title: "",
    inspiration: "",
    episode_count: "",
    duration_per_episode_sec: "",
    aspect_ratio: "",
    style: "",
    platform: "",
    advancedOpen: false,
  };
}

function cloneProjectSlot(src: ProjectSlot): ProjectSlot {
  return {
    ...newProjectSlot(),
    series_title: src.series_title,
    inspiration: src.inspiration,
    episode_count: src.episode_count,
    duration_per_episode_sec: src.duration_per_episode_sec,
    aspect_ratio: src.aspect_ratio,
    style: src.style,
    platform: src.platform,
  };
}

export function BatchSeriesDialog({ open, onClose, onCreated, existingTitles = [] }: BatchSeriesDialogProps) {
  const navigate = useNavigate();
  const [showPasteFallback, setShowPasteFallback] = useState(false);
  const [createdSlug, setCreatedSlug] = useState<string | null>(null);
  const [showImportMulti, setShowImportMulti] = useState(false);

  // 多项目状态
  const [projects, setProjects] = useState<ProjectSlot[]>([newProjectSlot()]);

  // 2026-05-19: "目标剧集数量" Input — 顶部一行让用户写数字, 自动同步下方项目卡片数.
  const [targetProjectCount, setTargetProjectCount] = useState(1);

  // 全局默认参数
  const [globalDefaults, setGlobalDefaults] = useState<GlobalDefaults>({
    aspect_ratio: "",
    platform: "",
    style: "",
    duration_per_episode_sec: "",
  });

  // 全局灵感总指示
  const [globalInspiration, setGlobalInspiration] = useState("");

  const [modelRef, setModelRef] = useState<string | null>(null);

  // ─── 优化 1 (2026-05-19): 创建完后一键继续跑 ep01 ─────────────────
  const [autoRunAfterCreate, setAutoRunAfterCreate] = useState(false);
  const [autoRunMode, setAutoRunMode] = useState<"only_firstframes" | "only_element_images" | "full">("only_firstframes");
  const [autoRunImageRef, setAutoRunImageRef] = useState<string | null>(null);
  const [autoRunVideoRef, setAutoRunVideoRef] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // 打开时从 localStorage 读上次用的参数做 prefill
      const saved = getLastUsedSeriesDefaults();
      if (saved.aspect_ratio || saved.platform || saved.style || saved.duration_per_episode_sec) {
        setGlobalDefaults((prev) => ({
          ...prev,
          aspect_ratio: saved.aspect_ratio ?? prev.aspect_ratio,
          platform: saved.platform ?? prev.platform,
          style: saved.style ?? prev.style,
          duration_per_episode_sec: saved.duration_per_episode_sec
            ? String(saved.duration_per_episode_sec)
            : prev.duration_per_episode_sec,
        }));
      }
    } else {
      // 关闭时重置 (不重置 modelRef 用户偏好, 由 ModelPicker 内置 rememberLastUsed)
      setShowPasteFallback(false);
      setCreatedSlug(null);
      setShowImportMulti(false);
    }
  }, [open]);

  // 2026-05-19: 给"添加项目 / 复制 / 删除"作 fallback 同步
  useEffect(() => {
    if (projects.length !== targetProjectCount) {
      setTargetProjectCount(projects.length);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects.length]);

  // 计算预估总集数 (顶部统计用) — 使用抽离到 batchStats 的纯函数
  const stats = useMemo(() => computeBatchStats(projects), [projects]);

  const generateAction = useAsyncAction(
    async () =>
      apiPost<BatchGenerateResponse>("/api/v2/series/batch-generate", buildPayload()),
    { errorMessage: "批量生成失败" },
  );
  const busy = generateAction.busy;

  if (!open) return null;

  function updateProject(id: string, patch: Partial<ProjectSlot>) {
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  function addProject() {
    setProjects((prev) => {
      const next = [...prev, newProjectSlot()];
      setTargetProjectCount(next.length);
      return next;
    });
  }

  function duplicateLastProject() {
    setProjects((prev) => {
      const last = prev[prev.length - 1];
      if (!last) {
        const fresh = [newProjectSlot()];
        setTargetProjectCount(fresh.length);
        return fresh;
      }
      const next = [...prev, cloneProjectSlot(last)];
      setTargetProjectCount(next.length);
      return next;
    });
  }

  function removeProject(id: string) {
    setProjects((prev) => {
      if (prev.length <= 1) {
        toast.message("至少保留 1 个项目", { description: "如要取消批量,请用顶部关闭按钮" });
        return prev;
      }
      const next = prev.filter((p) => p.id !== id);
      setTargetProjectCount(next.length);
      return next;
    });
  }

  /**
   * 让"目标剧集数量" Input 与项目卡片数量双向同步.
   * - 输入 N > 当前项目数: 复制末尾参数自动 add N - current 个新项目卡片
   * - 输入 N < 当前项目数: 截断到 N
   * - 入参 clamp 到 [1, 10]
   */
  function handleTargetCountChange(raw: string) {
    const parsed = parseInt(raw, 10);
    const n = Math.max(1, Math.min(10, Number.isFinite(parsed) ? parsed : 1));
    setTargetProjectCount(n);
    setProjects((prev) => {
      if (n === prev.length) return prev;
      if (n > prev.length) {
        const seed = prev[prev.length - 1] ?? newProjectSlot();
        const toAdd = Array.from({ length: n - prev.length }, () => cloneProjectSlot(seed));
        return [...prev, ...toAdd];
      }
      return prev.slice(0, n);
    });
  }

  /** Build multi-project payload — 永远走 multi schema (后端兼容 single) */
  function buildPayload() {
    const gpayload: Record<string, unknown> = {};
    if (globalDefaults.aspect_ratio) gpayload.aspect_ratio = globalDefaults.aspect_ratio;
    if (globalDefaults.platform) gpayload.platform = globalDefaults.platform;
    if (globalDefaults.style.trim()) gpayload.style = globalDefaults.style.trim();
    const gd = parseInt(globalDefaults.duration_per_episode_sec, 10);
    if (Number.isFinite(gd) && gd > 0) gpayload.duration_per_episode_sec = gd;

    const projectsPayload = projects.map((p) => {
      const item: Record<string, unknown> = {};
      if (p.series_title.trim()) item.series_title = p.series_title.trim();
      if (p.inspiration.trim()) item.inspiration = p.inspiration.trim();
      const ec = parseInt(p.episode_count, 10);
      if (Number.isFinite(ec) && ec > 0) item.episode_count = ec;
      const ds = parseInt(p.duration_per_episode_sec, 10);
      if (Number.isFinite(ds) && ds > 0) item.duration_per_episode_sec = ds;
      if (p.aspect_ratio) item.aspect_ratio = p.aspect_ratio;
      if (p.style.trim()) item.style = p.style.trim();
      if (p.platform) item.platform = p.platform;
      return item;
    });

    const payload: Record<string, unknown> = { projects: projectsPayload };
    if (Object.keys(gpayload).length > 0) payload.global = gpayload;
    if (globalInspiration.trim()) payload.global_inspiration = globalInspiration.trim();
    if (modelRef) payload.model_ref = modelRef;
    return payload;
  }

  async function handleGenerate() {
    const result = await generateAction.run();
    if (!result) return;

    // 生成成功 → 记忆本次 globalDefaults 供下次 prefill
    const gd = parseInt(globalDefaults.duration_per_episode_sec, 10);
    rememberLastUsedSeriesDefaults({
      aspect_ratio: globalDefaults.aspect_ratio || undefined,
      platform: globalDefaults.platform || undefined,
      style: globalDefaults.style.trim() || undefined,
      duration_per_episode_sec: Number.isFinite(gd) && gd > 0 ? gd : undefined,
    });

    // 多项目模式响应
    if ("mode" in result && result.mode === "multi") {
      toast.success(
        `已生成 ${result.projects_created} 部剧 · 共 ${result.total_episodes} 集, ${result.total_shots} 个分镜`,
      );
      setCreatedSlug(result.series_slugs[0] ?? null);
      if (onCreated && result.series.length > 0) {
        const first = result.series[0];
        onCreated({
          series_slug: first.series_slug,
          series_title: first.series_title,
          episodes_created: first.episodes_created,
        });
      }

      // 优化 1 (2026-05-19): 用户勾了"创建完成后立即跑全集" → 串行启动 N 个 pipeline.
      if (autoRunAfterCreate && result.series.length > 0) {
        try {
          const seriesEpisodes = result.series.map((s) => ({
            slug: s.series_slug,
            ep_id: "ep01",
          }));
          const options: Record<string, unknown> = {};
          if (autoRunMode === "only_firstframes") options.only_firstframes = true;
          else if (autoRunMode === "only_element_images") options.only_element_images = true;
          if (autoRunImageRef) options.image_provider_id = autoRunImageRef;
          if (autoRunMode === "full" && autoRunVideoRef) options.video_provider_id = autoRunVideoRef;

          const batchResp = await startAutoPipelineBatch({
            series_episodes: seriesEpisodes,
            options,
          });
          const modeLabel =
            autoRunMode === "only_firstframes" ? "只抽首帧"
            : autoRunMode === "only_element_images" ? "只补素材图"
            : "全流程 (首帧+视频+合成)";
          if (batchResp.errors.length > 0) {
            toast.warning(
              `已为 ${batchResp.total_started}/${batchResp.total_requested} 部启动 ${modeLabel}, ${batchResp.errors.length} 部失败`,
              {
                description: batchResp.errors.slice(0, 3).map((e) => `${e.slug}: ${e.reason}`).join("; "),
              },
            );
          } else {
            toast.success(`已为 ${batchResp.total_started} 部剧启动 ${modeLabel}, 可在每剧的合成页看进度`);
          }
        } catch (err) {
          showErrorToast(err, "批量启动 pipeline 失败 (剧已创建, 可去每剧手动启动)");
        }
      }

      // 跳到 StudioHome 让用户看到 N 部新剧
      navigate("/studio");
      onClose();
      return;
    }

    // single 模式响应 (兼容路径)
    const single = result as SingleResponse;
    setCreatedSlug(single.series_slug);
    onCreated?.({
      series_slug: single.series_slug,
      series_title: single.series_title,
      episodes_created: single.episodes_created,
    });
    toast.success(
      `已生成「${single.series_title}」: ${single.episodes_created} 集, 共 ${single.total_shots} 个分镜`,
      {
        duration: 8000,
        action: {
          label: "查看项目",
          onClick: () => navigate(`/studio/${encodeURIComponent(single.series_slug)}/inbox`),
        },
      },
    );
    onClose();
  }

  // 当 PasteStoryboardDialog 完成导入时, 不需要 createdSlug — 它内部已 navigate.
  if (showPasteFallback && createdSlug) {
    return (
      <PasteStoryboardDialog
        slug={createdSlug}
        onClose={() => setShowPasteFallback(false)}
        onImported={() => {
          setShowPasteFallback(false);
          onClose();
        }}
      />
    );
  }

  return (
    <BaseDialog
      open={open}
      onClose={onClose}
      busy={busy}
      iconName="sparkles"
      title="批量 AI 生成系列"
      subtitle="一次生成 N 部不同的剧 · 每剧独立集数 · 所有参数都可不填"
      ariaLabel="批量 AI 生成系列"
      headerExtra={
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "5px 12px",
            borderRadius: 999,
            background: "linear-gradient(135deg, var(--brand-50), var(--brand-100))",
            border: "1px solid var(--brand-200)",
            fontSize: 12,
            color: "var(--brand-700)",
            fontWeight: 600,
          }}
        >
          <Icon name="layers" size={11} />
          {projects.length} 部剧
          {stats.totalEpisodes > 0 ? ` · 共 ${stats.totalEpisodes}+ 集` : " · 集数由 AI 决定"}
          {` · 约 ${stats.estimatedImageBriefsMin}-${stats.estimatedImageBriefsMax} 张素材图`}
        </div>
      }
      footer={
        <>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontSize: 11.5,
              color: "var(--ink-600)",
              whiteSpace: "nowrap",
            }}
            title="按每集典型 2-4 张素材图粗估 (角色 1-2 + 场景 1-2); 真实张数由 AI 在剧本规划时决定, 导入 JSON 后会显示准确数量"
          >
            <Icon name="image" size={12} />
            预计素材图 {stats.estimatedImageBriefsMin}-{stats.estimatedImageBriefsMax} 张
          </span>
          <PromptReviewButton
            label="查看完整提示词"
            size="sm"
            disabled={busy}
            loadPrompt={async () => {
              const r = await apiPost<PreviewPromptResponse>(
                "/api/v2/series/batch-generate/preview-prompt",
                buildPayload(),
              );
              return {
                kind: "text" as const,
                full_prompt: r.prompt,
                target_provider: modelRef ?? "auto",
                target_model: "batch-series",
              };
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            iconLeft="upload"
            onClick={() => setShowImportMulti(true)}
            disabled={busy}
            title="把外部 AI 生成的多剧 JSON 粘贴进来, 一键创建所有项目"
            style={{
              background: "linear-gradient(135deg, var(--brand-50) 0%, var(--brand-100) 100%)",
              border: "1px solid var(--brand-300)",
              color: "var(--brand-700)",
              fontWeight: 600,
            }}
          >
            导入外部 JSON · 一键创建
          </Button>

          <span style={{ flex: 1 }} />

          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            iconLeft="sparkles"
            loading={busy}
            onClick={() => void handleGenerate()}
          >
            {busy ? "AI 生成中…" : `AI 一键生成 ${projects.length} 部剧`}
          </Button>
        </>
      }
    >
      {/* 2026-05-19: 顶部"目标剧集数量"卡片 */}
      <div
        style={{
          marginBottom: 18,
          padding: 14,
          borderRadius: 12,
          border: "1px solid var(--brand-200)",
          background: "linear-gradient(135deg, var(--brand-50) 0%, #fff 100%)",
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <Icon name="layers" size={18} style={{ color: "var(--brand-600)" }} />
        <label
          htmlFor="batch-target-project-count"
          style={{ fontSize: 13, fontWeight: 700, color: "var(--brand-700)" }}
        >
          批量生成的剧集数量(部):
        </label>
        <input
          id="batch-target-project-count"
          type="number"
          min={1}
          max={10}
          value={targetProjectCount}
          onChange={(e) => handleTargetCountChange(e.target.value)}
          style={{
            width: 80,
            height: 36,
            padding: "0 12px",
            borderRadius: 8,
            border: "1px solid var(--brand-300)",
            fontSize: 14,
            fontWeight: 600,
            color: "var(--brand-700)",
            outline: "none",
            background: "#fff",
            textAlign: "center",
          }}
        />
        <span style={{ fontSize: 12, color: "var(--ink-600)", flex: 1 }}>
          项 · 输入数字会自动同步下方项目卡片(范围 1-10 部)
        </span>
      </div>

      {/* LLM 模型选择 */}
      <div style={{ marginBottom: 18 }}>
        <SectionLabel icon="sparkles">LLM 模型</SectionLabel>
        <ModelPicker
          kind="text"
          value={modelRef}
          onChange={setModelRef}
          placeholder="选择 LLM(可选, 默认走全局)"
          size="md"
        />
      </div>

      {/* 优化 1: 创建完后一键继续跑全集 */}
      <AutoRunPanel
        autoRunAfterCreate={autoRunAfterCreate}
        onAutoRunAfterCreateChange={setAutoRunAfterCreate}
        autoRunMode={autoRunMode}
        onAutoRunModeChange={setAutoRunMode}
        autoRunImageRef={autoRunImageRef}
        onAutoRunImageRefChange={setAutoRunImageRef}
        autoRunVideoRef={autoRunVideoRef}
        onAutoRunVideoRefChange={setAutoRunVideoRef}
      />

      {/* 全局灵感总指示 */}
      <div style={{ marginBottom: 18 }}>
        <SectionLabel>灵感总指示 (可选, 适用于所有项目)</SectionLabel>
        <Textarea
          value={globalInspiration}
          onChange={(e) => setGlobalInspiration(e.target.value)}
          placeholder={
            "例: 我想要 3 部不同的悬疑短剧, 风格清新治愈, 主角都是 20 岁出头的年轻人...\n\n" +
            "什么都不写也行 — AI 看每部剧自己的灵感"
          }
          rows={3}
          className="font-serif text-[13px] leading-[1.6] text-[var(--ink-800)]"
        />
      </div>

      {/* 全局默认参数 */}
      <GlobalDefaultsPanel
        defaults={globalDefaults}
        onChange={setGlobalDefaults}
        disabled={busy}
      />

      {/* 项目列表 */}
      <div style={{ marginBottom: 6 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 10,
          }}
        >
          <SectionLabel icon="film">项目列表 ({projects.length} 部)</SectionLabel>
          <span style={{ flex: 1 }} />
          <Button
            variant="secondary"
            size="sm"
            iconLeft="plus"
            onClick={addProject}
            disabled={busy || projects.length >= 10}
            title={projects.length >= 10 ? "单次最多 10 部" : "新增一个空项目"}
          >
            添加新项目
          </Button>
          <Button
            variant="ghost"
            size="sm"
            iconLeft="copy"
            onClick={duplicateLastProject}
            disabled={busy || projects.length >= 10}
            title="复制最后一个项目的参数"
          >
            复制上一个
          </Button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {projects.map((p, idx) => (
            <ProjectCard
              key={p.id}
              slot={p}
              index={idx}
              canRemove={projects.length > 1}
              existingTitles={existingTitles}
              onChange={(patch) => updateProject(p.id, patch)}
              onRemove={() => removeProject(p.id)}
            />
          ))}
        </div>
      </div>

      {/* 2026-05-19 后续 #3: BatchImportMultiDialog */}
      {showImportMulti && (
        <BatchImportMultiDialog
          open={showImportMulti}
          onClose={() => setShowImportMulti(false)}
          existingTitles={existingTitles}
          onCreated={(info) => {
            setShowImportMulti(false);
            if (onCreated && info.series_slugs.length > 0) {
              onCreated({
                series_slug: info.series_slugs[0],
                series_title: `批量导入 · ${info.projects_created} 部剧`,
                episodes_created: 0,
              });
            }
            onClose();
          }}
        />
      )}
    </BaseDialog>
  );
}

// ─── helpers ─────────────────────────────────────────────────────

function SectionLabel({
  children,
  icon,
}: {
  children: React.ReactNode;
  icon?: "sparkles" | "layers" | "film";
}) {
  return (
    <label
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.08em",
        color: "var(--ink-500)",
        textTransform: "uppercase",
        marginBottom: 8,
        display: "flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      {icon && <Icon name={icon} size={11} style={{ color: "var(--brand-600)" }} />}
      {children}
    </label>
  );
}

export default BatchSeriesDialog;
