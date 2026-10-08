/**
 * ElementPasteAutofillDialog — 粘贴外部 AI 返回的 JSON 字段对话框.
 *
 * 用户原话(2026-05-19 反馈 #2):
 *   "也要允许用户复制完整提示词, 然后手动导入外部 ai 返回的数据, 和之前你做的导入功能类似"
 *
 * 与 PasteStoryboardDialog 同款轻量 textarea + parse + 自动关闭. UX 铁律 #11.
 *
 * 从 ElementWorkbench 拆出(Wave P2 解耦). 视觉零变更.
 *
 * 2026-07-09 终验(dialog-interaction): 之前手写 position:fixed 弹窗只有点遮罩关, 没有
 * ESC 监听, 与项目其余弹窗(已迁 BaseDialog 的 PromoteFromSeriesDialog 等)行为不一致。
 * 迁到 BaseDialog 后自动获得 ESC 关闭 / 背景滚动锁 / 统一外壳, 视觉基本不变(同宽 560px)。
 */

import { BaseDialog } from "../../../components/ui/BaseDialog";
import { Button } from "../../../components/ui/button";
import { Textarea } from "../../../components/ui/textarea";

interface Props {
  open: boolean;
  text: string;
  onTextChange: (next: string) => void;
  onConfirm: () => void;
  onClose: () => void;
}

export function ElementPasteAutofillDialog({
  open,
  text,
  onTextChange,
  onConfirm,
  onClose,
}: Props) {
  return (
    <BaseDialog
      open={open}
      onClose={onClose}
      title="导入外部 AI 返回的字段 JSON"
      ariaLabel="导入外部 AI 返回的字段 JSON"
      maxWidth={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" iconLeft="check" disabled={!text.trim()} onClick={onConfirm}>
            解析并填字段
          </Button>
        </>
      }
    >
      <p style={{ fontSize: 12, color: "var(--ink-500)", marginTop: 0, marginBottom: 10, lineHeight: 1.5 }}>
        把外部 AI(ChatGPT / Claude / Gemini 等)按"复制完整提示词"返回的 JSON 粘到下方,
        点"解析并填字段"即自动填到下方各项. 支持带 markdown ```json``` 包裹, 兼容 LLM 常见输出格式.
      </p>
      <Textarea
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        placeholder={'例:\n{\n  "role": "女主角",\n  "appearance": "二十岁短发,圆脸",\n  "outfit": "白色衬衫 + 牛仔裤",\n  "personality": "活泼开朗"\n}'}
        className="min-h-[180px] font-mono text-[12px]"
      />
    </BaseDialog>
  );
}
