// 拆自 ShotboardPage.tsx — 批量操作底栏(T4).
// 用户勾选了 N 个分镜后, 底部 sticky 出现: 批量重抽首帧 / 批量真实生成视频 / 批量删除 / 取消选择.
//
// 主页面控制是否渲染(selectedCount > 0 && !pickerMode), 这里只负责 UI + 透传回调。
import { Button } from "../../components/ui/button";

export function BulkActionBar({
  selectedCount,
  onBatchDryRunFirstframe,
  onBatchDryRunVideo,
  onBatchAppendPrompt,
  onBatchDelete,
  onClearSelect,
}: {
  selectedCount: number;
  onBatchDryRunFirstframe: () => void;
  onBatchDryRunVideo: () => void;
  /** 2026-05-25 C2 批量操作扩展: 批量给所有 selected shot 的画面描述 prompt_img 追加同款后缀 */
  onBatchAppendPrompt?: () => void;
  onBatchDelete: () => void;
  onClearSelect: () => void;
}) {
  return (
    <div
      style={{
        position: "sticky",
        bottom: 0,
        zIndex: 30,
        margin: "18px -24px -28px",
        padding: "12px 24px",
        background: "var(--surface-card)",
        borderTop: "1px solid var(--ink-100)",
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 700, color: "var(--ink-900)" }}>已选 {selectedCount} 镜</span>
      <span style={{ flex: 1 }} />
      {onBatchAppendPrompt && (
        <Button variant="secondary" size="sm" iconLeft="edit" onClick={onBatchAppendPrompt} title="给选中所有分镜的画面描述追加同款文字 (例: 电影感胶片质感)">
          批量加描述
        </Button>
      )}
      <Button variant="secondary" size="sm" iconLeft="sparkles" onClick={onBatchDryRunFirstframe}>
        批量重抽首帧
      </Button>
      <Button
        variant="secondary"
        size="sm"
        iconLeft="video"
        onClick={onBatchDryRunVideo}
        title="可能触发真实 provider，会有二次确认"
        style={{ background: "var(--warn, #d97706)", color: "#fff", borderColor: "var(--warn, #d97706)" }}
      >
        批量真实生成视频
      </Button>
      <Button
        variant="danger"
        size="sm"
        iconLeft="trash"
        onClick={onBatchDelete}
      >
        批量删除
      </Button>
      <Button variant="ghost" size="sm" onClick={onClearSelect}>取消选择</Button>
    </div>
  );
}
