/**
 * ImportTile — 候选区 "+ 导入" 卡 (与已有卡同视觉勾勒, 铁律 #8 视觉一致性).
 * 2026-05-22: 加 aspectRatio prop, video 候选区 16:9, 首帧候选区 1:1 (匹配兄弟卡).
 *             视觉精简: 删底部冗余文字"+ 导入候选", 占位区直接放 upload icon + 文字.
 */
import { Icon } from "../../../components/shared/Icon";

export interface ImportTileProps {
  onClick: () => void;
  /** 占位区 aspect ratio — 默认 "1/1" 跟图候选对齐, 视频候选传 "16/9" */
  aspectRatio?: string;
}

export function ImportTile({ onClick, aspectRatio = "1/1" }: ImportTileProps) {
  return (
    // 保留原因: dashed 占位卡 (border: 1.5px dashed) — Button 组件无 dashed 变体 (规则 4),整张卡是导入入口
    <button
      type="button"
      onClick={onClick}
      style={{
        borderRadius: 7,
        border: "1.5px dashed var(--ink-250)",
        padding: 6,
        background: "transparent",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
      }}
      title="导入本地图片或视频"
    >
      <div style={{
        aspectRatio,
        borderRadius: 5,
        background: "var(--ink-50)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        color: "var(--ink-500)",
      }}>
        <Icon name="upload" size={20} />
        <span style={{ fontSize: 12, fontWeight: 600 }}>导入候选</span>
        <span style={{ fontSize: 10.5, color: "var(--ink-400)" }}>选本地图片 / 视频</span>
      </div>
    </button>
  );
}
