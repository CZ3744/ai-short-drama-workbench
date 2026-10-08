/**
 * BatchElementImageDialog — 素材库"一键补全所有素材图"弹窗.
 *
 * 用户原话 (2026-05-19):
 *   "素材库界面要有一个一键补全素材的功能, 把里面需要生图的一一按顺序生成,
 *    逻辑和之前要求过的一样, 应该可以复用+定制化修改"
 *
 * 复用而非重写:
 *   - 完全走 AutoPipelineRunner 的 element_images stage (后端 only_element_images:true)
 *   - 不引新生图路径, 不重复 brief 扫描 / typical 标记 / pushRef 等业务逻辑
 *   - UI 用 BaseDialog + ModelPicker + useAsyncAction + AutoPipelineProgressPanel
 *
 * 2026-05-20 P0 架构修复 — 铁律 #2 可干预性 + #13 含全部图片素材:
 *   一键补全 = N elements × M briefs 次付费图像调用. 启动前必须让用户审核每条
 *   brief 的完整 prompt + 自动 reference 图.
 *   - 选了图像模型后自动拉 POST /api/v2/series/:slug/elements/batch-preview-prompts
 *     展示所有 brief 列表 + 每条独立"查看完整提示词" (PromptReviewButton)
 *   - footer 处加 "查看 N 条提示词" 总入口 (拉第一条 sample 当代表)
 *
 * 流程:
 *   1. 用户选 image_provider_id (默认 lastUsedModel)
 *   2. 选完模型后自动拉所有 brief preview (前端用 details 列表展示)
 *   3. 点"开始一键补全" → 拿 series 第一个 episodeId (兜底 "ep01"), 调
 *      startAutoPipeline(slug, epId, { only_element_images: true, image_provider_id })
 *   4. 切到 AutoPipelineProgressPanel 显示进度 (该 record.stages 只含 element_images 一条)
 *   5. 完成 / 失败 / 中断 都给清晰反馈
 *
 * 注意:
 *   - element_images stage 实际上扫的是 series 全部 elements 的 image_briefs,
 *     不关心具体 episodeId. 但 startAutoPipeline 强签名要求 epId.
 *     这里用 useSeriesEpisodes 拿第一个; 没有任何 episode 时兜底 "ep01"
 *     (后端 element_images stage 不读 episode 数据, 兜底字符串不会触发 episode 不存在错误).
 */

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { BaseDialog } from "../ui/BaseDialog";
import { Icon } from "../shared/Icon";
import { ModelPicker } from "../studio/ModelPicker";
import { useAutoPipeline } from "../../hooks/useAutoPipeline";
import { AutoPipelineProgressPanel } from "../auto-pipeline/AutoPipelineProgressPanel";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { useSeriesEpisodes } from "../../hooks/useSeries";
import { listElements, type ElementData } from "../../lib/elementApi";
import { getLastUsedModel } from "../../lib/lastUsedModel";
// 2026-05-20 P0 架构修复 (铁律 #2 可干预性 + #13 含全部图片素材):
//   "一键补全"会触发 N×M 次付费图像调用 — 启动前必须让用户能审核每条 brief 的完整 prompt + reference 图.
import { PromptReviewButton, type PromptPreview } from "../shared/PromptReviewButton";
import { apiPost } from "../../lib/api";
import { Button } from "../ui/button";

export interface BatchElementImageDialogProps {
  open: boolean;
  slug: string;
  onClose: () => void;
}

