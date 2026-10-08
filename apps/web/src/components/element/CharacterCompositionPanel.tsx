/**
 * CharacterCompositionPanel — 角色"绑定服装造型 + 常带道具"面板.
 *
 * W2 (2026-05-26) 角色组合性: 把"角色 ↔ 服装/道具"做成结构化关系
 * 而不是塞进描述文字.
 *
 * 仅在 ElementWorkbench 的 sidebar 里, kind=character 时显示.
 *
 * 数据流:
 *   绑定的服装 = element.attrs.wardrobe_element_ids: string[] (kind=wardrobe element 的 id 列表)
 *   常带道具   = element.attrs.prop_element_ids:     string[] (kind=prop     element 的 id 列表)
 *
 * 这两个字段走 patchElement(slug, charId, { attrs: { ...prev, [key]: nextIds } }) 写回,
 * 后端 elementAdapter.CHARACTER_ATTR_KEYS 已加入这两个 key, 双向透传到 CharacterData
 * 顶层字段, 后端 shotPromptCompiler / implicitReferenceCollector 直读消费.
 *
 * UI 设计 (对照铁律):
 *   #3 信息直接可见: 已绑定卡片默认展开, 不藏 details
 *   #6 数据保留: 移除走 useConfirm 二次确认 (不真删 element, 只移除关联关系)
 *   #9 toC 兜底: 不暴露 element_id, 只显示卡片缩略图 + 名字 + 描述
 *   #10 优雅空状态: 空状态有引导文案 + CTA 按钮
 *   #11 按钮有名字: 所有按钮都是图标 + 文字
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../shared/Icon";
import { Button } from "../ui/button";
import { useConfirm } from "../ui/ConfirmModal";
import { LibraryPickerModal } from "../library-picker/LibraryPickerModal";
import {
  listElements,
  patchElement,
  type ElementData,
  type ElementKind,
} from "../../lib/elementApi";
import { showErrorToast } from "../../lib/errorTranslate";

// ─── Props ────────────────────────────────────────────────────────

export interface CharacterCompositionPanelProps {
  slug: string;
  /** 当前角色 element (kind=character). 调用方负责只在 kind=character 时挂载本组件. */
  element: ElementData;
  /** PATCH 成功后回写父态(把新的 element 数据塞回 ElementWorkbench 的 setElement). */
  onElementUpdated: (next: ElementData) => void;
  /** flash 提示 (用 ElementWorkbench 的 toast). */
  onFlash: (msg: string) => void;
}

// ─── attrs helpers ────────────────────────────────────────────────

