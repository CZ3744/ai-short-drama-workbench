/**
 * WaitingModelTile — "等待选模型" 占位卡 (用户点抽卡但没选模型时, 在候选区第一格显示).
 *   铁律 #10 优雅空状态 + 铁律 #4 就近决策: ModelPicker 嵌入卡内, 选好就能立即继续抽
 *
 * 视觉零变更. 从 ShotStagePage 拆出 (P2 #16).
 */
import { Icon } from "../../../components/shared/Icon";
import { Button } from "../../../components/ui/button";
import { ModelPicker } from "../../../components/studio/ModelPicker";

export function WaitingModelTile({
  modelRef, onModelRefChange, onDraw, kind = "image", aspectRatio,
}: {
  modelRef: string | null;
  onModelRefChange: (v: string | null) => void;
  onDraw: () => void;
  kind?: "image" | "video";
  /** 2026-05-22: 跟剧本身 aspect 一致, fallback 按 kind */
  aspectRatio?: string;
}) {
  const finalAspect = aspectRatio ?? (kind === "video" ? "16/9" : "1/1");
  return (
    <div
      style={{
        borderRadius: 7,
        border: "1.5px dashed rgba(245,158,11,0.7)",
        padding: 8,
        background: "rgba(254,243,199,0.35)",
        position: "relative",
      }}
    >
      <div style={{
        aspectRatio: finalAspect,
        borderRadius: 5,
        background: "var(--surface-card)",
        border: "1px dashed var(--ink-200)",
        display: "grid", placeItems: "center",
        padding: 12,
      }}>
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center", gap: 8,
          textAlign: "center",
        }}>
          <Icon name="warning" size={20} style={{ color: "rgba(217,119,6,0.95)" }} />
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--ink-900)" }}>
            还差一步: 选个{kind === "video" ? "生视频" : "生图"}模型
          </span>
          <span style={{ fontSize: 11, color: "var(--ink-600)" }}>
            选好模型后,这里会变成"准备就绪",点下方"开始抽卡"
          </span>
        </div>
      </div>
      <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 5 }}>
        <ModelPicker
          kind={kind}
          value={modelRef}
          onChange={onModelRefChange}
          size="sm"
          placeholder={kind === "video" ? "选择生视频模型" : "选择生图模型"}
        />
        <Button
          variant="primary"
          size="xs"
          iconLeft="sparkles"
          onClick={onDraw}
          disabled={!modelRef}
          title={modelRef ? "开始抽卡" : "请先选择模型"}
        >
          {modelRef ? "开始抽卡" : "请先选择模型"}
        </Button>
      </div>
    </div>
  );
}
