/**
 * ReferencePicker — 多图勾选作生图参考(Wave A · 2026-05-16).
 *
 * 用户场景(原话):
 *   "我前期生成了几张人物图片,选定一张我觉得最好的放入人物素材库,接下来我想生成
 *    这个人物另一个场合或者表情的图片,就在生图界面勾选我之前选定的素材库里的图片,
 *    然后写我的 xxx 要求,这时我写完之后系统就要自动把我勾的图片一起发给生图模型"
 *
 * 实现:
 *  - 显示当前 element 的所有 image(若 origin=imported/i2i/generated 都可被勾选)
 *  - 复选框选择 ≤8 张 (后端 ImageInputRef 最多支持 8 张)
 *  - 主图默认勾上 (用户最常用诉求 — 主图作"外观真相源")
 *  - onChange 把选中的 image 列表暴露出去,父组件把它们转成 `{ asset_id }` 传 extraReferenceImages
 *
 * UI 设计原则(对照 12 条铁律):
 *  - 铁律 #3 信息直接可见:默认展开,主图默认勾上;不强制"点开折叠才能看到"
 *  - 铁律 #4 就近决策:贴在 ImageGenerationPanel 正上方
 *  - 铁律 #8 视觉一致性:沿用 mk-card / mk-chip / mk-btn 视觉
 *  - 铁律 #9 toC 兜底:不暴露 asset_id,只展示缩略图 + 来源标签(labelOfSource)
 *  - 铁律 #11 按钮有名字:复选不算按钮但要清楚 — 缩略图右上角 √ icon + 边框高亮
 */

import { useCallback, useMemo, useState } from "react";
import { Icon } from "../shared/Icon";
import { ImageCard } from "../shared/ImageCard";
import type { ElementImage } from "../../lib/elementApi";
import { IMAGE_TAG_AXIS_LABEL } from "../../lib/elementApi";
import { Button } from "../ui/button";

const MAX_REFS = 8;

export interface ReferencePickerProps {
  /** 全部可选图 — 一般是 element.images */
  images: ElementImage[];
  /** 当前勾选的 image_id 列表 */
  selectedIds: string[];
  /** 主图 id(默认勾上)*/
  primaryImageId?: string;
  /** 勾选变化回调 */
  onChange: (selectedIds: string[]) => void;
  /** 标题 / 说明(可选)*/
  title?: string;
  /** 默认展开(默认 true — 铁律 #3 直接可见)*/
  defaultOpen?: boolean;
  /**
   * P3-2 (2026-05-18): "引用其他素材图" 按钮回调.
   * 父组件(ElementWorkbench)接管弹 LibraryPickerModal、fetch 典型图、
   * 再把新图 merge 进 images 列表.不传则不渲染该按钮.
   */
  onPickFromLibrary?: () => void;
}

type ReferenceImage = ElementImage & { sourceElementName?: string };

