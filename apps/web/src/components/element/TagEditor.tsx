/**
 * TagEditor — 按 axis 分组的标签编辑器 (§11)
 *
 * Axis 分组：性格(personality) / 关系(relationship) / 视觉(visual) / 自由(free)
 * 关系标签可关联另一个 element（relatableElements 中选择）
 */

import { useState } from "react";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import type { ElementTag } from "../../lib/elementApi";
import { Button } from "../ui/button";

export const TAG_AXES = [
  { axis: "role", label: "角色定位" },
  { axis: "personality", label: "性格" },
  { axis: "relationship", label: "关系" },
  { axis: "visual", label: "视觉" },
  { axis: "free", label: "自由" },
];

export interface TagEditorProps {
  tags: ElementTag[];
  relatableElements: Array<{ id: string; name: string }>;
  onChange: (tags: ElementTag[]) => void;
  onOpenElement: (id: string) => void;
}

export function TagEditor(props: TagEditorProps) {
  const { tags, relatableElements, onChange, onOpenElement } = props;

  const [axis, setAxis] = useState("personality");
  const [value, setValue] = useState("");
  const [refElementId, setRefElementId] = useState("");

  function add() {
    if (!value.trim()) return;
    onChange([
      ...tags,
      {
        axis,
        value: value.trim(),
        ref_element_id: axis === "relationship" && refElementId ? refElementId : undefined,
      },
    ]);
    setValue("");
    setRefElementId("");
  }

  function remove(idx: number) {
    onChange(tags.filter((_, i) => i !== idx));
  }

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        {tags.length === 0 ? (
          <span style={{ fontSize: 12, color: "var(--ink-400)" }}>暂无标签</span>
        ) : (
          tags.map((t, i) => (
            <span key={i} className="mk-chip mk-chip--outline" style={{ fontSize: 11.5 }}>
              <span style={{ color: "var(--ink-400)", marginRight: 4 }}>
                {TAG_AXES.find((a) => a.axis === t.axis)?.label ?? t.axis}
              </span>
              {t.axis === "role" ? ({ lead: "主角", supporting: "配角", antagonist: "反派", extra: "群演" } as Record<string, string>)[t.value] ?? t.value : t.value}
              {t.ref_element_id ? (
                <button
                  type="button"
                  className="mk-chip mk-chip--ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenElement(t.ref_element_id!);
                  }}
                  style={{ height: 18, marginLeft: 5, fontSize: 10, padding: "0 5px" }}
                  title="打开关联素材"
                >
                  {relatableElements.find((el) => el.id === t.ref_element_id)?.name ?? "关联素材"}
                </button>
              ) : null}
              {/* 铁律 #11: 图标 + 可见文字"移除"(2026-07-22 X4: 原来只有图标 + 屏读器/hover 文字不达标, 改可见文字) */}
              <Button
                variant="ghost"
                size="xs"
                iconLeft="close"
                aria-label="移除此标签"
                title="移除此标签"
                style={{ marginLeft: 4 }}
                onClick={() => remove(i)}
              >
                移除
              </Button>
            </span>
          ))
        )}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Select
          value={axis}
          onChange={(v) => setAxis(v)}
          options={TAG_AXES.map((a) => ({ value: a.axis, label: a.label }))}
          size="sm"
          ariaLabel="选标签类型"
          maxWidth={100}
        />
        <Input
          placeholder={
            axis === "relationship"
              ? "关系描述（例如：父亲 / 同事 / 死对头）"
              : axis === "personality"
                ? "性格特征（例如：克制 / 敏感）"
                : axis === "visual"
                  ? "视觉风格（例如：冷色调 / 极简）"
                  : "标签内容，回车添加"
          }
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          className="flex-1 min-w-[160px]"
        />
        {axis === "relationship" ? (
          <Select
            value={refElementId || "__none__"}
            onChange={(v) => setRefElementId(v === "__none__" ? "" : v)}
            options={[
              { value: "__none__", label: "不关联其他素材" },
              ...relatableElements.map((el) => ({ value: el.id, label: `关联：${el.name}` })),
            ]}
            size="sm"
            ariaLabel="可选关联到另一个素材"
            maxWidth={160}
          />
        ) : null}
        <Button variant="secondary" size="sm" onClick={add}>
          添加
        </Button>
      </div>
    </div>
  );
}

export default TagEditor;
