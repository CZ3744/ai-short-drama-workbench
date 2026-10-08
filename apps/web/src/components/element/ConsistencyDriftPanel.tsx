/**
 * ConsistencyDriftPanel — W8-A 角色一致性漂移面板.
 *
 * 仅在 kind=character 的 ElementWorkbench 右栏出现.
 *
 * ── Wave B-12 降级 (2026-05-16) ───────────────────────────────────────
 *
 * 用户原话(USER_FEEDBACK_2026-05-16 §3 + PRODUCT.md §4.3 B-12):
 *   "一致性体检的算法(embedding 相似度)实际价值有限, 显式多图参考更可靠"
 *
 * Wave B-2 落地后, 系统在生图时自动用角色/场景主图作 reference, 一致性主要靠
 * "主图锚定 + 自动隐式参考" 解决. 本面板降级为"可选辅助":
 *  - 默认折叠 (用户不必每次打开)
 *  - 文案改: "一致性体检" → "一致性体检(可选辅助)"
 *  - 副提示明确告知: 系统已在生图时自动用主图作参考保持一致, 本面板用于事后审视
 *
 * 数据 + 算法保持不变 — 用户想看时打开即用. 不删数据 (铁律 #6 数据保留).
 *
 * ── 原有设计点 ───────────────────────────────────────────────────────
 * 设计点(对照 docs/ASSET_MANAGEMENT_REDESIGN.md § ReferenceSet 段):
 *   - 调 GET /api/v2/series/:slug/characters/:charId/consistency-check?threshold=0.65
 *   - 横向条形图:每张图相对其他图的平均相似度(0-100%)
 *   - 平均 < 65% → 红描边 + 「重新生成此角度」CTA(内嵌 ModelPicker,铁律 #4)
 *   - 默认折叠(details/summary 默认 closed)
 *
 * 12 铁律对照:
 *   #4  就近决策 — 「重新生成」按钮旁内嵌 ModelPicker,不必跳设置
 *   #9  toC 兜底 — UI 文案不出现 cosine / 0.73 / CLIP / 相似度数值,
 *                  只用「相似 73%」「漂移」「一致性良好」等中文化表达
 *   #11 按钮有名字 — 所有按钮 icon + 文字 + 边框,无 icon-only
 *   #3  信息直接可见 — 体检报告核心结论默认平铺(打开后),不再藏层级
 *
 * 「重新生成」交互:点击 → 父组件(ElementWorkbench)接管,prefill 角度提示词到生成 panel.
 * 本组件只派发 onRegenerateAngle(angle, imageId) 事件,自己不调网络生成.
 */

import { useCallback, useMemo, useState } from "react";
import type React from "react";
import { Icon } from "../shared/Icon";
import { ModelPicker } from "../studio/ModelPicker";
import { Button } from "../ui/button";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { Select } from "../ui/select";
import {
  ELEMENT_ANGLE_LABEL,
  ELEMENT_ANGLE_ORDER,
  displayNameOfImage,
  getConsistencyCheck,
  dryRunElementImage,
  patchElementImage,
  type ConsistencyReport,
  type ElementAngle,
  type ElementImage,
} from "../../lib/elementApi";
import { InlineLabel } from "../shot-stage/InlineLabel";
import { PromptReviewButton, type PromptPreview } from "../shared/PromptReviewButton";
import { getV2Settings, patchV2Settings } from "../../lib/settingsApi";
import { useEffect } from "react";
import { toast } from "sonner";
import { showErrorToast } from "../../lib/errorTranslate";

// 2026-05-20 Wave T 留尾 — 一致性评分器(三级 cascade 起点)
type ScorerProvider = "gemini_flash" | "local_clip" | "phash";
const SCORER_OPTIONS: Array<{ value: ScorerProvider; label: string; hint: string }> = [
  { value: "gemini_flash", label: "视觉模型评分", hint: "需配置视觉评分服务，费用以实际模型为准" },
  { value: "local_clip", label: "本地图像嵌入评分", hint: "需安装并验证本地图像模型；首次使用可能下载模型" },
  { value: "phash", label: "相同文件检查", hint: "只确认文件字节相同，不代表角色视觉相似" },
];

