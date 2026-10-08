/**
 * ElementSidebar — 左栏剩余部分: 标签 + "出现在"分镜列表.
 *
 * (描述编辑器 + 字段表单已抽到独立子组件, 在主页面里跟此组件同列摆放.)
 *
 * 从 ElementWorkbench 拆出(Wave P2 解耦). 视觉零变更.
 */

import { TagEditor } from "../../../components/element/TagEditor";
import { ElementUsageList } from "../../../components/element/ElementUsageList";
import type { ElementTag, ElementUsage } from "../../../lib/elementApi";

interface Props {
  tags: ElementTag[];
  onTagsChange: (next: ElementTag[]) => void;
  relatableElements: Array<{ id: string; name: string }>;
  onOpenElement: (id: string) => void;

  usage: ElementUsage[];
  onNavigateToShot: (epId: string, shotId: string) => void;
}

export function ElementSidebar({
  tags,
  onTagsChange,
  relatableElements,
  onOpenElement,
  usage,
  onNavigateToShot,
}: Props) {
  return (
    <>
      <div className="mk-card" style={{ padding: 16 }}>
        <div className="mk-label" style={{ marginBottom: 8 }}>标签</div>
        <TagEditor
          tags={tags}
          relatableElements={relatableElements}
          onChange={onTagsChange}
          onOpenElement={onOpenElement}
        />
      </div>

      <div className="mk-card" style={{ padding: 16 }}>
        <div className="mk-label" style={{ marginBottom: 8 }}>
          出现在（{usage.length} 个分镜）
        </div>
        <ElementUsageList
          usage={usage}
          onNavigate={onNavigateToShot}
        />
      </div>
    </>
  );
}
