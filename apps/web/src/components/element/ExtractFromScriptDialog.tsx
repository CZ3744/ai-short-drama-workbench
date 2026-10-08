/**
 * ExtractFromScriptDialog — 从剧本一键 AI 生成素材库 (2026-05-19 反馈).
 *
 * 用户原话:
 * > "素材库要允许一键导入所有素材, 通过拉取项目剧本内容, 要求 AI 分析需要添加什么素材
 * >  并回复结构化文本, 一键落实到本地添加好所有素材的参数..."
 * > "剧本页面也要有这个功能, 可以对剧本一键询问, 并引导用户跳转到素材库导入"
 *
 * 设计原则覆盖:
 *   - 铁律 #1 用户控制权: 不强制提交, 审核区可改可弃
 *   - 铁律 #2 可干预性: "复制完整提示词" + "粘贴外部 AI 结果" 双通道
 *   - 铁律 #3 信息直接可见: 剧本预览 + 审核区默认展开, 不用展开二级面板
 *   - 铁律 #4 就近决策: ModelPicker kind="text" 紧贴 Dialog 顶部
 *   - 铁律 #11 按钮都有名字: 所有按钮 icon + 文字
 *
 * 后端契约:
 *   - POST /api/v2/series/:slug/extract-elements-from-script         → 真调用 (含/不含 parsed_payload)
 *   - POST /api/v2/series/:slug/extract-elements-from-script/preview-prompt → 零成本 prompt
 */

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Icon } from "../shared/Icon";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { ModelPicker } from "../studio/ModelPicker";
import { apiPost } from "../../lib/api";
import { showErrorToast } from "../../lib/errorTranslate";
import { parseUserJsonPayload } from "../../lib/parseUserJsonPayload";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { BaseDialog } from "../ui/BaseDialog";

// ─── 后端响应类型 (与 extractElementsFromScript.ts 对齐) ─────────────

interface ImageBriefDto {
  angle: string;
  description: string;
}
interface ExtractedCharacterDto {
  name: string;
  role?: string;
  appearance?: string;
  outfit?: string;
  personality?: string;
  image_briefs?: ImageBriefDto[];
}
interface ExtractedSceneDto {
  name: string;
  location?: string;
  time_of_day?: string;
  mood?: string;
  visual_style?: string;
  image_briefs?: ImageBriefDto[];
}
interface ExtractedPropDto {
  name: string;
  description?: string;
  image_briefs?: ImageBriefDto[];
}
interface ExtractedPayloadDto {
  characters?: ExtractedCharacterDto[];
  scenes?: ExtractedSceneDto[];
  props?: ExtractedPropDto[];
}

interface PreviewPromptResponse {
  prompt: string;
  script_md: string;
  series_title: string;
  existing_names: string[];
}

interface ExtractResponse {
  ok: true;
  /** 2026-05-19: dry_run=true 时 dry_run=true + dry_run_payload 有值, 不落盘 */
  dry_run?: boolean;
  dry_run_payload?: ExtractedPayloadDto;
  added: { characters: number; scenes: number; props: number };
  pending_image_briefs: number;
  skipped: Array<{ kind: "character" | "scene" | "prop"; name: string; reason: string }>;
  prompt_used?: string;
  raw_llm_output?: string;
  duration_ms: number;
}

// ─── Props ──────────────────────────────────────────────────────────

export interface ExtractFromScriptDialogProps {
  slug: string;
  open: boolean;
  onClose: () => void;
  /** 成功落盘后回调 (用于刷新素材列表 / toast 跳转引导) */
  onExtracted?: (info: ExtractResponse) => void;
}

// ─── 组件 ───────────────────────────────────────────────────────────

