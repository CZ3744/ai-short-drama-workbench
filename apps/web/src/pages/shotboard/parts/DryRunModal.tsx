// 拆自 ShotboardPage.tsx — 批量执行 dry-run 弹窗.
// 主页面在 batchDryRun 拿到 BatchDryRunResult 后 setDryRun 弹出本组件.
// 内容: 标题 + 预估耗时/成本 + 预警列表 + 逐镜 PromptReviewButton + 取消/确认.
//
// V-15: video 用 previewShotPrompt, firstframe 用 previewFirstFramePrompt — 这里保留原逻辑。
import { Button } from "../../../components/ui/button";
import { Icon } from "../../../components/shared/Icon";
import { PromptReviewButton, type PromptPreview } from "../../../components/shared/PromptReviewButton";
import { previewFirstFramePrompt, previewShotPrompt, type BatchDryRunResult } from "../../../lib/shotApi";
import type { Shot } from "../../../hooks/useShots";
import { shotText } from "./ShotCard";

export function DryRunModal({
  dryRun,
  selectedIds,
  selectedCount,
  orderedShots,
  onCancel,
  onConfirm,
}: {
  dryRun: { action: "firstframe" | "video"; result: BatchDryRunResult };
  selectedIds: Set<string>;
  selectedCount: number;
  orderedShots: Shot[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dryRunWarnings = dryRun.result.per_target.flatMap((target) =>
    (target.warnings ?? []).map((warning) => ({ sid: target.sid, warning })),
  );

  return (
    <div
      role="presentation"
      onClick={onCancel}
      style={{
        position: "fixed", inset: 0, zIndex: 60,
        display: "grid", placeItems: "center", padding: 24,
        background: "rgba(40, 30, 24, 0.32)",
      }}
    >
      <div
        className="mk-card"
        role="dialog"
        aria-modal="true"
        aria-label="批量执行预览"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(420px, calc(100vw - 32px))", borderRadius: 14, padding: 20, boxShadow: "var(--shadow-xl)" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <div style={{ width: 34, height: 34, borderRadius: 10, background: "var(--brand-50)", display: "grid", placeItems: "center", color: "var(--brand-700)" }}>
            <Icon name={dryRun.action === "firstframe" ? "sparkles" : "video"} size={16} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 750, color: "var(--ink-900)" }}>
              将对 {selectedCount} 个分镜批量{dryRun.action === "firstframe" ? "抽首帧" : "抽视频"}
            </div>
            <div style={{ marginTop: 3, fontSize: 12, color: "var(--ink-500)" }}>
              预计耗时 {dryRun.result.total_estimated_duration_s}s · 预计 ¥{dryRun.result.total_estimated_cost_cny}
            </div>
          </div>
        </div>

        {dryRunWarnings.length > 0 && (
          <div style={{ marginTop: 12, padding: 12, borderRadius: 10, border: "1px solid var(--ink-100)", background: "var(--ink-50)" }}>
            <div className="mk-label" style={{ marginBottom: 6 }}>预警</div>
            <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, lineHeight: 1.55, color: "var(--ink-700)" }}>
              {dryRunWarnings.map((item) => {
                const shot = orderedShots.find((s) => s.id === item.sid);
                const shotLabel = shot?.index ? `第 ${shot.index} 镜` : "某镜";
                return (
                  <li key={`${item.sid}:${item.warning}`}>{shotLabel}: {item.warning}</li>
                );
              })}
            </ul>
          </div>
        )}

        {/* 铁律 #2: 批量生成前逐镜审核提示词 — 弹窗内直接列 PromptReviewButton,
            不让用户跳走到另一页 (铁律 #2 + #13: review 含 reference 图).
            image 和 video 都需要审核, video 尤其重要 (付费 provider). */}
        <div style={{ marginTop: 12, padding: 12, borderRadius: 10, border: "1px solid var(--brand-200)", background: "var(--brand-25, rgba(217,119,87,0.04))" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--brand-700)", marginBottom: 8 }}>
            <Icon name="doc" size={12} /> 逐镜审核提示词 — 可改可复制，不跳页 ({selectedCount} 镜)
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflow: "auto" }}>
            {Array.from(selectedIds).map((sid) => {
              const shot = orderedShots.find((s) => s.id === sid);
              const shotLabel = shot?.index ? `第 ${shot.index} 镜` : "分镜";
              const preview = shotText(shot ?? { id: sid } as typeof orderedShots[0]).slice(0, 50);
              return (
                <div
                  key={sid}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}
                >
                  <span style={{ fontSize: 11.5, color: "var(--ink-700)", minWidth: 56, flexShrink: 0, fontWeight: 600 }}>
                    {shotLabel}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--ink-500)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {preview}
                  </span>
                  <PromptReviewButton
                    size="sm"
                    label="审核提示词"
                    loadPrompt={async (): Promise<PromptPreview> => {
                      // V-15: video 用 previewShotPrompt, firstframe 用 previewFirstFramePrompt
                      if (dryRun.action === "video") {
                        const p = await previewShotPrompt(sid, "video");
                        return {
                          kind: "video",
                          full_prompt: p.composed_prompt,
                          target_provider: p.video_model_ref ?? p.image_model_ref ?? undefined,
                          // 2026-05-26 audit #4: 删 r.asset_id (ULID 给用户看是技术字段, 铁律 #9). 缺 label → 直接 "参考图".
                          reference_images: p.suggested_references?.map((r) => ({
                            url: r.url,
                            label: r.label ?? "参考图",
                          })) ?? [],
                        };
                      }
                      const p = await previewFirstFramePrompt(sid);
                      return {
                        kind: "image",
                        full_prompt: p.composed_prompt,
                        target_provider: p.image_model_ref ?? undefined,
                        // 2026-05-26 audit #4: 同上, 删 r.asset_id (ULID 不该暴露).
                        reference_images: p.suggested_references?.map((r) => ({
                          url: r.url,
                          label: r.label ?? "参考图",
                        })) ?? [],
                      };
                    }}
                  />
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
          <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
          <Button variant="primary" size="sm" onClick={onConfirm}>
            确认执行
          </Button>
        </div>
      </div>
    </div>
  );
}