export function ReferencePicker(props: ReferencePickerProps) {
  const {
    images,
    selectedIds,
    primaryImageId,
    onChange,
    title = "把已有图片作为生图参考",
    defaultOpen = true,
    onPickFromLibrary,
  } = props;

  const usable = useMemo(
    () => images.filter((im) => !!im.url),
    [images],
  );

  // W2 (2026-05-26) — 轴 + 值过滤: 从图集中收集所有 (axis, value) 组合.
  // chip 形如 "pose: 站立" / "expression: 笑". 没图带 image_tags 时整块隐藏.
  const axisValueOptions = useMemo(() => {
    const seen = new Map<string, { axis: string; value: string; count: number }>();
    for (const im of usable) {
      for (const t of im.image_tags ?? []) {
        if (!t.axis || !t.value) continue;
        const key = `${t.axis}::${t.value}`;
        const prev = seen.get(key);
        if (prev) prev.count += 1;
        else seen.set(key, { axis: t.axis, value: t.value, count: 1 });
      }
    }
    // 按 axis 排序, 同 axis 内按 value 字典序
    return Array.from(seen.values()).sort((a, b) => {
      if (a.axis !== b.axis) return a.axis.localeCompare(b.axis);
      return a.value.localeCompare(b.value);
    });
  }, [usable]);

  // 当前激活过滤. null = 不过滤 (显示全部).
  const [activeFilter, setActiveFilter] = useState<{ axis: string; value: string } | null>(null);

  // 应用过滤后的图集. 没有任何带标签的图时不过滤 (axisValueOptions=[] 时整块隐藏).
  const filteredImages = useMemo(() => {
    if (!activeFilter) return usable;
    return usable.filter((im) => {
      const tags = im.image_tags ?? [];
      // 命中过滤条件的图保留; 没标签的图也保留 (避免一开过滤所有老图都消失)
      if (tags.length === 0) return true;
      return tags.some((t) => t.axis === activeFilter.axis && t.value === activeFilter.value);
    });
  }, [usable, activeFilter]);

  const toggle = useCallback(
    (imageId: string) => {
      if (selectedIds.includes(imageId)) {
        onChange(selectedIds.filter((id) => id !== imageId));
      } else {
        if (selectedIds.length >= MAX_REFS) {
          // 显式上限
          return;
        }
        onChange([...selectedIds, imageId]);
      }
    },
    [selectedIds, onChange],
  );

  const clearAll = useCallback(() => onChange([]), [onChange]);

  const pickPrimary = useCallback(() => {
    if (primaryImageId) onChange([primaryImageId]);
  }, [primaryImageId, onChange]);

  // 2026-05-18 三池模型: 一键勾选所有典型代表图
  // 与"只勾主图"区分: 典型可有多张(B-13 治本), 主图只 1 张
  const typicalImages = useMemo(
    () => usable.filter((im) => im.is_typical === true),
    [usable],
  );
  const pickAllTypical = useCallback(() => {
    if (typicalImages.length === 0) return;
    // 限制到 MAX_REFS 张, 优先级跟 element.images 原序一致
    const ids = typicalImages.slice(0, MAX_REFS).map((im) => im.image_id);
    onChange(ids);
  }, [typicalImages, onChange]);

  if (usable.length === 0) {
    return null; // 没图就别显示,空状态由 ImageGenerationPanel 接管
  }

  return (
    <details
      className="mk-card"
      open={defaultOpen}
      style={{ padding: 0, overflow: "hidden" }}
    >
      <summary
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "12px 16px",
          cursor: "pointer",
          userSelect: "none",
          background: "var(--surface-canvas, #fafafa)",
          borderBottom: "1px solid var(--ink-100)",
        }}
      >
        <Icon name="image" size={14} style={{ color: "var(--brand-600)" }} />
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--ink-800)" }}>
          {title}
        </span>
        <span
          className={selectedIds.length > 0 ? "mk-chip mk-chip--brand" : "mk-chip mk-chip--outline"}
          style={{ height: 20, fontSize: 11 }}
        >
          {selectedIds.length > 0 ? `已勾 ${selectedIds.length} / ${MAX_REFS}` : "未勾选"}
        </span>
        <div style={{ flex: 1 }} />
        {/* 2026-05-18 三池模型: "勾所有典型 ⭐" 优先于"只勾主图". 都没典型时退回"只勾主图". */}
        {typicalImages.length > 0 && (
          (() => {
            const allTypicalSelected = typicalImages.every((im) => selectedIds.includes(im.image_id))
              && selectedIds.length === Math.min(typicalImages.length, MAX_REFS);
            return !allTypicalSelected ? (
              <Button
                variant="ghost"
                size="sm"
                iconLeft="sparkles"
                title={`勾选所有 ⭐ 代表图(共 ${typicalImages.length} 张${typicalImages.length > MAX_REFS ? `, 取前 ${MAX_REFS} 张` : ""})`}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  pickAllTypical();
                }}
              >
                勾所有代表图 ({typicalImages.length})
              </Button>
            ) : null;
          })()
        )}
        {primaryImageId && !selectedIds.includes(primaryImageId) ? (
          <Button
            variant="ghost"
            size="sm"
            iconLeft="bookmark"
            title="只勾主图作参考(已锁定的代表图)"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              pickPrimary();
            }}
          >
            只勾主图
          </Button>
        ) : null}
        {/* P3-2 (2026-05-18): 引用其他素材图 — 跨 element 取图 */}
        {onPickFromLibrary ? (
          <Button
            variant="ghost"
            size="sm"
            iconLeft="link"
            title="从其他素材（服装/道具/场景等）引用典型图作参考"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onPickFromLibrary();
            }}
          >
            引用其他素材图...
          </Button>
        ) : null}
        {selectedIds.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            iconLeft="close"
            title="取消所有勾选"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              clearAll();
            }}
          >
            清空
          </Button>
        ) : null}
      </summary>
      <div style={{ padding: 12 }}>
        <p
          style={{
            margin: 0,
            marginBottom: 10,
            fontSize: 11.5,
            color: "var(--ink-500)",
            lineHeight: 1.55,
          }}
        >
          勾选下面的图作"生图参考"— 系统在调图像模型时会把这些图一起发出去,模型会
          参考它们的外观、风格、构图。最多勾 {MAX_REFS} 张。
        </p>

        {/* W2 (2026-05-26) — 维度标签过滤 chip 行. 没图带标签则整行不显示. */}
        {axisValueOptions.length > 0 ? (
          <div style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            marginBottom: 12,
            padding: "8px 10px",
            background: "var(--surface-canvas, #fafafa)",
            borderRadius: 6,
            border: "1px solid var(--ink-100)",
          }}>
            <span style={{ fontSize: 11, color: "var(--ink-500)", fontWeight: 600, marginRight: 4 }}>
              按图片标签过滤:
            </span>
            <FilterChip
              active={activeFilter === null}
              label="全部"
              onClick={() => setActiveFilter(null)}
            />
            {axisValueOptions.map((opt) => {
              const isActive =
                activeFilter !== null &&
                activeFilter.axis === opt.axis &&
                activeFilter.value === opt.value;
              const axisLabel = IMAGE_TAG_AXIS_LABEL[opt.axis] ?? opt.axis;
              return (
                <FilterChip
                  key={`${opt.axis}::${opt.value}`}
                  active={isActive}
                  label={`${axisLabel}: ${opt.value}`}
                  count={opt.count}
                  onClick={() => setActiveFilter(isActive ? null : { axis: opt.axis, value: opt.value })}
                />
              );
            })}
          </div>
        ) : null}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
            gap: 8,
          }}
        >
          {filteredImages.map((im) => {
            const checked = selectedIds.includes(im.image_id);
            const disabledByLimit = !checked && selectedIds.length >= MAX_REFS;
            const isPrimary = im.image_id === primaryImageId;
            const sourceElementName = (im as ReferenceImage).sourceElementName;
            return (
              <div
                key={im.image_id}
                title={
                  disabledByLimit
                    ? `已达上限 ${MAX_REFS} 张,取消其他再勾这张`
                    : checked
                      ? "已勾选 — 再点取消"
                      : "点击勾选这张作为生图参考"
                }
                style={{
                  padding: 0,
                  cursor: disabledByLimit ? "not-allowed" : "pointer",
                  opacity: disabledByLimit ? 0.4 : 1,
                  transition: "border-color 120ms",
                }}
              >
                <ImageCard
                  image={im}
                  slug=""
                  variant="readonly"
                  selected={checked}
                  isPrimary={isPrimary}
                  sourceElementName={sourceElementName}
                  aspectRatio="1 / 1"
                  onClick={disabledByLimit ? undefined : () => toggle(im.image_id)}
                />
              </div>
            );
          })}
        </div>
      </div>
    </details>
  );
}

