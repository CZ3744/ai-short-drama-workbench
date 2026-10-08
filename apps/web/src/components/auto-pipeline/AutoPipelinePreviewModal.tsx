/**
 * AutoPipelinePreviewModal — 一键自动生成全集 "发送前查看完整提示词" 弹窗 (2026-05-20).
 *
 * 用户场景:
 *   AutoPipelineLauncher 启动一次 = N elements × briefs + M shots × frames + V shots × videos + 1 compose.
 *   "一点就是 N×M 次付费调用" 是最危险的失控点之一 (P0 架构修复 #1).
 *   启动前用户必须能看每个 stage 的样本 prompt + reference 图 + 调用数量预估.
 *
 * 与 PromptReviewButton 区别:
 *   - PromptReviewButton 适合单条 prompt review (一次发一条).
 *   - 本 modal 是 stage-aware 多 prompt 列表: 每 stage 标题 + 数量 + 前 5 个 sample
 *     (每个 sample 都挂自己的 review button 看完整 prompt + reference).
 *
 * 铁律 #13 (含全部图片素材):
 *   - 每个 sample 都带 suggested_references[] (url + label)
 *   - 复用 PromptReviewButton 渲染 sample, 那个组件自动渲染 reference 图缩略图
 *
 * 数据来源:
 *   POST /api/v2/series/:slug/episodes/:epId/auto-pipeline/preview-prompts
 */

import { useEffect, useState } from "react";
import { Icon } from "../shared/Icon";
import { BaseDialog } from "../ui/BaseDialog";
import { PromptReviewButton, type PromptPreview } from "../shared/PromptReviewButton";
import { apiPost } from "../../lib/api";
import { translateError } from "../../lib/errorTranslate";
import { Button } from "../ui/button";

// ─── 后端 response 契约 (对齐 batchPreviewPrompts.ts) ───

interface SuggestedReference {
  asset_id: string;
  url: string;
  thumbnail_url?: string;
  label: string;
}

interface BriefSample {
  element_id: string;
  element_kind: string;
  element_name: string;
  brief_index: number;
  angle: string;
  brief_description: string;
  full_prompt: string;
  negative_prompt?: string;
  suggested_references: SuggestedReference[];
  already_generated: boolean;
}

interface ShotSample {
  shot_id: string;
  shot_index: number;
  shot_title: string;
  full_prompt: string;
  negative_prompt?: string;
  suggested_references: SuggestedReference[];
}

type StageSample = BriefSample | ShotSample;

interface StagePreview {
  stage: "element_images" | "firstframes" | "videos" | "compose";
  total_calls: number;
  will_skip: boolean;
  skip_reason?: string;
  target_provider?: string;
  samples: StageSample[];
}

interface PreviewResult {
  slug: string;
  episode_id: string;
  total_calls_estimate: number;
  stages: StagePreview[];
}

// ─── Props ───

export interface AutoPipelinePreviewModalProps {
  open: boolean;
  onClose: () => void;
  slug: string;
  epId: string;
  options: {
    image_provider_id?: string;
    video_provider_id?: string;
    image_count_per_shot?: number;
    video_count_per_shot?: number;
    only_element_images?: boolean;
    only_firstframes?: boolean;
    skip_element_images?: boolean;
  };
}

// ─── 工具 ───

// toC 翻 stage 名 (铁律 #9)
const STAGE_LABEL: Record<StagePreview["stage"], string> = {
  element_images: "1. 为每个素材抽参考图",
  firstframes: "2. 为每个分镜抽首帧",
  videos: "3. 用首帧锚生视频",
  compose: "4. 自动合成成片",
};

function isBriefSample(s: StageSample): s is BriefSample {
  return "element_id" in s;
}

// ─── 主组件 ───