export interface ConsistencyDriftPanelProps {
  slug: string;
  /** 角色 element id(elementController 已把 character kind 适配到 characterRepo) */
  charId: string;
  images: ElementImage[];
  /**
   * 触发「重新生成此角度」— 父组件应当 prefill 角度提示词到 ImageGenerationPanel.
   *
   * @param angle 触发漂移那张图的角度槽位(null 表示没打标的图)
   * @param model_ref 用户在本面板内就近挑的模型 ref(可为空,沿用默认)
   * @param baseImageId 触发那张图的 image_id(供 i2i base 用)
   */
  onRegenerateAngle: (angle: ElementAngle | null, modelRef: string | null, baseImageId: string) => void;
  /**
   * 漂移卡片内快捷打角度标签 — 铁律 #4 就近决策。
   * 不传则"未指定角度"显示为静态文本。
   */
  onSetAngle?: (imageId: string, angle: ElementAngle | null) => void;
  /**
   * W8-sweep (2026-05-16): 点击漂移卡片缩略图 → 父组件接管放大查看 (MediaLightbox).
   * 不传则缩略图不可点(老行为).
   */
  onOpenImage?: (image: ElementImage) => void;
}

// 与其他按钮一致 — 圆角矩形 + 边框 + 图标 + 文字(铁律 #11)

// 0-1 相似度 → 中文化等级标签(避免暴露原始数值/算法名)
function gradeLabel(avg: number, threshold: number): { text: string; color: string } {
  // threshold 任务规约默认 0.65 — UI 不暴露阈值数字
  if (avg >= 0.85) return { text: "高度一致", color: "var(--success, #16a34a)" };
  if (avg >= threshold) return { text: "整体一致", color: "var(--success, #16a34a)" };
  if (avg >= threshold - 0.1) return { text: "轻微漂移", color: "var(--warn, #f59e0b)" };
  return { text: "明显漂移", color: "var(--err, #dc2626)" };
}

// 百分比格式 — 唯一暴露的"数字",但是 0-100 整数百分比,不是 cosine
function pct(v: number | null): string {
  if (v === null) return "无法评价";
  return `${Math.round(v * 100)}%`;
}