// ─── FilterChip (W2 2026-05-26) ────────────────────────────────────────
// 维度过滤 chip: 命中时带高亮边 + 反色背景, 鼠标 hover 时变深.
// 铁律 #11 按钮有名字: 文字标签必须有, 不是 icon-only.

interface FilterChipProps {
  active: boolean;
  label: string;
  count?: number;
  onClick: () => void;
}

function FilterChip({ active, label, count, onClick }: FilterChipProps) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "3px 9px",
        borderRadius: 999,
        border: active
          ? "1.5px solid var(--brand-600, #d97757)"
          : "1px solid var(--ink-200)",
        background: active ? "var(--brand-50, #fff4ec)" : "var(--surface-card)",
        color: active ? "var(--brand-700, #c2410c)" : "var(--ink-600)",
        fontSize: 11,
        fontWeight: 600,
        cursor: "pointer",
        transition: "border-color 120ms, background-color 120ms",
      }}
      title={active ? "已选过滤, 点取消" : `按 ${label} 过滤图集`}
    >
      <span>{label}</span>
      {typeof count === "number" ? (
        <span style={{ fontWeight: 400, color: active ? "var(--brand-700)" : "var(--ink-400)" }}>
          ({count})
        </span>
      ) : null}
    </button>
  );
}

export default ReferencePicker;