/** 安全读 attrs.<key> 字符串数组 (兼容老数据无字段). */
function readIdList(attrs: Record<string, unknown> | undefined, key: string): string[] {
  if (!attrs) return [];
  const raw = attrs[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string" && x.length > 0);
}

// ─── 主组件 ────────────────────────────────────────────────────────

export function CharacterCompositionPanel(props: CharacterCompositionPanelProps) {
  const { slug, element, onElementUpdated, onFlash } = props;
  const confirm = useConfirm();

  // 当前已绑定的 id 列表
  const wardrobeIds = useMemo(() => readIdList(element.attrs, "wardrobe_element_ids"), [element.attrs]);
  const propIds = useMemo(() => readIdList(element.attrs, "prop_element_ids"), [element.attrs]);

  // 项目里所有可选的 wardrobe / prop element (id → ElementData 映射, 用于渲染缩略图)
  const [wardrobeElements, setWardrobeElements] = useState<ElementData[]>([]);
  const [propElements, setPropElements] = useState<ElementData[]>([]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [w, p] = await Promise.all([
          listElements(slug, "wardrobe").catch(() => ({ elements: [] as ElementData[] })),
          listElements(slug, "prop").catch(() => ({ elements: [] as ElementData[] })),
        ]);
        if (!alive) return;
        setWardrobeElements(w.elements ?? []);
        setPropElements(p.elements ?? []);
      } catch {
        if (alive) {
          setWardrobeElements([]);
          setPropElements([]);
        }
      }
    })();
    return () => { alive = false; };
  }, [slug]);

  // 弹窗状态
  const [wardrobePickerOpen, setWardrobePickerOpen] = useState(false);
  const [propPickerOpen, setPropPickerOpen] = useState(false);

  // ─── 写入 (PATCH element.attrs) ─────────────────────────────────
  const writeAttrs = useCallback(
    async (nextAttrs: Record<string, unknown>, successMsg: string) => {
      try {
        const r = await patchElement(slug, element.id, { attrs: nextAttrs });
        onElementUpdated(r.element);
        onFlash(successMsg);
      } catch (e) {
        showErrorToast(e, "保存绑定失败");
      }
    },
    [slug, element.id, onElementUpdated, onFlash],
  );

  const addWardrobe = useCallback(
    async (ids: string[]) => {
      const merged = Array.from(new Set([...wardrobeIds, ...ids]));
      const nextAttrs = { ...(element.attrs ?? {}), wardrobe_element_ids: merged };
      await writeAttrs(nextAttrs, `已绑定 ${ids.length} 套服装`);
    },
    [wardrobeIds, element.attrs, writeAttrs],
  );

  const removeWardrobe = useCallback(
    async (id: string) => {
      const target = wardrobeElements.find((el) => el.id === id);
      const ok = await confirm({
        title: `移除「${target?.name ?? "这套服装"}」与本角色的绑定?`,
        description: "只是解除关联关系, 不会删除服装本身. 想再绑回来随时可以加.",
        variant: "warning",
        confirmLabel: "移除绑定",
      });
      if (!ok) return;
      const next = wardrobeIds.filter((x) => x !== id);
      const nextAttrs = { ...(element.attrs ?? {}), wardrobe_element_ids: next };
      await writeAttrs(nextAttrs, "已解除绑定");
    },
    [wardrobeIds, wardrobeElements, element.attrs, writeAttrs, confirm],
  );

  const addProp = useCallback(
    async (ids: string[]) => {
      const merged = Array.from(new Set([...propIds, ...ids]));
      const nextAttrs = { ...(element.attrs ?? {}), prop_element_ids: merged };
      await writeAttrs(nextAttrs, `已添加 ${ids.length} 件常带道具`);
    },
    [propIds, element.attrs, writeAttrs],
  );

  const removeProp = useCallback(
    async (id: string) => {
      const target = propElements.find((el) => el.id === id);
      const ok = await confirm({
        title: `从角色身上去掉「${target?.name ?? "这件道具"}」?`,
        description: "只是去掉关联, 不会删除道具本身. 这场戏可以单独再加一个临时道具.",
        variant: "warning",
        confirmLabel: "去掉",
      });
      if (!ok) return;
      const next = propIds.filter((x) => x !== id);
      const nextAttrs = { ...(element.attrs ?? {}), prop_element_ids: next };
      await writeAttrs(nextAttrs, "已去掉");
    },
    [propIds, propElements, element.attrs, writeAttrs, confirm],
  );

  // ─── 渲染 ────────────────────────────────────────────────────────
  return (
    <div className="mk-card" style={{ padding: 14 }}>
      <div className="mk-label" style={{ marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
        <Icon name="layers" size={14} style={{ color: "var(--brand-600)" }} />
        角色装扮
      </div>
      <p style={{ margin: "0 0 14px", fontSize: 11.5, color: "var(--ink-500)", lineHeight: 1.55 }}>
        给角色固定几套常用服装和常带道具,分镜抽帧时这些都会自动作生图参考,
        让角色不同集还是穿同样的衣服(不用每次都在提示词里描述一遍)。
      </p>

      <CompositionSection
        title="角色常用服装"
        bound={wardrobeIds}
        availableMap={wardrobeElements}
        kind="wardrobe"
        ctaText="添加服装"
        emptyText="这个角色还没设常用服装. 给角色固定几套常用服装, 让不同集还是穿同样的衣服, 分镜挑选只点一下."
        onOpenPicker={() => setWardrobePickerOpen(true)}
        onRemove={removeWardrobe}
      />

      <div style={{ height: 14 }} />

      <CompositionSection
        title="角色常带道具"
        bound={propIds}
        availableMap={propElements}
        kind="prop"
        ctaText="添加常带道具"
        emptyText="这个角色还没设常带道具. 例如老张的怀表 / 公文包, 添加后每镜自动作参考."
        onOpenPicker={() => setPropPickerOpen(true)}
        onRemove={removeProp}
      />

      {/* 服装造型选择弹窗 */}
      <LibraryPickerModal
        open={wardrobePickerOpen}
        onClose={() => setWardrobePickerOpen(false)}
        slug={slug}
        source="project"
        acceptedKinds={["wardrobe"]}
        defaultKind="wardrobe"
        multi
        selectedIds={wardrobeIds}
        title="选择服装 (可多选)"
        onConfirm={(ids) => {
          setWardrobePickerOpen(false);
          const newOnly = ids.filter((id) => !wardrobeIds.includes(id));
          if (newOnly.length === 0) {
            onFlash("没有新选, 已绑定不变");
            return;
          }
          void addWardrobe(newOnly);
        }}
      />

      {/* 常带道具选择弹窗 */}
      <LibraryPickerModal
        open={propPickerOpen}
        onClose={() => setPropPickerOpen(false)}
        slug={slug}
        source="project"
        acceptedKinds={["prop"]}
        defaultKind="prop"
        multi
        selectedIds={propIds}
        title="选择常带道具 (可多选)"
        onConfirm={(ids) => {
          setPropPickerOpen(false);
          const newOnly = ids.filter((id) => !propIds.includes(id));
          if (newOnly.length === 0) {
            onFlash("没有新选, 已绑定不变");
            return;
          }
          void addProp(newOnly);
        }}
      />
    </div>
  );
}

// ─── 子组件: 单一 section (服装 / 道具 同款 UI 结构) ──────────────

interface CompositionSectionProps {
  title: string;
  bound: string[];
  availableMap: ElementData[];
  kind: ElementKind;
  ctaText: string;
  emptyText: string;
  onOpenPicker: () => void;
  onRemove: (id: string) => void;
}

function CompositionSection(props: CompositionSectionProps) {
  const { title, bound, availableMap, ctaText, emptyText, onOpenPicker, onRemove } = props;

  // 把 bound id 列表 resolve 为 ElementData (没找到的 id 显示一个降级卡片)
  const boundElements = useMemo(
    () => bound.map((id) => ({
      id,
      data: availableMap.find((el) => el.id === id) ?? null,
    })),
    [bound, availableMap],
  );

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-800)" }}>
          {title}
          {bound.length > 0 ? (
            <span style={{ marginLeft: 6, color: "var(--ink-400)", fontWeight: 400 }}>· {bound.length}</span>
          ) : null}
        </div>
        <Button variant="secondary" size="xs" iconLeft="plus" onClick={onOpenPicker}>
          {ctaText}
        </Button>
      </div>

      {bound.length === 0 ? (
        <div
          style={{
            padding: "10px 12px",
            fontSize: 11.5,
            lineHeight: 1.55,
            color: "var(--ink-500)",
            background: "var(--surface-canvas)",
            border: "1px dashed var(--ink-200)",
            borderRadius: 8,
          }}
        >
          {emptyText}
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
            gap: 8,
          }}
        >
          {boundElements.map(({ id, data }) => (
            <BoundElementCard
              key={id}
              element={data}
              fallbackName={data?.name ?? `（已删除的素材 · ${id.slice(0, 8)}…）`}
              onRemove={() => onRemove(id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── 子组件: 已绑定的卡片 (缩略图 + 名称 + 移除按钮) ──────────────

interface BoundElementCardProps {
  element: ElementData | null;
  fallbackName: string;
  onRemove: () => void;
}

function BoundElementCard({ element, fallbackName, onRemove }: BoundElementCardProps) {
  // 主图 url. 优先 primary_image, 没有取第一张可用图.
  const thumb = useMemo(() => {
    if (!element || element.images.length === 0) return null;
    const primary = element.primary_image_id
      ? element.images.find((im) => im.image_id === element.primary_image_id)
      : null;
    return primary?.url ?? element.images[0]?.url ?? null;
  }, [element]);

  const displayName = element?.name ?? fallbackName;
  const subtitle = element
    ? element.description.trim().slice(0, 30) || (thumb ? "" : "暂无图")
    : "已被删除或不在本项目";

  return (
    <div
      className="mk-card"
      style={{
        padding: 0,
        overflow: "hidden",
        border: element ? "1px solid var(--ink-200)" : "1px dashed var(--err)",
        background: "var(--surface-card)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          width: "100%",
          aspectRatio: "1 / 1",
          background: thumb
            ? `center/cover no-repeat url("${thumb}")`
            : "linear-gradient(135deg, var(--ink-100, #f3f4f6) 0%, var(--ink-200, #e5e7eb) 100%)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {!thumb ? (
          <Icon
            name={element ? "image" : "warning"}
            size={20}
            style={{ color: "var(--ink-400)" }}
          />
        ) : null}
      </div>
      <div style={{ padding: "6px 8px", flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
        <div
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            color: element ? "var(--ink-800)" : "var(--err)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={displayName}
        >
          {displayName}
        </div>
        {subtitle ? (
          <div
            style={{
              fontSize: 10,
              color: "var(--ink-400)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={subtitle}
          >
            {subtitle}
          </div>
        ) : null}
        <Button
          variant="ghost"
          size="xs"
          iconLeft="close"
          onClick={onRemove}
          style={{ marginTop: 2 }}
          title="解除该绑定关系 (不删素材本身)"
        >
          移除
        </Button>
      </div>
    </div>
  );
}

export default CharacterCompositionPanel;