export function ExtractFromScriptDialog({
  slug,
  open,
  onClose,
  onExtracted,
}: ExtractFromScriptDialogProps) {
  const [stage, setStage] = useState<"idle" | "loading-prompt" | "calling-llm" | "saving">("idle");
  const [modelRef, setModelRef] = useState<string | null>(null);

  // prompt 预览数据
  const [preview, setPreview] = useState<PreviewPromptResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // LLM 输出 JSON 审核区
  const [reviewJson, setReviewJson] = useState<string>("");

  // P0-5 (2026-05-28 audit wave 4): 勾选状态 (key = "kind:index", value = 是否勾选)
  // 默认全部勾选, 用户可逐项取消, 只创建勾选的部分. 老行为是"全或无"用户无法挑.
  const [selectedKeys, setSelectedKeys] = useState<Record<string, boolean>>({});
  // 是否切到原始 JSON 编辑模式 (兜底)
  const [showRawJson, setShowRawJson] = useState(false);
  // 三组展开/收起 (默认全展开)
  const [expandedGroups, setExpandedGroups] = useState<Record<"characters" | "scenes" | "props", boolean>>({
    characters: true,
    scenes: true,
    props: true,
  });

  // useAsyncAction 管 busy + try/catch/finally — 错误走 showErrorToast 翻译链路
  const analyzeAction = useAsyncAction(
    async () =>
      apiPost<ExtractResponse>(
        `/api/v2/series/${encodeURIComponent(slug)}/extract-elements-from-script`,
        { dry_run: true, ...(modelRef ? { model_ref: modelRef } : {}) },
      ),
    { errorMessage: "AI 分析失败" },
  );

  const submitAction = useAsyncAction(
    async (parsed: ExtractedPayloadDto) =>
      apiPost<ExtractResponse>(
        `/api/v2/series/${encodeURIComponent(slug)}/extract-elements-from-script`,
        { parsed_payload: parsed },
      ),
    { errorMessage: "创建素材失败" },
  );

  const busy = analyzeAction.busy || submitAction.busy;

  useEffect(() => {
    if (!open) {
      setStage("idle");
      setReviewJson("");
      setSelectedKeys({});
      setShowRawJson(false);
      return;
    }
    // 打开时主动拉一次 preview (剧本预览 + existing_names)
    let cancelled = false;
    (async () => {
      setPreviewLoading(true);
      try {
        const r = await apiPost<PreviewPromptResponse>(
          `/api/v2/series/${encodeURIComponent(slug)}/extract-elements-from-script/preview-prompt`,
          {},
        );
        if (!cancelled) setPreview(r);
      } catch (err) {
        if (!cancelled) showErrorToast(err, "拉取剧本预览失败");
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, slug]);

  const scriptPreviewText = useMemo(() => {
    if (!preview) return "";
    const md = preview.script_md.trim();
    if (!md) return "(当前系列还没有剧本内容 — 请先去剧本页扩写)";
    if (md.length <= 500) return md;
    return md.slice(0, 500) + "...\n\n(剧本过长, 此处仅显示前 500 字; AI 会读完整剧本)";
  }, [preview]);

  // open=false 时 BaseDialog 自己返 null, 这里只在 open=true 时才进入下面 derived state.

  const hasReviewPayload = reviewJson.trim().length > 0;
  const scriptIsEmpty = !preview?.script_md.trim();

  // P0-5: 解析审核区 JSON, 解析失败时 null (自动切回 raw 模式)
  const parsedPayload = useMemo<ExtractedPayloadDto | null>(() => {
    if (!reviewJson.trim()) return null;
    const r = parseUserJsonPayload<ExtractedPayloadDto>(reviewJson);
    return r.ok ? r.data : null;
  }, [reviewJson]);

  function isSelected(key: string): boolean {
    return selectedKeys[key] !== false;
  }
  function toggleKey(key: string) {
    setSelectedKeys((prev) => ({ ...prev, [key]: !isSelected(key) }));
  }
  function toggleGroup(group: "characters" | "scenes" | "props", payload: ExtractedPayloadDto) {
    const items = payload[group] ?? [];
    const allSelected = items.every((_, i) => isSelected(`${group}:${i}`));
    setSelectedKeys((prev) => {
      const next = { ...prev };
      items.forEach((_, i) => { next[`${group}:${i}`] = !allSelected; });
      return next;
    });
  }
  function filterPayloadBySelection(payload: ExtractedPayloadDto): ExtractedPayloadDto {
    return {
      characters: (payload.characters ?? []).filter((_, i) => isSelected(`characters:${i}`)),
      scenes: (payload.scenes ?? []).filter((_, i) => isSelected(`scenes:${i}`)),
      props: (payload.props ?? []).filter((_, i) => isSelected(`props:${i}`)),
    };
  }

  const selectedCount = useMemo(() => {
    if (!parsedPayload) return 0;
    let n = 0;
    (parsedPayload.characters ?? []).forEach((_, i) => { if (isSelected(`characters:${i}`)) n++; });
    (parsedPayload.scenes ?? []).forEach((_, i) => { if (isSelected(`scenes:${i}`)) n++; });
    (parsedPayload.props ?? []).forEach((_, i) => { if (isSelected(`props:${i}`)) n++; });
    return n;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsedPayload, selectedKeys]);

  const totalCount = useMemo(() => {
    if (!parsedPayload) return 0;
    return (parsedPayload.characters?.length ?? 0) + (parsedPayload.scenes?.length ?? 0) + (parsedPayload.props?.length ?? 0);
  }, [parsedPayload]);

  // ─── 业务动作 ────────────────────────────────────────────────────

  async function handleAnalyze() {
    if (busy || scriptIsEmpty) return;
    setStage("calling-llm");
    // 2026-05-19: dry_run=true 让 LLM 只返回 payload 不落盘, 用户审核后再点"用 JSON 创建素材"真落盘.
    // 用户原话:"AI 分析→回复结构化文本→一键落实" — 必须有审核环节.
    const result = await analyzeAction.run();
    setStage("idle");
    if (!result) return;
    // dry_run 路径: 后端返回 dry_run_payload (结构化 JSON), 填到审核区让用户改, 不落盘
    if (result.dry_run_payload) {
      setReviewJson(JSON.stringify(result.dry_run_payload, null, 2));
      // 2026-07-09 audit (C27): 新一批分析结果替换审核区时重置勾选, 恢复"默认全部勾选".
      // 否则上一批按位置索引 (characters:3 等) 的取消勾选会残留到新批 — 顺序/内容全变后, 位于同一
      // 索引的素材被静默排除, 用户点"创建"时漏建且无提示. 重置 {} 也天然覆盖"两批长度不同"的变体.
      setSelectedKeys({});
      const total =
        (result.dry_run_payload.characters?.length ?? 0) +
        (result.dry_run_payload.scenes?.length ?? 0) +
        (result.dry_run_payload.props?.length ?? 0);
      toast.success(
        `AI 分析完成 — 建议创建 ${total} 个素材 · ${result.pending_image_briefs} 张图. 审核 / 修改后点 "用 JSON 创建素材" 真落盘.`,
        { duration: 6000 },
      );
    } else if (result.raw_llm_output) {
      // 兜底: 后端没正确返 dry_run_payload, 显示原始 LLM 输出让用户手动整理
      setReviewJson(result.raw_llm_output.trim());
      setSelectedKeys({}); // 2026-07-09 audit (C27): 同上, 兜底路径也重置勾选防残留漏建
      toast.info("AI 已返回结果, 请审核 JSON 后点 '用 JSON 创建素材'");
    }
  }

  async function handleSubmitParsed() {
    if (busy) return;
    const r = parseUserJsonPayload<ExtractedPayloadDto>(reviewJson);
    if (!r.ok) {
      toast.error(r.message);
      return;
    }
    // P0-5: tree 模式按勾选过滤, raw JSON 模式 (无 parsedPayload) 全量提交
    const payloadToSubmit = parsedPayload ? filterPayloadBySelection(r.data) : r.data;
    const submitCount =
      (payloadToSubmit.characters?.length ?? 0) +
      (payloadToSubmit.scenes?.length ?? 0) +
      (payloadToSubmit.props?.length ?? 0);
    if (submitCount === 0) {
      toast.error("勾选 0 项, 至少选 1 个素材才能创建");
      return;
    }
    setStage("saving");
    const result = await submitAction.run(payloadToSubmit);
    setStage("idle");
    if (!result) return;
    const totalAdded = result.added.characters + result.added.scenes + result.added.props;
    toast.success(
      `已创建 ${totalAdded} 个素材 · ${result.pending_image_briefs} 张图待生成${
        result.skipped.length > 0 ? ` · ${result.skipped.length} 项跳过 (已存在)` : ""
      }`,
    );
    onExtracted?.(result);
    onClose();
  }

  async function handleCopyPrompt() {
    setStage("loading-prompt");
    try {
      // 已有 preview 用; 否则现拉
      let promptText = preview?.prompt;
      if (!promptText) {
        const r = await apiPost<PreviewPromptResponse>(
          `/api/v2/series/${encodeURIComponent(slug)}/extract-elements-from-script/preview-prompt`,
          {},
        );
        promptText = r.prompt;
        setPreview(r);
      }
      await navigator.clipboard.writeText(promptText);
      toast.success(
        "完整提示词已复制 — 粘到 ChatGPT/Claude/Gemini 自己生 JSON, 再贴回到审核区点'用 JSON 创建素材'",
      );
    } catch (err) {
      showErrorToast(err, "复制提示词失败");
    } finally {
      setStage("idle");
    }
  }

  function handlePasteExternal() {
    // 简单提示用户直接在审核区里粘贴 (textarea 自身已支持 Ctrl+V)
    toast.info("直接在下方审核区粘贴 JSON, 然后点'用 JSON 创建素材'", { duration: 4000 });
  }

  // ─── 渲染 ────────────────────────────────────────────────────────

  return (
    <BaseDialog
      open={open}
      onClose={onClose}
      busy={busy}
      iconName="sparkles"
      title="从剧本一键生成素材"
      subtitle="AI 读完剧本, 自动分析需要的角色 / 场景 / 物品, 一次性建好素材库"
      ariaLabel="从剧本一键生成素材"
      footerLeft={
        <span style={{ fontSize: 11, color: "var(--ink-500)" }}>
          {scriptIsEmpty ? (
            <span style={{ color: "var(--warn)" }}>请先去剧本页扩写剧本</span>
          ) : (
            "AI 直接落盘到素材库, 同名素材会自动跳过不覆盖"
          )}
        </span>
      }
      footer={
        <>
          <Button variant="secondary" size="sm" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            iconLeft="sparkles"
            loading={stage === "calling-llm"}
            disabled={busy || scriptIsEmpty}
            title={scriptIsEmpty ? "剧本为空, 无法分析" : "调 LLM 分析剧本并落盘所有素材 (跳过同名)"}
            onClick={() => void handleAnalyze()}
          >
            {stage === "calling-llm" ? "AI 分析中…" : "AI 分析"}
          </Button>
          <Button
            variant="primary"
            size="sm"
            iconLeft="check"
            loading={stage === "saving"}
            disabled={busy || !hasReviewPayload || (parsedPayload !== null && selectedCount === 0)}
            title={
              parsedPayload && selectedCount === 0
                ? "勾选 0 项, 无法创建"
                : "把审核区勾选的素材落盘 (不再调 LLM)"
            }
            onClick={() => void handleSubmitParsed()}
          >
            {stage === "saving"
              ? "创建中…"
              : parsedPayload
                ? `创建勾选的 ${selectedCount} / ${totalCount} 项`
                : "用 JSON 创建素材"}
          </Button>
        </>
      }
    >
      {/* LLM 模型选择 */}
          <div style={{ marginBottom: 18 }}>
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
              <Icon name="sparkles" size={11} style={{ color: "var(--brand-600)" }} /> LLM 模型
            </label>
            <ModelPicker
              kind="text"
              value={modelRef}
              onChange={setModelRef}
              placeholder="选择 LLM (可选, 默认走全局)"
              size="md"
            />
          </div>

          {/* 当前剧本预览 */}
          <div style={{ marginBottom: 18 }}>
            <label
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.08em",
                color: "var(--ink-500)",
                textTransform: "uppercase",
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginBottom: 6,
              }}
            >
              <Icon name="doc" size={11} /> 当前剧本预览
              {preview ? (
                <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--ink-400)" }}>
                  「{preview.series_title}」· 已有 {preview.existing_names.length} 个素材
                </span>
              ) : null}
            </label>
            <Textarea
              value={previewLoading ? "加载中…" : scriptPreviewText}
              readOnly
              rows={6}
              className="font-serif text-[12.5px] leading-[1.6] text-[var(--ink-700)]"
              style={{ background: "var(--ink-50)" }}
            />
          </div>

          {/* 辅助操作 — 复制提示词 / 粘外部结果 */}
          <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
            <Button
              variant="secondary"
              size="sm"
              iconLeft="doc"
              loading={stage === "loading-prompt"}
              disabled={busy || stage === "loading-prompt"}
              title="把完整 prompt 写到剪贴板, 你可以粘到 ChatGPT/Claude/Gemini 自己生"
              onClick={handleCopyPrompt}
            >
              {stage === "loading-prompt" ? "正在拉取…" : "复制完整提示词"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              iconLeft="upload"
              disabled={busy}
              title="如果在外部 AI 拿到 JSON, 可粘贴到下方审核区"
              onClick={handlePasteExternal}
            >
              粘贴外部 AI 结果
            </Button>
          </div>

          {/* 审核区 — P0-5 (audit wave 4): tree 视图 (默认) / raw JSON (兜底). 用户可单选取消. */}
          <div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.08em",
                color: "var(--ink-500)",
                textTransform: "uppercase",
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginBottom: 6,
              }}
            >
              <Icon name="layers" size={11} /> 审核区
              {hasReviewPayload && parsedPayload ? (
                <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--brand-700)" }}>
                  共 {totalCount} 项 · 已勾选 {selectedCount} · 可勾掉部分
                </span>
              ) : hasReviewPayload ? (
                <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--warn)" }}>
                  JSON 无法解析 · 自动切到原始编辑
                </span>
              ) : (
                <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--ink-400)" }}>
                  点 "AI 分析" 或在此粘贴外部 JSON
                </span>
              )}
              {parsedPayload ? (
                <button
                  type="button"
                  onClick={() => setShowRawJson((v) => !v)}
                  style={{
                    fontSize: 10,
                    padding: "2px 8px",
                    border: "1px solid var(--ink-300)",
                    borderRadius: 4,
                    background: showRawJson ? "var(--ink-100)" : "transparent",
                    color: "var(--ink-700)",
                    cursor: "pointer",
                    marginLeft: 6,
                  }}
                  title={showRawJson ? "切回勾选视图" : "切到原始 JSON 编辑"}
                >
                  {showRawJson ? "勾选视图" : "原始 JSON"}
                </button>
              ) : null}
            </div>
            {parsedPayload && !showRawJson ? (
              <div
                style={{
                  border: "1px solid var(--ink-200)",
                  borderRadius: 6,
                  background: "var(--ink-50)",
                  padding: 8,
                  maxHeight: 380,
                  overflowY: "auto",
                }}
              >
                {(["characters", "scenes", "props"] as const).map((groupKey) => {
                  const items = parsedPayload[groupKey] ?? [];
                  if (items.length === 0) return null;
                  const groupLabel = groupKey === "characters" ? "角色" : groupKey === "scenes" ? "场景" : "物品";
                  const groupIcon = groupKey === "characters" ? "user" : groupKey === "scenes" ? "image" : "package";
                  const expanded = expandedGroups[groupKey];
                  const groupSelected = items.filter((_, i) => isSelected(`${groupKey}:${i}`)).length;
                  const groupAllSelected = groupSelected === items.length;
                  return (
                    <div key={groupKey} style={{ marginBottom: 8 }}>
                      <div
                        style={{
                          display: "flex", alignItems: "center", gap: 6, padding: "4px 6px",
                          background: "var(--ink-100)", borderRadius: 4, fontSize: 12, fontWeight: 600,
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => setExpandedGroups((p) => ({ ...p, [groupKey]: !p[groupKey] }))}
                          style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0, display: "flex", alignItems: "center" }}
                          title={expanded ? "收起" : "展开"}
                        >
                          <Icon name={expanded ? "chevDown" : "chevRight"} size={12} />
                        </button>
                        <input
                          type="checkbox"
                          checked={groupAllSelected}
                          ref={(el) => { if (el) el.indeterminate = !groupAllSelected && groupSelected > 0; }}
                          onChange={() => toggleGroup(groupKey, parsedPayload)}
                          title={groupAllSelected ? "取消全选" : "全选该组"}
                        />
                        <Icon name={groupIcon} size={12} style={{ color: "var(--brand-600)" }} />
                        <span>{groupLabel}</span>
                        <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--ink-500)", fontWeight: 400 }}>
                          {groupSelected} / {items.length}
                        </span>
                      </div>
                      {expanded ? (
                        <div style={{ marginTop: 4, paddingLeft: 8 }}>
                          {items.map((item, idx) => {
                            const key = `${groupKey}:${idx}`;
                            const sel = isSelected(key);
                            const subline =
                              groupKey === "characters"
                                ? [(item as ExtractedCharacterDto).role, (item as ExtractedCharacterDto).appearance].filter(Boolean).join(" · ")
                                : groupKey === "scenes"
                                ? [(item as ExtractedSceneDto).location, (item as ExtractedSceneDto).time_of_day, (item as ExtractedSceneDto).mood].filter(Boolean).join(" · ")
                                : (item as ExtractedPropDto).description ?? "";
                            const briefCount = (item as { image_briefs?: ImageBriefDto[] }).image_briefs?.length ?? 0;
                            return (
                              <label
                                key={key}
                                style={{
                                  display: "flex", alignItems: "flex-start", gap: 6, padding: "4px 6px",
                                  fontSize: 12, cursor: "pointer", opacity: sel ? 1 : 0.45, borderRadius: 3,
                                }}
                              >
                                <input type="checkbox" checked={sel} onChange={() => toggleKey(key)} style={{ marginTop: 3 }} />
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontWeight: 500, color: "var(--ink-800)" }}>{item.name}</div>
                                  {subline ? (
                                    <div style={{ fontSize: 11, color: "var(--ink-500)", marginTop: 1 }}>{subline}</div>
                                  ) : null}
                                  {briefCount > 0 ? (
                                    <div style={{ fontSize: 10, color: "var(--brand-700)", marginTop: 1 }}>{briefCount} 张图待生成</div>
                                  ) : null}
                                </div>
                              </label>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                {totalCount === 0 ? (
                  <div style={{ padding: 12, textAlign: "center", color: "var(--ink-500)", fontSize: 12 }}>
                    AI 没有识别出任何素材
                  </div>
                ) : null}
              </div>
            ) : (
              <Textarea
                value={reviewJson}
                onChange={(e) => setReviewJson(e.target.value)}
                placeholder={
                  "AI 分析结果会出现在这里 — 你可以审核 / 修改 / 删字段, 改完点底部 '用 JSON 创建素材'\n\n" +
                  "或者从外部 AI 拿到 JSON 直接粘到这里"
                }
                rows={12}
                spellCheck={false}
                className="font-mono text-[12px] leading-[1.5] text-[var(--ink-800)]"
              />
            )}
          </div>
    </BaseDialog>
  );
}

export default ExtractFromScriptDialog;