export function BatchElementImageDialog({ open, slug, onClose }: BatchElementImageDialogProps) {
  const [imageModelRef, setImageModelRef] = useState<string | null>(null);
  const [elements, setElements] = useState<ElementData[]>([]);
  const [loadingElements, setLoadingElements] = useState(false);

  const pipeline = useAutoPipeline();
  const { data: epsData } = useSeriesEpisodes(slug);
  const firstEpId = useMemo(() => {
    const eps = epsData?.episodes ?? [];
    return eps[0]?.id ?? "ep01";
  }, [epsData]);

  // 2026-05-20 P0 架构修复 (铁律 #2 可干预性): 拉 batch-preview-prompts, 展示所有
  //   brief 的 prompt + 自动 reference 图, 每条单独挂"查看完整提示词".
  type BriefPreview = {
    element_id: string;
    element_kind: string;
    element_name: string;
    brief_index: number;
    angle: string;
    brief_description: string;
    full_prompt: string;
    negative_prompt?: string;
    suggested_references: Array<{ asset_id: string; url: string; label: string }>;
    already_generated: boolean;
  };
  const [briefPreviews, setBriefPreviews] = useState<BriefPreview[]>([]);
  const [loadingPreviews, setLoadingPreviews] = useState(false);
  const pendingBriefs = useMemo(
    () => briefPreviews.filter((b) => !b.already_generated),
    [briefPreviews],
  );

  // PromptReviewButton 用 — 拉第一条 pending brief 的完整 prompt 当 sample
  async function loadFirstBriefPrompt(): Promise<PromptPreview> {
    const r = await apiPost<{ briefs: BriefPreview[] }>(
      `/api/v2/series/${encodeURIComponent(slug)}/elements/batch-preview-prompts`,
      { image_provider_id: imageModelRef ?? undefined, limit: 1 },
    );
    const first = r.briefs.find((b) => !b.already_generated) ?? r.briefs[0];
    if (!first) {
      return {
        kind: "image" as const,
        full_prompt: "(尚无待生成的 brief)",
        target_provider: imageModelRef ?? undefined,
      };
    }
    return {
      kind: "image" as const,
      full_prompt: first.full_prompt,
      negative_prompt: first.negative_prompt,
      target_provider: imageModelRef ?? undefined,
      reference_images: first.suggested_references.map((r) => ({
        url: r.url,
        label: r.label,
      })),
    };
  }

  // 单 brief PromptReviewButton 用 — 拉该 brief 的完整 prompt
  function makeLoadBriefPrompt(brief: BriefPreview): () => Promise<PromptPreview> {
    return async () => ({
      kind: "image" as const,
      full_prompt: brief.full_prompt,
      negative_prompt: brief.negative_prompt,
      target_provider: imageModelRef ?? undefined,
      reference_images: brief.suggested_references.map((r) => ({
        url: r.url,
        label: r.label,
      })),
    });
  }

  // 弹窗打开时回填 lastUsed + 拉一次素材列表估算待补全数
  useEffect(() => {
    if (!open) return;
    if (!imageModelRef) {
      const last = getLastUsedModel("image");
      if (last) setImageModelRef(last);
    }
    setLoadingElements(true);
    listElements(slug)
      .then((r) => setElements(r.elements))
      .catch(() => setElements([]))
      .finally(() => setLoadingElements(false));
    // 只在 open 切换跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, slug]);

  // 2026-05-20: dialog open 且选了 model 时拉 brief-level preview, 让用户能逐条审核
  useEffect(() => {
    if (!open || !imageModelRef) {
      setBriefPreviews([]);
      return;
    }
    setLoadingPreviews(true);
    apiPost<{ briefs: BriefPreview[] }>(
      `/api/v2/series/${encodeURIComponent(slug)}/elements/batch-preview-prompts`,
      { image_provider_id: imageModelRef },
    )
      .then((r) => setBriefPreviews(r.briefs))
      .catch(() => setBriefPreviews([]))
      .finally(() => setLoadingPreviews(false));
  }, [open, slug, imageModelRef]);

  // 关闭时清状态 — 避免下次打开看到上次的 record
  function handleClose() {
    if (pipeline.pending) return;
    pipeline.reset();
    onClose();
  }

  // 统计待补全数 — 前端 ElementData 没暴露 image_briefs 字段,
  // 用「无主图」近似(没图的素材 = 大概率需补全). 真实数量后端 stage 跑时按 image_briefs 算.
  const estimatedNeedsImages = useMemo(() => {
    return elements.filter((el) => el.images.length === 0).length;
  }, [elements]);
  const totalElements = elements.length;

  const startAction = useAsyncAction(
    async () => {
      if (!imageModelRef) throw new Error("请先选图像模型");
      await pipeline.start(slug, firstEpId, {
        only_element_images: true,
        image_provider_id: imageModelRef,
      });
      toast.success("已开始一键补全, 可在下方面板看进度");
    },
    { errorMessage: "启动一键补全失败" },
  );

  const canStart = !!imageModelRef && !pipeline.record;

  return (
    <BaseDialog
      open={open}
      onClose={handleClose}
      title="一键补全所有素材图"
      subtitle="为还没生成参考图的素材自动按顺序补全"
      iconName="sparkles"
      maxWidth={620}
      busy={pipeline.pending && !pipeline.record}
      ariaLabel="一键补全所有素材图"
      footer={
        !pipeline.record ? (
          <div style={{ display: "flex", gap: 8, marginLeft: "auto", flexWrap: "wrap", alignItems: "center" }}>
            {/* 2026-05-20 P0 架构修复 (铁律 #2): 启动前可查看完整提示词.
                每条 brief 一条独立 prompt — modal 第一条作 sample, 用户改了不会真发,
                但能看到 N 条 prompt 整体长啥样 + 复制走外部 AI 自己生再 manual import. */}
            <PromptReviewButton
              label={`查看 ${estimatedNeedsImages > 0 ? estimatedNeedsImages : totalElements} 条提示词`}
              size="sm"
              disabled={!imageModelRef || totalElements === 0}
              loadPrompt={loadFirstBriefPrompt}
              title="一键补全将逐 brief 发送, 这是第一条 sample. 完整列表见下方"
            />
            <Button variant="ghost" onClick={handleClose} disabled={startAction.busy}>
              取消
            </Button>
            <Button
              variant="primary"
              iconLeft="sparkles"
              loading={startAction.busy}
              onClick={() => startAction.run()}
              disabled={!canStart || startAction.busy}
            >
              {startAction.busy ? "启动中…" : "开始一键补全"}
            </Button>
          </div>
        ) : null
      }
    >
      {!pipeline.record ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* 图像模型选 */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-800)" }}>
              图像模型 <span style={{ color: "var(--err)" }}>*</span>
            </label>
            <ModelPicker
              kind="image"
              value={imageModelRef}
              onChange={setImageModelRef}
              placeholder="选图像模型…"
              size="md"
            />
            <div style={{ fontSize: 11, color: "var(--ink-500)" }}>
              {/* 2026-05-19 toC 文案: 改自 "所有 image_briefs 用同一个图像模型生成" — 用户原话"所有地方的表述要 toC" */}
              所有素材统一用这个图像模型, 保持视觉风格一致.
            </div>
          </div>

          {/* 待补全统计 */}
          <div
            className="mk-card"
            style={{
              padding: 14,
              background: "var(--ink-50)",
              border: "1px solid var(--ink-200)",
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-900)", marginBottom: 6 }}>
              待补全统计 (预估)
            </div>
            {loadingElements ? (
              <div style={{ fontSize: 12, color: "var(--ink-500)" }}>读取素材中…</div>
            ) : totalElements === 0 ? (
              <div style={{ fontSize: 12, color: "var(--ink-500)" }}>
                这部剧暂无素材. 请先新建素材或从剧本一键生成.
              </div>
            ) : (
              <>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--ink-700)" }}>
                  <li>
                    项目内共 <strong>{totalElements}</strong> 个素材
                  </li>
                  <li>
                    其中约 <strong>{estimatedNeedsImages}</strong> 个还没有任何图片
                  </li>
                  <li>
                    {/* 2026-05-19 toC 文案: 改自 "系统会按 LLM 规划的 image_briefs 顺序生图" — 用户原话"所有地方的表述要 toC" */}
                    系统自动检测还需要补几张, 已生成的会跳过
                  </li>
                  <li>
                    第 2+ 张自动用前一张「典型代表图」作 i2i 参考, 保持五官 / 风格一致
                  </li>
                </ul>
              </>
            )}
          </div>

          {/* 2026-05-20 P0 架构修复 (铁律 #2 可干预性 + #13 含图片素材):
              逐 brief 列表 + 每条独立"查看完整提示词". 启动前必须能审核每个调用. */}
          {imageModelRef && totalElements > 0 && (
            <details
              style={{
                padding: 12,
                borderRadius: 8,
                border: "1px solid var(--brand-200)",
                background: "var(--brand-25, rgba(217,119,87,0.04))",
              }}
            >
              <summary
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--brand-700)",
                  cursor: "pointer",
                }}
              >
                <Icon name="doc" size={12} /> 逐条审核所有 brief 提示词 (
                {loadingPreviews ? "加载中…" : `${pendingBriefs.length} 条待生成 / 共 ${briefPreviews.length} 条`}
                )
              </summary>
              <div
                style={{
                  marginTop: 10,
                  fontSize: 12,
                  color: "var(--ink-600)",
                  lineHeight: 1.5,
                }}
              >
                每条 brief 是 1 次图像调用. 启动前可逐条审核 prompt + reference 图, 也能复制走外部 AI 自己生.
              </div>
              <div
                style={{
                  marginTop: 12,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  maxHeight: 320,
                  overflow: "auto",
                }}
              >
                {briefPreviews.length === 0 && !loadingPreviews && (
                  <div style={{ fontSize: 11.5, color: "var(--ink-400)", padding: 8 }}>
                    暂无 brief — 请先在素材库里给每个素材规划"分镜图概念"
                  </div>
                )}
                {briefPreviews.slice(0, 50).map((b) => (
                  <div
                    key={`${b.element_id}:${b.brief_index}`}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 10px",
                      borderRadius: 6,
                      background: b.already_generated ? "var(--ink-50)" : "white",
                      border: "1px solid var(--ink-100)",
                      opacity: b.already_generated ? 0.55 : 1,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-800)" }}>
                        {b.element_name}
                        <span style={{ color: "var(--ink-400)", fontWeight: 400 }}>
                          {" · "}{b.angle}
                          {b.already_generated && " · 已生成"}
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: "var(--ink-500)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={b.brief_description}
                      >
                        {b.brief_description.slice(0, 80)}
                        {b.brief_description.length > 80 ? "…" : ""}
                      </div>
                    </div>
                    {!b.already_generated && (
                      <PromptReviewButton
                        size="sm"
                        label="查看"
                        loadPrompt={makeLoadBriefPrompt(b)}
                        title={`审核 ${b.element_name} - ${b.angle} 的完整提示词`}
                      />
                    )}
                  </div>
                ))}
                {briefPreviews.length > 50 && (
                  <div style={{ fontSize: 11, color: "var(--ink-400)", padding: 6 }}>
                    … 还有 {briefPreviews.length - 50} 条 (太长不全列, 启动后在进度面板看每条结果)
                  </div>
                )}
              </div>
            </details>
          )}

          <div
            style={{
              fontSize: 11,
              color: "var(--ink-500)",
              padding: "8px 12px",
              background: "var(--brand-50, #fef3c7)",
              borderRadius: 6,
              border: "1px solid var(--ink-200)",
            }}
          >
            提示: 只跑「生成素材图」阶段, 不会下推到首帧 / 视频 / 合成. 跑完可在素材库看新图.
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <AutoPipelineProgressPanel
            record={pipeline.record}
            pending={pipeline.pending}
            onAbort={() => void pipeline.abort()}
            // 2026-05-19 反馈 #2: 透传 opts 让"重试失败的 N 项"只重抽失败子集
            onRetryStage={(stage, opts) => void pipeline.retryStage(stage, opts)}
            // 2026-05-19 #A: only_element_images 模式完成后,点"查看素材库" = 关本弹窗 (ElementListPage 已在原位置 + onClose 触发 refresh)
            onJumpToElements={handleClose}
            onClose={handleClose}
          />
          {pipeline.record.status === "done" && (
            <div
              style={{
                padding: "10px 12px",
                background: "var(--ok-50, #ecfdf5)",
                border: "1px solid var(--ok, #10b981)",
                borderRadius: 8,
                fontSize: 12.5,
                color: "var(--ok, #047857)",
              }}
            >
              已完成. 关闭此对话框, 在素材库列表查看新图.
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Button variant="secondary" onClick={handleClose} disabled={pipeline.pending}>
              关闭
            </Button>
          </div>
        </div>
      )}
    </BaseDialog>
  );
}
