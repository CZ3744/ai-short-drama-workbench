import { useEffect, useMemo, useState } from "react";
import { ApiError } from "../../lib/api";
import { labelOfSource } from "../../lib/sourceLabels";
import type { VideoDryRunResult } from "../../lib/shotApi";
import { Icon } from "../shared/Icon";
import { Button } from "../ui/button";
import { BaseDialog } from "../ui/BaseDialog";
import { ComposeBox } from "./ComposeBox";

export interface VideoRegenModalProps {
  open: boolean;
  projectSlug: string;
  sourceVideoUrl: string;
  sourceLabel?: string;
  sourceGenerationId: string;
  modelRef: string | null;
  onModelRefChange: (v: string | null) => void;
  durationSec: number;
  defaultExtra?: string;
  busy?: boolean;
  onDryRun: (extra: string, modelRef: string | null) => Promise<VideoDryRunResult>;
  onConfirm: (extra: string) => Promise<void>;
  onClose: () => void;
}

export function VideoRegenModal(props: VideoRegenModalProps) {
  const {
    open,
    projectSlug,
    sourceVideoUrl,
    sourceLabel,
    sourceGenerationId,
    modelRef,
    onModelRefChange,
    durationSec,
    defaultExtra = "",
    busy = false,
    onDryRun,
    onConfirm,
    onClose,
  } = props;

  const [extra, setExtra] = useState(defaultExtra);
  const [preview, setPreview] = useState<VideoDryRunResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setExtra(defaultExtra);
    setPreview(null);
    setError(null);
    setPreviewing(false);
  }, [defaultExtra, open, sourceGenerationId]);

  useEffect(() => {
    setPreview(null);
    setError(null);
  }, [extra, modelRef, durationSec, sourceGenerationId]);

  const providerLabel = useMemo(() => {
    if (preview?.provider_id) return labelOfSource(preview.provider_id);
    return sourceLabel ?? "候选视频";
  }, [preview?.provider_id, sourceLabel]);

  const previewPrompt = useMemo(() => {
    const raw = preview?.request_preview?.prompt;
    return typeof raw === "string" ? raw : "";
  }, [preview?.request_preview]);

  async function handlePreview() {
    if (!modelRef || previewing || busy) return;
    setPreviewing(true);
    setError(null);
    try {
      const result = await onDryRun(extra, modelRef);
      setPreview(result);
    } catch (err) {
      if (err instanceof ApiError && err.message === "key_missing") {
        setError("这个视频模型还没有配置 Key，请先到设置页填好账号后再重抽。");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
      setPreview(null);
    } finally {
      setPreviewing(false);
    }
  }

  async function handleConfirm() {
    if (!preview?.ok || busy || previewing) return;
    await onConfirm(extra);
  }

  const canConfirm = !!preview?.ok && !preview.real_lock_held_by && !busy && !previewing;
  const costText = preview?.estimated_cost_cny == null
    ? "费用未知"
    : `约 ¥${preview.estimated_cost_cny.toFixed(2)}`;

  return (
    <BaseDialog
      open={open}
      onClose={onClose}
      title="用此视频微调"
      subtitle="先参考源视频抽一帧，再新增一条视频候选；原视频不会被覆盖。"
      iconName="video"
      maxWidth={920}
      busy={busy || previewing}
      footerLeft={preview ? (
        <span style={{ fontSize: 12, color: "var(--ink-500)" }}>
          {preview.is_real_provider ? `真实视频 · ${costText}` : "本地/演示模型 · 不扣费"}
        </span>
      ) : null}
      footer={(
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={busy || previewing}
          >
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            iconLeft="sparkles"
            onClick={handleConfirm}
            disabled={!canConfirm}
            loading={busy}
            title={preview ? "确认后会新增一条视频候选" : "请先预览费用和请求内容"}
          >
            {busy ? "已提交..." : "确认重抽视频"}
          </Button>
        </>
      )}
      ariaLabel="用此视频微调弹窗"
    >
      <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 0.9fr) minmax(320px, 1.1fr)", gap: 18 }}>
        <section>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--ink-800)", marginBottom: 8 }}>
            源视频
          </div>
          <div style={{ borderRadius: 12, overflow: "hidden", border: "1px solid var(--ink-100)", background: "var(--ink-900)" }}>
            {sourceVideoUrl ? (
              <video
                src={sourceVideoUrl}
                controls
                muted
                playsInline
                style={{ display: "block", width: "100%", aspectRatio: "16 / 9", objectFit: "contain", background: "#000" }}
              />
            ) : (
              <div style={{ aspectRatio: "16 / 9", display: "grid", placeItems: "center", color: "var(--ink-300)" }}>
                <Icon name="video" size={22} />
              </div>
            )}
          </div>
          <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--ink-500)" }}>
            <Icon name="spark" size={12} />
            <span>{sourceLabel ?? "视频候选"}</span>
          </div>
        </section>

        <section>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--ink-800)" }}>
            微调意见
          </div>
          <ComposeBox
            kind="video"
            slug={projectSlug}
            value={extra}
            onChange={setExtra}
            modelRef={modelRef}
            onModelChange={onModelRefChange}
            count={1}
            onCountChange={() => undefined}
            countPresets={[1]}
            busy={previewing || busy}
            busyLabel={previewing ? "预览中..." : "生成中..."}
            drawLabel="预览费用"
            placeholder="写你想保留或改变的地方。例如:保留镜头运动,表情更克制,结尾停顿半秒。输入 @ 可补充参考素材。"
            onDraw={handlePreview}
          />

          {error ? (
            <div style={{ marginTop: 12, borderRadius: 10, border: "1px solid rgba(220,38,38,0.28)", background: "rgba(220,38,38,0.06)", padding: 10, fontSize: 12, color: "#991b1b" }}>
              <Icon name="warning" size={12} /> {error}
            </div>
          ) : null}

          {preview ? (
            <div style={{ marginTop: 12, borderRadius: 12, border: "1px solid var(--ink-120, var(--ink-100))", background: "var(--ink-50)", padding: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12 }}>
                <span className="mk-pill mk-pill--info">
                  <Icon name="coin" size={11} /> {costText}
                </span>
                <span className="mk-pill">
                  <Icon name="video" size={11} /> {providerLabel}
                </span>
                {preview.will_acquire_real_lock ? (
                  <span className="mk-pill mk-pill--warning">
                    <Icon name="lock" size={11} /> 会占用真实视频锁
                  </span>
                ) : null}
              </div>
              {preview.real_lock_held_by ? (
                <div style={{ marginTop: 10, fontSize: 12, color: "#92400e" }}>
                  当前已有真实视频任务在跑，请等它完成后再提交。
                </div>
              ) : null}
              {/* 2026-05-20 Wave T 留尾 — 抽帧动作透明化(铁律 #13 完整提示词审核必含全部图片).
                  VideoRegenModal 左侧已显示源视频 <video>,这里 preview 区显式提示
                  "将自动抽源视频第一帧作 i2v 首帧",避免用户疑惑"我没选首帧怎么有 has_first_frame_ref" */}
              {preview.request_preview?.source_video_generation_id ? (
                <div style={{
                  marginTop: 10,
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  padding: "8px 10px",
                  background: "rgba(217,119,87,0.06)",
                  border: "1px solid rgba(217,119,87,0.18)",
                  borderRadius: 8,
                  fontSize: 11.5,
                  lineHeight: 1.5,
                  color: "var(--ink-700)",
                }}>
                  <Icon name="image" size={12} style={{ marginTop: 2, color: "var(--brand-700)" }} />
                  <span>
                    <strong style={{ color: "var(--brand-700)" }}>i2v 参考首帧</strong>:
                    提交后会自动抽取左侧源视频第一帧作首帧锚定喂给 {providerLabel}。
                    源视频本身已展示,模型会沿用首帧主体在镜头里演化运动。
                  </span>
                </div>
              ) : null}
              {previewPrompt ? (
                <pre style={{
                  margin: "10px 0 0",
                  maxHeight: 128,
                  overflow: "auto",
                  whiteSpace: "pre-wrap",
                  fontFamily: "inherit",
                  fontSize: 11.5,
                  lineHeight: 1.55,
                  color: "var(--ink-700)",
                }}>{previewPrompt}</pre>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>
    </BaseDialog>
  );
}

export default VideoRegenModal;