export function AutoPipelinePreviewModal(props: AutoPipelinePreviewModalProps) {
  const { open, onClose, slug, epId, options } = props;
  const [data, setData] = useState<PreviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setData(null);
    apiPost<PreviewResult>(
      `/api/v2/series/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(epId)}/auto-pipeline/preview-prompts`,
      options,
    )
      .then((r) => setData(r))
      // 2026-05-28 P1-7: 走 translateError 把后端技术 message 翻译成用户能懂的中文 +
      // scrub 一遍密钥. 之前直接 e.message 把 "AllProvidersFailed" 这种代码扔到弹窗.
      .catch((e) => setError(translateError(e)))
      .finally(() => setLoading(false));
  }, [open, slug, epId, JSON.stringify(options)]);

  if (!open) return null;

  return (
    <BaseDialog
      open={open}
      onClose={onClose}
      iconName="eye"
      title="启动前审核每阶段提示词"
      ariaLabel="启动前审核每阶段提示词"
      maxWidth={760}
      zIndex={220}
      footer={
        <Button variant="secondary" onClick={onClose}>
          返回继续配置
        </Button>
      }
    >
        <p style={{ fontSize: 12, color: "var(--ink-500)", marginTop: 0, marginBottom: 14 }}>
          一键自动生成会按顺序触发以下阶段, 每阶段下方列出前几个 sample prompt 让你审核.
          想改某条? 点对应"查看完整提示词" → 可复制 / 修改 / 单独走外部 AI 后导入.
        </p>

        {loading && (
          <div style={{ color: "var(--ink-500)", fontSize: 13, padding: 20, textAlign: "center" }}>
            正在加载各阶段 sample prompt…
          </div>
        )}

        {error && (
          <div
            style={{
              color: "var(--err)",
              fontSize: 13,
              padding: 12,
              background: "var(--err-50, #fef2f2)",
              borderRadius: 6,
            }}
          >
            拉取预览失败: {error}
          </div>
        )}

        {data && (
          <>
            {/* 全集调用数总览 */}
            <div
              style={{
                marginBottom: 16,
                padding: 12,
                borderRadius: 8,
                background: "var(--brand-50, rgba(217,119,87,0.06))",
                border: "1px solid var(--brand-200)",
                fontSize: 13,
                color: "var(--brand-700)",
              }}
            >
              <strong>预计共 {data.total_calls_estimate} 次调用</strong>
              <span style={{ color: "var(--ink-600)", marginLeft: 8 }}>
                (各阶段累加 — 付费 provider 按次计费, 建议先审核样本)
              </span>
            </div>

            {/* 各 stage 列 */}
            {data.stages.map((s) => (
              <StageBlock key={s.stage} stage={s} providerId={options.image_provider_id} />
            ))}
          </>
        )}
    </BaseDialog>
  );
}

// ─── 单 stage 块 ───

function StageBlock({ stage, providerId }: { stage: StagePreview; providerId?: string }) {
  return (
    <div
      style={{
        marginBottom: 14,
        padding: 12,
        borderRadius: 8,
        border: "1px solid var(--ink-200)",
        background: stage.will_skip ? "var(--ink-50)" : "white",
        opacity: stage.will_skip ? 0.7 : 1,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ink-900)" }}>
          {STAGE_LABEL[stage.stage]}
        </div>
        <div style={{ fontSize: 12, color: "var(--ink-600)" }}>
          {stage.will_skip ? (
            <span style={{ color: "var(--ink-400)" }}>跳过 — {stage.skip_reason}</span>
          ) : (
            <>
              <strong>{stage.total_calls}</strong> 次调用
              {stage.target_provider && (
                <span style={{ color: "var(--ink-400)", marginLeft: 6 }}>
                  · {stage.target_provider}
                </span>
              )}
            </>
          )}
        </div>
      </div>

      {!stage.will_skip && stage.samples.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {stage.samples.map((sample, idx) => (
            <SampleRow
              key={
                isBriefSample(sample)
                  ? `${sample.element_id}:${sample.brief_index}`
                  : sample.shot_id
              }
              sample={sample}
              index={idx + 1}
              providerId={providerId}
            />
          ))}
          {stage.total_calls > stage.samples.length && (
            <div style={{ fontSize: 11, color: "var(--ink-400)", padding: "4px 8px" }}>
              … 还有 {stage.total_calls - stage.samples.length} 次调用 (启动后在进度面板看完整列表)
            </div>
          )}
        </div>
      )}

      {!stage.will_skip && stage.samples.length === 0 && stage.stage === "compose" && (
        <div style={{ fontSize: 11.5, color: "var(--ink-500)", padding: 6 }}>
          合成阶段在本地用 ffmpeg 拼接, 不调付费 provider — 无 prompt 可预览.
        </div>
      )}
    </div>
  );
}

// ─── 单 sample 行 ───

function SampleRow({
  sample,
  index,
  providerId,
}: {
  sample: StageSample;
  index: number;
  providerId?: string;
}) {
  // 复用 PromptReviewButton — 它自带 reference 图缩略图 + "复制全部含图" 入口 (铁律 #13)
  const loadPrompt = async (): Promise<PromptPreview> => ({
    kind: isBriefSample(sample) ? "image" : "video",
    full_prompt: sample.full_prompt,
    negative_prompt: sample.negative_prompt,
    target_provider: providerId,
    reference_images: sample.suggested_references.map((r) => ({
      url: r.url,
      label: r.label,
    })),
  });

  const title = isBriefSample(sample)
    ? `${sample.element_name} · ${sample.angle}`
    : `第 ${sample.shot_index} 镜 · ${sample.shot_title}`;
  const desc = isBriefSample(sample)
    ? sample.brief_description
    : sample.full_prompt.slice(0, 100);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: "6px 10px",
        borderRadius: 6,
        background: "var(--ink-25, #fafaf9)",
        border: "1px solid var(--ink-100)",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-800)" }}>
          <span style={{ color: "var(--ink-400)" }}>#{index}</span> {title}
        </div>
        <div
          style={{
            fontSize: 11,
            color: "var(--ink-500)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={desc}
        >
          {desc.slice(0, 80)}
          {desc.length > 80 ? "…" : ""}
        </div>
      </div>
      <PromptReviewButton
        size="sm"
        label="查看完整"
        loadPrompt={loadPrompt}
        title={`审核 ${title} 的完整提示词`}
      />
    </div>
  );
}

export default AutoPipelinePreviewModal;