export function ConsistencyDriftPanel(props: ConsistencyDriftPanelProps) {
  const { slug, charId, images, onRegenerateAngle, onSetAngle, onOpenImage } = props;

  // Wave B-12 (2026-05-16): 默认折叠 — 与降级文案一致, 不在用户视线主流量上.
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<ConsistencyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 每张图就近挑选的"重新生成"模型 ref(铁律 #4) — 不在父全局,本组件内每张图独立
  const [modelRefByImage, setModelRefByImage] = useState<Record<string, string | null>>({});
  // 2026-05-20 Wave T 留尾 — 评分器切换(铁律 #2 可干预性)
  const [scorer, setScorer] = useState<ScorerProvider>("gemini_flash");
  const [scorerSaving, setScorerSaving] = useState(false);

  // 首次展开时拉当前 setting
  useEffect(() => {
    if (!open) return;
    getV2Settings()
      .then((s) => {
        const cur = (s.settings.CONSISTENCY_SCORER_PROVIDER || "gemini_flash") as ScorerProvider;
        if (cur === "gemini_flash" || cur === "local_clip" || cur === "phash") {
          setScorer(cur);
        }
      })
      .catch(() => { /* 拉失败保持默认 gemini_flash */ });
  }, [open]);

  async function handleScorerChange(next: ScorerProvider) {
    if (next === scorer || scorerSaving) return;
    setScorerSaving(true);
    const prev = scorer;
    setScorer(next); // optimistic
    try {
      await patchV2Settings({ CONSISTENCY_SCORER_PROVIDER: next });
      toast.success(`评分器已切到 ${SCORER_OPTIONS.find((o) => o.value === next)?.label}`);
    } catch (e) {
      setScorer(prev); // rollback
      // 2026-05-28 audit P2: 走 showErrorToast 统一错误翻译
      showErrorToast(e, "切换失败");
    } finally {
      setScorerSaving(false);
    }
  }

  // useAsyncAction 接管 busy + 错误 — error 是 inline 展示, silent + onError 路径
  const checkAction = useAsyncAction(
    async () => getConsistencyCheck(slug, charId, 0.65),
    {
      silent: true,
      onSuccess: (r) => {
        setError(null);
        setReport(r.report);
      },
      onError: (e) => setError(e instanceof Error ? e.message : String(e)),
    },
  );
  const loading = checkAction.busy;
  const runCheck = useCallback(async () => {
    await checkAction.run();
  }, [checkAction]);

  // 不自动跑 — 用户点"开始体检"按钮才触发 (Fix 2026-05-19 用户反馈 #6)

  // 每张图相对其他图的平均相似度(供条形图)
  const avgByImage = useMemo(() => {
    if (!report) return {} as Record<string, number>;
    const sum: Record<string, number> = {};
    const cnt: Record<string, number> = {};
    for (const p of report.pairs) {
      sum[p.asset_a_id] = (sum[p.asset_a_id] ?? 0) + p.similarity;
      cnt[p.asset_a_id] = (cnt[p.asset_a_id] ?? 0) + 1;
      sum[p.asset_b_id] = (sum[p.asset_b_id] ?? 0) + p.similarity;
      cnt[p.asset_b_id] = (cnt[p.asset_b_id] ?? 0) + 1;
    }
    const out: Record<string, number> = {};
    for (const id of Object.keys(sum)) {
      out[id] = cnt[id] > 0 ? sum[id] / cnt[id] : 1;
    }
    return out;
  }, [report]);

  const threshold = report?.drift_threshold ?? 0.65;
  const overallGrade = report?.avg_similarity != null ? gradeLabel(report.avg_similarity, threshold) : null;

  // 把 element images 按一致性平均值排序(低→高,先看问题图)
  const rankedImages = useMemo(() => {
    if (!report) return [];
    return [...images]
      .filter((im) => avgByImage[im.image_id] !== undefined)
      .sort((a, b) => (avgByImage[a.image_id] ?? 1) - (avgByImage[b.image_id] ?? 1));
  }, [images, report, avgByImage]);

  return (
    <details
      className="mk-card"
      style={{ padding: 0, overflow: "hidden" }}
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary
        style={{
          padding: "12px 16px",
          listStyle: "none",
          cursor: "pointer",
          background: "var(--surface-canvas, #fafafa)",
          borderBottom: open ? "1px solid var(--ink-100)" : "none",
          display: "flex",
          alignItems: "center",
          gap: 8,
          userSelect: "none",
        }}
      >
        <Icon
          name={open ? "chevDown" : "chevRight"}
          size={13}
          style={{ color: "var(--ink-500)" }}
        />
        <Icon name="help" size={14} style={{ color: "var(--ink-400)" }} />
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--ink-700)" }}>
          一致性体检(可选辅助)
        </span>
        {overallGrade ? (
          <span
            className="mk-chip"
            style={{
              fontSize: 10.5,
              padding: "1px 7px",
              background: "transparent",
              color: overallGrade.color,
              border: `1px solid ${overallGrade.color}`,
            }}
          >
            {overallGrade.text} · 相似 {pct(report!.avg_similarity)}
          </span>
        ) : (
          // Wave B-12 (2026-05-16): 副提示 — 让用户清楚本面板已经不是主流量
          <span style={{ fontSize: 10.5, color: "var(--ink-400)", flexShrink: 1, minWidth: 0 }}>
            系统已在生图时自动用主图作参考保持一致, 本面板用于事后审视, 不必每次打开
          </span>
        )}
        <div style={{ flex: 1 }} />
        {open ? (
          <Button
            variant="ghost"
            size="xs"
            iconLeft="refresh"
            loading={loading}
            disabled={loading}
            title="重新拉取最新一致性检查结果"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              runCheck();
            }}
          >
            {loading ? "检查中…" : "重新检查"}
          </Button>
        ) : null}
      </summary>

      {open ? (
        <div style={{ padding: 14 }}>
          {/* 2026-05-20 Wave T 留尾 — 评分器切换(铁律 #2 可干预性).
              三级 cascade: gemini_flash → local_clip → phash, 用户可强制起点. */}
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 12,
            padding: "8px 10px",
            background: "var(--ink-50)",
            borderRadius: 8,
            fontSize: 11.5,
          }}>
            <Icon name="settings" size={12} style={{ color: "var(--ink-500)" }} />
            <span style={{ color: "var(--ink-700)", fontWeight: 600, flexShrink: 0 }}>评分器</span>
            <Select
              value={scorer}
              onChange={(v) => handleScorerChange(v as ScorerProvider)}
              disabled={scorerSaving}
              size="sm"
              options={SCORER_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              ariaLabel="评分器"
            />
            <span style={{ color: "var(--ink-500)", fontSize: 11, flex: 1 }}>
              {SCORER_OPTIONS.find((o) => o.value === scorer)?.hint}
            </span>
            {scorerSaving ? <Icon name="refresh" size={11} style={{ color: "var(--brand-700)" }} /> : null}
          </div>
          {error ? (
            <div role="alert" style={{ padding: 10, marginBottom: 10, border: "1px solid var(--err, #dc2626)", borderRadius: 6, fontSize: 12, color: "var(--err, #dc2626)" }}>
              一致性检查失败：{error}
              {report ? <div>以下保留上一次有效报告，本次未产生新评分。</div> : null}
              <Button variant="ghost" size="xs" iconLeft="refresh" onClick={runCheck} disabled={loading}>重试</Button>
            </div>
          ) : null}
          {images.length < 2 ? (
            <div style={{ fontSize: 12, color: "var(--ink-500)", padding: 8 }}>
              <Icon name="help" size={12} style={{ marginRight: 6 }} />
              该角色当前只有 {images.length} 张图,先在下方图库生成或导入至少 2 张图后再做一致性检查.
            </div>
          ) : loading && !report ? (
            <div style={{ fontSize: 12, color: "var(--ink-500)", padding: 8 }}>
              <Icon name="refresh" size={12} style={{ marginRight: 6 }} />
              正在比对角色多图外观一致性，请稍候…
            </div>
          ) : report ? (
            <>
              {/* 汇总条 */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3, 1fr)",
                  gap: 10,
                  marginBottom: 14,
                }}
              >
                <SummaryStat label="参与对比" value={`${report.total_assets} 张`} />
                <SummaryStat
                  label="整体一致度"
                  value={pct(report.avg_similarity)}
                  color={overallGrade?.color}
                />
                <SummaryStat
                  label="漂移对数"
                  value={`${report.drift_count} 对`}
                  color={report.drift_count > 0 ? "var(--warn, #f59e0b)" : "var(--success, #16a34a)"}
                />
              </div>

              {/* 横向条形图 */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {rankedImages.map((im) => {
                  const avg = avgByImage[im.image_id] ?? 1;
                  const isDrift = avg < threshold;
                  const grade = gradeLabel(avg, threshold);
                  const angleLabel = im.angle ? ELEMENT_ANGLE_LABEL[im.angle] : "未指定角度";
                  const hasAngle = !!im.angle;
                  return (
                    <div
                      key={im.image_id}
                      /* "为何标红" tooltip — 铁律 #9 toC 兜底 */
                      title={
                        isDrift
                          ? "算法判定此图与其他参考图视觉差异较大（与其他图平均相似度低于基准线），可能影响角色一致性。建议重新生成此角度。"
                          : undefined
                      }
                      style={{
                        border: isDrift
                          ? "1.5px solid var(--err, #dc2626)"
                          : "1px solid var(--ink-200)",
                        borderRadius: 5,
                        padding: 10,
                        background: isDrift ? "rgba(220,38,38,0.08)" : "var(--surface-card)",
                        display: "grid",
                        gridTemplateColumns: "56px 1fr auto",
                        gap: 10,
                        alignItems: "center",
                      }}
                    >
                      <div
                        style={{
                          width: 56,
                          height: 56,
                          borderRadius: 4,
                          overflow: "hidden",
                          background: "var(--surface-canvas)",
                          flexShrink: 0,
                        }}
                      >
                        {im.url ? (
                          /* W8-sweep (2026-05-16): 点击缩略图 → 父组件 MediaLightbox 放大查看 */
                          <img
                            src={im.url}
                            alt={im.display_name?.trim() || im.note?.trim() || ""}
                            onClick={onOpenImage ? () => onOpenImage(im) : undefined}
                            title={onOpenImage ? "点击放大查看 / 右键可复制图片" : undefined}
                            style={{
                              width: "100%", height: "100%", objectFit: "cover",
                              cursor: onOpenImage ? "zoom-in" : "default",
                            }}
                          />
                        ) : null}
                      </div>

                      <div style={{ minWidth: 0 }}>
                        {/* V-3.3 铁律 #2: inline rename — 图片名走 display_name + InlineLabel */}
                        <div style={{ marginBottom: 2 }}>
                          <InlineLabel
                            value={displayNameOfImage(im) || ""}
                            fallback="未命名图片"
                            onSave={async (newName) => {
                              const trimmed = newName.trim();
                              if (trimmed === (displayNameOfImage(im) || "")) return;
                              try {
                                await patchElementImage(slug, charId, im.image_id, { display_name: trimmed || undefined });
                              } catch (e) { showErrorToast(e, "改名失败"); throw e; }
                            }}
                          />
                        </div>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            marginBottom: 4,
                            flexWrap: "wrap",
                          }}
                        >
                          {/* 角度标签 — 铁律 #4 就近决策：未打标时可直接选 */}
                          {hasAngle ? (
                            <span
                              className="mk-chip mk-chip--ghost"
                              style={{ fontSize: 10, padding: "1px 6px" }}
                            >
                              {angleLabel}
                            </span>
                          ) : onSetAngle ? (
                            <Select
                              value="__placeholder__"
                              onChange={(v) => {
                                if (v && v !== "__placeholder__") onSetAngle(im.image_id, v as ElementAngle);
                              }}
                              options={[
                                { value: "__placeholder__", label: "未指定角度" },
                                ...ELEMENT_ANGLE_ORDER.map((a) => ({ value: a, label: ELEMENT_ANGLE_LABEL[a] })),
                              ]}
                              size="sm"
                              ariaLabel="给这张图打角度标签"
                              maxWidth={120}
                            />
                          ) : (
                            <span
                              className="mk-chip mk-chip--ghost"
                              style={{ fontSize: 10, padding: "1px 6px" }}
                            >
                              未指定角度
                            </span>
                          )}
                          <span
                            style={{
                              fontSize: 11,
                              fontWeight: 700,
                              color: grade.color,
                            }}
                          >
                            {grade.text} · 相似 {pct(avg)}
                          </span>
                        </div>
                        {/* bar */}
                        <div
                          style={{
                            height: 8,
                            borderRadius: 4,
                            background: "var(--ink-100)",
                            overflow: "hidden",
                          }}
                          aria-label={`这张图与其他图的整体相似度 ${pct(avg)}`}
                        >
                          <div
                            style={{
                              width: `${Math.max(0, Math.min(100, Math.round(avg * 100)))}%`,
                              height: "100%",
                              background: grade.color,
                              transition: "width 200ms",
                            }}
                          />
                        </div>
                      </div>

                      {isDrift ? (
                        <RegenInline
                          image={im}
                          hasAngle={hasAngle}
                          modelRef={modelRefByImage[im.image_id] ?? null}
                          onModelChange={(v) =>
                            setModelRefByImage((prev) => ({ ...prev, [im.image_id]: v }))
                          }
                          onRegenerate={() =>
                            onRegenerateAngle(
                              im.angle ?? null,
                              modelRefByImage[im.image_id] ?? null,
                              im.image_id,
                            )
                          }
                          slug={slug}
                          charId={charId}
                        />
                      ) : (
                        <span style={{ fontSize: 10.5, color: "var(--ink-400)" }}>
                          一致性良好
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>

            </>
          ) : (
            <div style={{ fontSize: 12, color: "var(--ink-500)", padding: 8 }}>
              <Button variant="secondary" size="sm" iconLeft="refresh" onClick={runCheck} disabled={loading}>
                开始检查
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </details>
  );
}

// ─── 子组件 ─────────────────────────────────────────────────────────

function SummaryStat({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div
      style={{
        padding: 10,
        borderRadius: 6,
        background: "var(--surface-canvas, #fafafa)",
        border: "1px solid var(--ink-100)",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <span style={{ fontSize: 10.5, color: "var(--ink-500)" }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 700, color: color ?? "var(--ink-900)" }}>
        {value}
      </span>
    </div>
  );
}

function RegenInline(props: {
  image: ElementImage;
  /** 是否已打角度标签 — 未打标时禁用"重新生成此角度"按钮 */
  hasAngle: boolean;
  modelRef: string | null;
  onModelChange: (v: string | null) => void;
  onRegenerate: () => void;
  /** 铁律 #2: preview-prompt 需要知道所属系列和 element id */
  slug: string;
  charId: string;
}) {
  const { hasAngle, modelRef, onModelChange, onRegenerate, slug, charId, image } = props;
  const regenDisabled = !hasAngle;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 4,
        minWidth: 188,
      }}
    >
      <ModelPicker
        kind="image"
        value={modelRef}
        onChange={onModelChange}
        size="sm"
        placeholder="挑生图模型"
      />
      {/* 铁律 #2: 生图按钮旁必须有"查看完整提示词"按钮 */}
      <PromptReviewButton
        size="sm"
        label="查看提示词"
        disabled={!hasAngle}
        loadPrompt={async (): Promise<PromptPreview> => {
          const result = await dryRunElementImage(slug, charId, {
            image_model_ref: modelRef ?? undefined,
            i2i_base_image_id: image.image_id,
          });
          return {
            kind: "image",
            full_prompt: result.full_prompt_preview,
            target_provider: result.provider_id,
            target_model: result.model_id ?? undefined,
            estimated_cost: result.estimated_cost_cny != null
              ? { cny: result.estimated_cost_cny, note: result.estimated_cost_note }
              : undefined,
          };
        }}
        onSend={async () => {
          if (!regenDisabled) onRegenerate();
        }}
        title="发送前审核此角度重生提示词"
      />
      <Button
        variant="danger"
        size="sm"
        iconLeft="refresh"
        disabled={regenDisabled}
        onClick={regenDisabled ? undefined : onRegenerate}
        title={
          regenDisabled
            ? "请先给此图打角度标签后才能定向重生（使用上方下拉选角度）"
            : "为这个角度重新生图，提示词自动 prefill 角度引导（如「正脸特写」）"
        }
      >
        重新生成此角度
      </Button>
    </div>
  );
}

export default ConsistencyDriftPanel;
