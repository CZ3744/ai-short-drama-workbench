// v25 · 资料库连接面板 — 单镜创作页左栏
// 人物 / 场景并列、同样展示: 各一条横向可拖动的卡片滑条(应对数量多)。
// 点卡片绑定/解绑; 绑定后「选素材」在滑条下方平铺展开该实体的可用素材,挑哪张就接哪张。
//   注: 具体素材(姿势/穿着/时间/天气...)在素材界面管理, 此处只负责"选哪张图接入"。
// 参考图: 支持导入多份, 每张可在下方备注"这是什么"(人物/场景/物品参考),
//   备注随 shot.reference_notes 持久化, 拼接提示词时带给 LLM 模糊理解。
// 不改后端候选字段: 选中的图片引用 id 记进 shot.reference_asset_ids。
//
// 2026-05-18 全 6 类素材打通 — 用户反馈"分镜素材连接只能连角色场景,prop/wardrobe/reference/misc
//   建了挂不上"。新增「项目素材」section,横向混合滑条 + EntityChip(带 kind 角标),
//   勾选写入 shot.element_ids[](后端 implicitReferenceCollector 已支持),展开挑具体哪张图
//   写入 shot.reference_asset_ids[](与角色/场景同套机制)。
import { useCallback, useEffect, useMemo, useState } from "react";
import { useToggleSet } from "../../hooks/useToggleSet";
import type React from "react";
import { Icon } from "../shared/Icon";
import { Button } from "../ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover";
import { MediaLightbox } from "../shared/MediaLightbox";
import { LibraryPickerModal } from "../library-picker/LibraryPickerModal";
import {
  displayNameOfImage,
  listElements,
  patchElementImage,
  ELEMENT_KIND_LABEL,
  type ElementData,
  type ElementImage,
  type ElementKind,
} from "../../lib/elementApi";
import { imageThumbUrl, imageOriginalUrl } from "../../lib/imageThumb";
import { showErrorToast } from "../../lib/errorTranslate";
import { InlineLabel } from "../shot-stage/InlineLabel";
import { useSeries } from "../../hooks/useSeries";
import { seriesAspectToCss } from "../../lib/aspectRatio";

// 2026-05-18 铁律 #13 续: 角色 / 场景卡片必须默认显示主图 (跟素材管理设置的 primary_image 同步).
//   未展开"选素材"前, EntityChip 之前 cover 永远是空 (只在 expanded → loadVariants 后才有 list[0]),
//   用户看到全是占位 icon, 跟素材管理脱节 — 必须接 primary_image_url.
interface CharacterLite { id: string; name: string; role?: string; primary_image_url?: string }
interface SceneLite { id: string; name: string; location?: string; time_of_day?: string; primary_image_url?: string }

interface PickableAsset {
  id: string;
  ref_id: string;
  label: string;
  url: string;
  image: ElementImage;
  element: ElementData;
}

/** 2026-05-18: 项目素材 section 关注的 kind 范围 (角色/场景除外的 4 类) */
const PROJECT_ELEMENT_KINDS: ElementKind[] = ["prop", "wardrobe", "reference", "misc"];

export interface LibraryConnectPanelProps {
  slug: string;
  characters: CharacterLite[];
  scenes: SceneLite[];
  /** 2026-05-18: 项目素材 — prop/wardrobe/reference/misc 4 类元素,由宿主页预先 fetch 注入 */
  elements: ElementData[];
  characterIds: string[];
  sceneId: string;
  /** 2026-05-18: 已绑定的项目素材 id (shot.element_ids) */
  elementIds: string[];
  referenceAssetIds: string[];
  referenceNotes: Record<string, string>;
  onChange: (patch: {
    character_ids?: string[];
    scene_id?: string;
    element_ids?: string[];
    reference_asset_ids?: string[];
    reference_notes?: Record<string, string>;
  }) => void;
  /** 触发宿主页隐藏的本地文件 input */
  onImportClick: () => void;
}

function toPickableImages(slug: string, element: ElementData): PickableAsset[] {
  return element.images
    .filter((image) => image.available_for_shot !== false)
    .map((image) => {
      const refId = image.asset_id ?? image.vault_id ?? image.image_id;
      return {
        id: image.image_id,
        ref_id: refId,
        label: displayNameOfImage(image),
        url: imageThumbUrl(slug, image),
        image,
        element,
      };
    });
}

export default function LibraryConnectPanel(props: LibraryConnectPanelProps) {
  const {
    slug, characters, scenes, elements, characterIds, sceneId, elementIds,
    referenceAssetIds, referenceNotes, onChange, onImportClick,
  } = props;

  const [variantsBy, setVariantsBy] = useState<Record<string, PickableAsset[]>>({});
  const { add: addLoadingId, remove: removeLoadingId, has: isLoadingId } = useToggleSet<string>();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pickerTarget, setPickerTarget] = useState<"character" | "scene" | "element" | null>(null);

  const { data: seriesData } = useSeries(slug);
  const aspectRatio = seriesAspectToCss(seriesData?.defaults?.aspect_ratio);

  // 2026-05-18: 项目素材 (props.elements) 的 variants 预加载到 variantsBy
  // 跟 character/scene 的 loadVariants 不同 — element 已由宿主页 fetch 传入,这里直接派生即可,不走 listElements
  useEffect(() => {
    setVariantsBy((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const el of elements) {
        if (!next[el.id]) {
          next[el.id] = toPickableImages(slug, el);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [elements, slug]);

  const loadVariants = useCallback((kind: "character" | "scene", id: string) => {
    setVariantsBy((prevMap) => {
      if (prevMap[id]) return prevMap;
      addLoadingId(id);
      void (async () => {
        try {
          const res = await listElements(slug, kind);
          const element = res.elements.find((el) => el.id === id);
          setVariantsBy((m) => ({ ...m, [id]: element ? toPickableImages(slug, element) : [] }));
        } catch (err) {
          showErrorToast(err, "加载素材失败");
          setVariantsBy((m) => ({ ...m, [id]: [] }));
        } finally {
          removeLoadingId(id);
        }
      })();
      return prevMap;
    });
  }, [slug]);

  // 已绑定实体预加载, 卡片缩略图能显示已选图
  useEffect(() => {
    characterIds.forEach((id) => loadVariants("character", id));
    if (sceneId) loadVariants("scene", sceneId);
  }, [characterIds, sceneId, loadVariants]);

  const knownVariantRefIds = useMemo(() => {
    const set = new Set<string>();
    for (const list of Object.values(variantsBy)) for (const v of list) set.add(v.ref_id);
    return set;
  }, [variantsBy]);

  const standaloneRefs = referenceAssetIds.filter((id) => !knownVariantRefIds.has(id));

  function pickedVariant(entityId: string): PickableAsset | undefined {
    return (variantsBy[entityId] ?? []).find((v) => referenceAssetIds.includes(v.ref_id));
  }
  function variantVaultIds(entityId: string): string[] {
    return (variantsBy[entityId] ?? []).map((v) => v.ref_id);
  }

  function clearReferenceIdsFor(entityIds: string[]) {
    const refsToRemove = new Set<string>();
    for (const id of entityIds) for (const refId of variantVaultIds(id)) refsToRemove.add(refId);
    const nextNotes = { ...referenceNotes };
    for (const id of refsToRemove) delete nextNotes[id];
    return {
      reference_asset_ids: referenceAssetIds.filter((id) => !refsToRemove.has(id)),
      reference_notes: nextNotes,
    };
  }

  function confirmCharacters(ids: string[]) {
    const removed = characterIds.filter((id) => !ids.includes(id));
    const refs = clearReferenceIdsFor(removed);
    onChange({ character_ids: ids, ...refs });
    ids.forEach((id) => loadVariants("character", id));
  }

  function confirmScene(ids: string[]) {
    const nextId = ids[0] ?? "";
    const refs = sceneId && sceneId !== nextId ? clearReferenceIdsFor([sceneId]) : undefined;
    onChange({ scene_id: nextId, ...(refs ?? {}) });
    if (nextId) loadVariants("scene", nextId);
  }

  function toggleCharacter(id: string) {
    if (characterIds.includes(id)) {
      const vids = variantVaultIds(id);
      onChange({
        character_ids: characterIds.filter((x) => x !== id),
        reference_asset_ids: referenceAssetIds.filter((r) => !vids.includes(r)),
      });
      if (expanded === id) setExpanded(null);
    } else {
      onChange({ character_ids: [...characterIds, id] });
      loadVariants("character", id);
    }
  }

  function toggleScene(id: string) {
    if (sceneId === id) {
      const vids = variantVaultIds(id);
      onChange({ scene_id: "", reference_asset_ids: referenceAssetIds.filter((r) => !vids.includes(r)) });
      if (expanded === id) setExpanded(null);
    } else {
      const oldVids = sceneId ? variantVaultIds(sceneId) : [];
      onChange({ scene_id: id, reference_asset_ids: referenceAssetIds.filter((r) => !oldVids.includes(r)) });
      loadVariants("scene", id);
    }
  }

  // 2026-05-18: 项目素材 (prop/wardrobe/reference/misc) 绑定 / 解绑 — 写入 shot.element_ids[]
  // 解绑时一并清理该 element 的 variant 被挑入 reference_asset_ids 的图.
  function toggleElement(id: string) {
    if (elementIds.includes(id)) {
      const vids = variantVaultIds(id);
      const nextNotes = { ...referenceNotes };
      for (const refId of vids) delete nextNotes[refId];
      onChange({
        element_ids: elementIds.filter((x) => x !== id),
        reference_asset_ids: referenceAssetIds.filter((r) => !vids.includes(r)),
        reference_notes: nextNotes,
      });
      if (expanded === id) setExpanded(null);
    } else {
      onChange({ element_ids: [...elementIds, id] });
    }
  }

  function confirmProjectElements(ids: string[]) {
    const removed = elementIds.filter((id) => !ids.includes(id));
    const refs = removed.length ? clearReferenceIdsFor(removed) : undefined;
    onChange({ element_ids: ids, ...(refs ?? {}) });
  }

  function pickVariant(entityId: string, v: PickableAsset) {
    const allVids = variantVaultIds(entityId);
    const cleared = referenceAssetIds.filter((r) => !allVids.includes(r));
    const already = referenceAssetIds.includes(v.ref_id);
    const nextNotes = { ...referenceNotes };
    for (const refId of allVids) delete nextNotes[refId];
    if (!already) nextNotes[v.ref_id] = `${v.element.name} · ${v.label}`;
    onChange({
      reference_asset_ids: already ? cleared : [...cleared, v.ref_id],
      reference_notes: nextNotes,
    });
  }

  /**
   * 2026-05-27 — VariantPicker 主操作: toggle entity 代表图集 (is_typical).
   *
   * 不再走 shot.reference_asset_ids 单选, 改成多选 + 持久化到 element.images[].is_typical.
   * 跟审核弹窗"系统自动附加 N/N"用的字段一致, 用户在 picker 上勾的图就是
   * 系统会自动发的图.
   *
   * 实现:
   *   1. patchElementImage(slug, elementId, imageId, { is_typical: nextTypical })
   *   2. 把返回的 element 重新 toPickableImages, 局部 patch variantsBy[entityId]
   *      → picker 视觉立即更新 (不需要等 SWR refetch).
   *   3. 也 mutate `characters:${slug}` / `scenes:${slug}` SWR cache, 让外面
   *      的角色 / 场景缩略图条带也同步.
   */
  async function toggleVariantTypical(entityId: string, v: PickableAsset, nextTypical: boolean) {
    try {
      const res = await patchElementImage(slug, v.element.id, v.image.image_id, {
        is_typical: nextTypical,
      });
      // 局部更新 variantsBy[entityId], picker 视觉立即反映
      setVariantsBy((prev) => ({
        ...prev,
        [entityId]: toPickableImages(slug, res.element),
      }));
      // 触发外层 SWR 缓存失效 (角色 / 场景列表的 primary 缩略图 / typical 状态)
      // 通过 onChange 不写新数据但保持现有, 让 caller 重新 fetch elements 也行;
      // 这里直接走 swrInvalidate.invalidateElements 更直接.
      // 但 LibraryConnectPanel 不知道是哪个 series, 由 caller 通过 props.slug.
      // 直接 import + 调:
      try {
        const { invalidateElements } = await import("../../lib/swrInvalidate");
        await invalidateElements(slug);
      } catch { /* noop */ }
    } catch (err) {
      showErrorToast(err, nextTypical ? "加入代表图集失败" : "移出代表图集失败");
      throw err;
    }
  }

  function toggleExpand(kind: "character" | "scene" | "element", id: string) {
    setExpanded((cur) => (cur === id ? null : id));
    // element 的 variants 已由 props.elements useEffect 预加载,无需调用 listElements
    if (kind !== "element") loadVariants(kind, id);
  }

  function setNote(id: string, note: string) {
    onChange({ reference_notes: { ...referenceNotes, [id]: note } });
  }

  function removeRef(id: string) {
    const nextNotes = { ...referenceNotes };
    delete nextNotes[id];
    onChange({
      reference_asset_ids: referenceAssetIds.filter((x) => x !== id),
      reference_notes: nextNotes,
    });
  }

  const expandedIsCharacter = expanded != null && characters.some((c) => c.id === expanded);
  const expandedIsScene = expanded != null && scenes.some((s) => s.id === expanded);
  const expandedIsElement = expanded != null && elements.some((e) => e.id === expanded);
  const expandedEntity =
    characters.find((c) => c.id === expanded) ??
    scenes.find((s) => s.id === expanded) ??
    elements.find((e) => e.id === expanded) ??
    null;

  // 项目素材按 kind 自然排序展示 — 已绑定的排前面,同 kind 内按 created_at 倒序
  const sortedProjectElements = useMemo(() => {
    const KIND_ORDER: Record<ElementKind, number> = {
      character: 99, scene: 99, // 不会出现在这里, 仅占位
      prop: 0, wardrobe: 1, reference: 2, misc: 3,
    };
    return [...elements].sort((a, b) => {
      const aBound = elementIds.includes(a.id) ? 0 : 1;
      const bBound = elementIds.includes(b.id) ? 0 : 1;
      if (aBound !== bBound) return aBound - bBound;
      const ka = KIND_ORDER[a.kind] ?? 99;
      const kb = KIND_ORDER[b.kind] ?? 99;
      if (ka !== kb) return ka - kb;
      return (b.created_at ?? "").localeCompare(a.created_at ?? "");
    });
  }, [elements, elementIds]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* ── 人物 ── */}
      <div>
        <div style={{ ...lcLabel, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ flex: 1 }}>出境人物（项目角色库 · 可多选）</span>
          <Button variant="ghost" size="xs" iconLeft="layers" onClick={() => setPickerTarget("character")}>
            选素材
          </Button>
        </div>
        {characters.length === 0 ? (
          <div style={lcEmpty}>暂无人物，可去角色页创建。</div>
        ) : (
          <div className="mk-scroll" style={lcStrip}>
            {characters.map((c) => (
              <Popover
                key={c.id}
                open={expanded === c.id}
                onOpenChange={(o) => { if (!o) setExpanded(null); }}
              >
                <PopoverAnchor>
                  <EntityChip
                    kind="character"
                    name={c.name}
                    sub={c.role || "角色"}
                    primaryImageUrl={c.primary_image_url}
                    bound={characterIds.includes(c.id)}
                    expanded={expanded === c.id}
                    picked={pickedVariant(c.id)}
                    variants={variantsBy[c.id]}
                    aspectRatio={aspectRatio}
                    onToggleBind={() => toggleCharacter(c.id)}
                    onToggleExpand={() => toggleExpand("character", c.id)}
                  />
                </PopoverAnchor>
                {expanded === c.id && (
                  <PopoverContent side="bottom" align="start" sideOffset={6} className="w-[480px] p-3">
                    <VariantPicker
                      slug={slug}
                      entityName={c.name}
                      entityKind="character"
                      variants={variantsBy[c.id]}
                      loading={isLoadingId(c.id)}
                      aspectRatio={aspectRatio}
                      onToggleTypical={(v, nextTypical) => toggleVariantTypical(c.id, v, nextTypical)}
                      onClose={() => setExpanded(null)}
                    />
                  </PopoverContent>
                )}
              </Popover>
            ))}
          </div>
        )}
      </div>

      {/* ── 场景 ── */}
      <div>
        <div style={{ ...lcLabel, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ flex: 1 }}>场景（项目场景库 · 单选）</span>
          <Button variant="ghost" size="xs" iconLeft="layers" onClick={() => setPickerTarget("scene")}>
            选素材
          </Button>
        </div>
        {scenes.length === 0 ? (
          <div style={lcEmpty}>暂无场景，可去场景页创建。</div>
        ) : (
          <div className="mk-scroll" style={lcStrip}>
            {scenes.map((s) => (
              <Popover
                key={s.id}
                open={expanded === s.id}
                onOpenChange={(o) => { if (!o) setExpanded(null); }}
              >
                <PopoverAnchor>
                  <EntityChip
                    kind="scene"
                    name={s.name}
                    sub={s.location || s.time_of_day || "场景"}
                    primaryImageUrl={s.primary_image_url}
                    bound={sceneId === s.id}
                    expanded={expanded === s.id}
                    picked={pickedVariant(s.id)}
                    variants={variantsBy[s.id]}
                    aspectRatio={aspectRatio}
                    onToggleBind={() => toggleScene(s.id)}
                    onToggleExpand={() => toggleExpand("scene", s.id)}
                  />
                </PopoverAnchor>
                {expanded === s.id && (
                  <PopoverContent side="bottom" align="start" sideOffset={6} className="w-[480px] p-3">
                    <VariantPicker
                      slug={slug}
                      entityName={s.name}
                      entityKind="scene"
                      variants={variantsBy[s.id]}
                      loading={isLoadingId(s.id)}
                      aspectRatio={aspectRatio}
                      onToggleTypical={(v, nextTypical) => toggleVariantTypical(s.id, v, nextTypical)}
                      onClose={() => setExpanded(null)}
                    />
                  </PopoverContent>
                )}
              </Popover>
            ))}
          </div>
        )}
      </div>

      {/* ── 项目素材（物品 / 服装 / 参考 / 杂物 · 多选）── 2026-05-18 全 6 类素材打通 */}
      <div>
        <div style={{ ...lcLabel, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ flex: 1 }}>项目素材（物品 / 服装 / 参考 / 杂物 · 可多选）</span>
          <Button variant="ghost" size="xs" iconLeft="layers" onClick={() => setPickerTarget("element")}>
            选素材
          </Button>
        </div>
        {sortedProjectElements.length === 0 ? (
          <div style={lcEmpty}>
            暂无项目素材。可去「素材库」创建物品 / 服装 / 参考照片 / 杂物。建好后会自动出现在这里,挂上分镜后会作为参考图喂给生图模型。
          </div>
        ) : (
          <div className="mk-scroll" style={lcStrip}>
            {sortedProjectElements.map((el) => (
              <Popover
                key={el.id}
                open={expanded === el.id}
                onOpenChange={(o) => { if (!o) setExpanded(null); }}
              >
                <PopoverAnchor>
                  <ElementChip
                    element={el}
                    bound={elementIds.includes(el.id)}
                    expanded={expanded === el.id}
                    picked={pickedVariant(el.id)}
                    variants={variantsBy[el.id]}
                    aspectRatio={aspectRatio}
                    onToggleBind={() => toggleElement(el.id)}
                    onToggleExpand={() => toggleExpand("element", el.id)}
                  />
                </PopoverAnchor>
                {expanded === el.id && (
                  <PopoverContent side="bottom" align="start" sideOffset={6} className="w-[480px] p-3">
                    <VariantPicker
                      slug={slug}
                      entityName={el.name}
                      entityKind="element"
                      variants={variantsBy[el.id]}
                      loading={isLoadingId(el.id)}
                      aspectRatio={aspectRatio}
                      onToggleTypical={(v, nextTypical) => toggleVariantTypical(el.id, v, nextTypical)}
                      onClose={() => setExpanded(null)}
                    />
                  </PopoverContent>
                )}
              </Popover>
            ))}
          </div>
        )}
      </div>

      {/* ── 参考图（本地导入 · 多份 · 逐张备注）── */}
      <div>
        <div style={{ ...lcLabel, display: "flex", alignItems: "center" }}>
          <span style={{ flex: 1 }}>参考图（可导入多份）</span>
          <Button variant="ghost" size="xs" iconLeft="imagePlus" onClick={onImportClick}>
            导入本地图片
          </Button>
        </div>
        {standaloneRefs.length === 0 ? (
          <div style={lcEmpty}>
            导入草图 / 剧照 / 物品图等，并给每张写一句备注（如「主角红裙参考」「旧怀表道具」）。
            之后在上方画面描述里写「用到上传的旧怀表」，AI 会模糊匹配并拼进提示词。
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {standaloneRefs.map((id) => (
              <div key={id} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                {/* W8-nightly: <img> 替代 background-image 让用户能右键复制/另存 */}
                <img
                  src={imageThumbUrl(slug, { asset_id: id })}
                  alt="参考图缩略图"
                  loading="lazy"
                  style={{
                    width: 64, height: 64, flexShrink: 0, borderRadius: 5,
                    border: "1px solid var(--ink-100)", objectFit: "cover",
                    background: "var(--ink-50)",
                  }}
                />
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                  <input
                    value={referenceNotes[id] ?? ""}
                    onChange={(e) => setNote(id, e.target.value)}
                    placeholder="这是什么？如：主角红裙参考 / 咖啡馆场景 / 道具：旧怀表"
                    style={lcNoteInput}
                  />
                  <span style={{ fontSize: 10, color: "var(--ink-400)" }}>
                    在画面描述里提到这个备注，AI 会自动把它拼进提示词
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="xs"
                  iconLeft="close"
                  title="移除此参考素材"
                  aria-label="移除此参考素材"
                  onClick={() => removeRef(id)}
                >
                  移除
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <LibraryPickerModal
        open={pickerTarget === "character"}
        slug={slug}
        source="project"
        acceptedKinds={["character"]}
        defaultKind="character"
        multi
        selectedIds={characterIds}
        title="选要出境的角色"
        onClose={() => setPickerTarget(null)}
        onConfirm={confirmCharacters}
      />
      <LibraryPickerModal
        open={pickerTarget === "scene"}
        slug={slug}
        source="project"
        acceptedKinds={["scene"]}
        defaultKind="scene"
        selectedIds={sceneId ? [sceneId] : []}
        title="选本镜场景"
        onClose={() => setPickerTarget(null)}
        onConfirm={confirmScene}
      />
      {/* 2026-05-18: 项目素材选择器 — 物品 / 服装 / 参考 / 杂物 多选 */}
      <LibraryPickerModal
        open={pickerTarget === "element"}
        slug={slug}
        source="project"
        acceptedKinds={PROJECT_ELEMENT_KINDS}
        defaultKind="prop"
        multi
        selectedIds={elementIds}
        title="选项目素材（物品 / 服装 / 参考 / 杂物）"
        onClose={() => setPickerTarget(null)}
        onConfirm={confirmProjectElements}
      />
    </div>
  );
}

// ─── ElementChip — 项目素材横向滑条卡片（带 kind 角标）─────────────
interface ElementChipProps {
  element: ElementData;
  bound: boolean;
  expanded: boolean;
  picked?: PickableAsset;
  variants?: PickableAsset[];
  aspectRatio?: string;
  onToggleBind: () => void;
  onToggleExpand: () => void;
}

function ElementChip(props: ElementChipProps) {
  const { element, bound, expanded, picked, variants, aspectRatio = "1/1", onToggleBind, onToggleExpand } = props;
  const [hover, setHover] = useState(false);
  const list = variants ?? [];
  const primary = element.images.find((img) => img.image_id === element.primary_image_id) ?? element.images[0];
  const cover = picked ? picked.url
    : (primary ? imageThumbUrl(element.series_slug, primary) : "")
    || list[0]?.url || "";

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 112, flex: "0 0 auto", borderRadius: 10, overflow: "hidden",
        border: bound ? "1.5px solid var(--brand-400)" : "1px solid var(--ink-150)",
        background: bound ? "var(--brand-50)" : "var(--surface-card)",
        transition: "transform .12s ease, box-shadow .12s ease",
        transform: hover ? "translateY(-2px)" : "none",
        boxShadow: hover ? "0 6px 16px rgba(160,86,55,0.14)" : "none",
      }}
    >
      <div
        onClick={onToggleBind}
        style={{
          position: "relative", aspectRatio: aspectRatio, cursor: "pointer",
          background: cover ? undefined : "linear-gradient(135deg, var(--ink-50), var(--ink-100))",
          display: "grid", placeItems: "center", overflow: "hidden",
        }}
      >
        {cover ? (
          <img src={cover} alt={primary?.display_name?.trim() || primary?.note?.trim() || element.name} loading="lazy" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <Icon name="image" size={20} style={{ color: "var(--ink-300)" }} />
        )}
        {/* kind 角标 — 区分 4 类 */}
        <span style={lcKindBadge}>{ELEMENT_KIND_LABEL[element.kind]}</span>
        {bound && (
          <span style={lcCheckBadge}><Icon name="check" size={11} /></span>
        )}
      </div>
      <div style={{ padding: "6px 7px 7px" }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--ink-900)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{element.name}</div>
        <div style={{ fontSize: 10, color: "var(--ink-500)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {list.length > 0 ? `${list.length} 张可选图` : "未生成图"}
        </div>
        {bound && (
          <button
            onClick={onToggleExpand}
            style={{
              marginTop: 5, width: "100%", height: 24, borderRadius: 6, cursor: "pointer",
              border: "1px solid var(--ink-150)", background: "var(--surface-card)",
              display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 3,
              fontSize: 10.5, fontWeight: 600, color: picked ? "var(--brand-700)" : "var(--ink-600)",
            }}
            title={picked ? `已选：${picked.label}` : "选具体素材"}
          >
            <Icon name="layers" size={10} />
            <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {picked ? picked.label : "选素材"}
            </span>
            <Icon name={expanded ? "chevDown" : "chevRight"} size={10} />
          </button>
        )}
      </div>
    </div>
  );
}
// health-ignore: ElementChip 内嵌"选素材"按钮保留 inline-style — 要展示品牌/中性双色(picked状态)，Button 组件不支持此颜色切换

// ─── EntityChip — 横向滑条里的单张实体卡 ───────────────────────
interface EntityChipProps {
  kind: "character" | "scene";
  name: string;
  sub: string;
  /** 2026-05-18: 素材管理里设置的主图 url — 未展开"选素材"前默认显示 (同步素材管理设置) */
  primaryImageUrl?: string;
  bound: boolean;
  expanded: boolean;
  picked?: PickableAsset;
  variants?: PickableAsset[];
  aspectRatio?: string;
  onToggleBind: () => void;
  onToggleExpand: () => void;
}

function EntityChip(props: EntityChipProps) {
  const { kind, name, sub, primaryImageUrl, bound, expanded, picked, variants, aspectRatio = "1/1", onToggleBind, onToggleExpand } = props;
  const [hover, setHover] = useState(false);
  const list = variants ?? [];
  // 2026-05-18 优先级: 用户在 modal 内挑的具体图 > 素材管理设置的主图 > variants 列表第一张 > 占位
  //   primaryImageUrl 解决"未展开前永远占位"问题, 跟素材管理主图同步.
  const cover = picked ? picked.url : primaryImageUrl || list[0]?.url || "";

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 112, flex: "0 0 auto", borderRadius: 10, overflow: "hidden",
        border: bound ? "1.5px solid var(--brand-400)" : "1px solid var(--ink-150)",
        background: bound ? "var(--brand-50)" : "var(--surface-card)",
        transition: "transform .12s ease, box-shadow .12s ease",
        transform: hover ? "translateY(-2px)" : "none",
        boxShadow: hover ? "0 6px 16px rgba(160,86,55,0.14)" : "none",
      }}
    >
      <div
        onClick={onToggleBind}
        style={{
          position: "relative", aspectRatio: aspectRatio, cursor: "pointer",
          background: cover ? undefined : "linear-gradient(135deg, var(--ink-50), var(--ink-100))",
          display: "grid", placeItems: "center", overflow: "hidden",
        }}
      >
        {/* W8-nightly: <img> 替代 background-image (右键复制 / 另存) */}
        {cover ? (
          <img src={cover} alt={name} loading="lazy" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <Icon name={kind === "scene" ? "image" : "user"} size={20} style={{ color: "var(--ink-300)" }} />
        )}
        {bound && (
          <span style={lcCheckBadge}><Icon name="check" size={11} /></span>
        )}
      </div>
      <div style={{ padding: "6px 7px 7px" }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--ink-900)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</div>
        <div style={{ fontSize: 10, color: "var(--ink-500)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</div>
        {bound && (
          <button
            onClick={onToggleExpand}
            style={{
              marginTop: 5, width: "100%", height: 24, borderRadius: 6, cursor: "pointer",
              border: "1px solid var(--ink-150)", background: "var(--surface-card)",
              display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 3,
              fontSize: 10.5, fontWeight: 600, color: picked ? "var(--brand-700)" : "var(--ink-600)",
            }}
            title={picked ? `已选：${picked.label}` : "选具体素材"}
          >
            <Icon name="layers" size={10} />
            <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {picked ? picked.label : "选素材"}
            </span>
            <Icon name={expanded ? "chevDown" : "chevRight"} size={10} />
          </button>
        )}
      </div>
    </div>
  );
}

// ─── VariantPicker — 滑条下方平铺的选图网格 ────────────────────
interface VariantPickerProps {
  entityName: string;
  entityKind: "character" | "scene" | "element";
  variants?: PickableAsset[];
  loading: boolean;
  onClose: () => void;
  slug: string;
  aspectRatio?: string;
  /**
   * 2026-05-27 重设计 — 用户原话: "系统附加的图片素材, 但是左侧素材里并没有
   * 被选中, 也不能多选". 之前 picker 是 shot.reference_asset_ids 单选, 跟
   * 审核弹窗"系统自动附加(4/4)"用的 entity.is_typical 代表图集是两套字段.
   * 用户看到 entity 4 张代表图都自动发, 但 picker 只能单选一张作本镜参考 —
   * UI 与实际行为不一致.
   *
   * 现在主操作改成多选 toggle 代表图集 (is_typical), 跟系统自动附加完全一致:
   *   - 勾选态来自 image.is_typical
   *   - 点击 "代表图" 按钮 → onToggleTypical 调 patchElementImage, 持久化
   *   - 多张可同时已选 (代表图集就是多张, 不该单选)
   */
  onToggleTypical: (v: PickableAsset, nextTypical: boolean) => Promise<void> | void;
}

/**
 * 2026-05-27 重写 #2 — 用户原话: "不要做这种特别大的全覆盖弹窗, 就在原位置弄一个弹窗,
 *   不要把其他地方模糊掉".
 *
 * 改成纯 Popover 内容 (caller 用 Radix Popover 包裹 trigger 按钮, picker 内容
 * 直接渲染 — 不再 BaseDialog 全屏 modal, 不再 backdrop, 不再模糊背景).
 *
 * 设计:
 *  - 紧凑小弹窗, 浮在 chip 旁边
 *  - 缩略图 click = 打开 MediaLightbox 大图预览
 *  - 缩略图右下角"用这张" 按钮 = 选定该图作 reference
 */
function VariantPicker(props: VariantPickerProps) {
  const { entityName, entityKind, variants, loading, onToggleTypical, onClose, slug, aspectRatio = "1/1" } = props;
  const list = variants ?? [];
  const entityKindLabel =
    entityKind === "scene" ? "场景"
    : entityKind === "character" ? "角色"
    : "素材";

  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [lightboxLabel, setLightboxLabel] = useState<string>("");
  // 2026-05-27 — toggle 中的 image_id (单张 toggle 防止双击重复请求)
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const typicalCount = list.filter((v) => v.image.is_typical === true).length;

  // 2026-05-27 大图量优化: 12 张以上自动启用搜索框 + "典型/全部" 过滤,
  //   防止用户在百图列表里翻不到想要的.
  const [query, setQuery] = useState("");
  const hasTypical = useMemo(() => list.some((v) => v.image.is_typical === true), [list]);
  const [onlyTypical, setOnlyTypical] = useState<boolean>(hasTypical && list.length > 12);
  // 计算过滤后列表
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return list.filter((v) => {
      if (onlyTypical && v.image.is_typical !== true) return false;
      if (!q) return true;
      const hay = `${v.image.display_name ?? ""} ${v.label ?? ""} ${(v.image.image_tags ?? []).map((t) => t.value).join(" ")}`.toLowerCase();
      return hay.includes(q);
    });
  }, [list, query, onlyTypical]);

  return (
    <div onClick={(e) => e.stopPropagation()}>
      {/* 头部: 标题 + 收起 */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        marginBottom: 8, paddingBottom: 8,
        borderBottom: "1px solid var(--ink-100)",
      }}>
        <Icon name="layers" size={13} style={{ color: "var(--brand-600)", flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink-900)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            选「{entityName}」用哪张图
            {list.length > 0 && (
              <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 500, color: "var(--ink-500)" }}>
                {filtered.length === list.length
                  ? `(共 ${list.length} 张)`
                  : `(显示 ${filtered.length} / 共 ${list.length} 张)`}
              </span>
            )}
          </div>
          <div style={{ fontSize: 10.5, color: "var(--ink-500)", marginTop: 1 }}>
            勾选的图会作为「代表图集」自动发给 AI {typicalCount > 0 ? `· 已选 ${typicalCount}` : "· 默认全选"}
          </div>
        </div>
        <Button variant="ghost" size="xs" iconLeft="close" onClick={onClose}>收起</Button>
      </div>

      {/* 大图量场景: 搜索框 + 典型过滤 — 12+ 张时显示 */}
      {!loading && list.length > 12 && (
        <div style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "center" }}>
          <div style={{ flex: 1, position: "relative" }}>
            <Icon
              name="search"
              size={11}
              style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "var(--ink-400)" }}
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="按名字 / 标签搜索"
              style={{
                width: "100%", height: 28, padding: "0 8px 0 24px",
                fontSize: 11.5, borderRadius: 6,
                border: "1px solid var(--ink-200)", outline: "none",
                background: "var(--surface-card)",
              }}
            />
          </div>
          {hasTypical && (
            <button
              type="button"
              onClick={() => setOnlyTypical((v) => !v)}
              style={{
                height: 28, padding: "0 10px",
                borderRadius: 6,
                border: onlyTypical ? "1px solid var(--brand-500)" : "1px solid var(--ink-200)",
                background: onlyTypical ? "var(--brand-50)" : "var(--surface-card)",
                color: onlyTypical ? "var(--brand-700)" : "var(--ink-700)",
                fontSize: 11, fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
                display: "inline-flex", alignItems: "center", gap: 4,
              }}
              title={onlyTypical ? "切到看全部图" : "只看标过「典型」的图 (主推图)"}
            >
              <Icon name={onlyTypical ? "star" : "starOutline"} size={11} />
              {onlyTypical ? "仅典型" : "全部"}
            </button>
          )}
        </div>
      )}

      {/* 内容 */}
      {loading ? (
        <div style={{ fontSize: 11.5, color: "var(--ink-400)", padding: "16px 0", textAlign: "center" }}>
          加载素材中…
        </div>
      ) : list.length === 0 ? (
        <div style={{ fontSize: 11.5, color: "var(--ink-500)", padding: "12px 0", lineHeight: 1.55 }}>
          该{entityKindLabel}还没有可用素材。去「素材库」生成或导入图片, 标为「可用」再回来。
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ fontSize: 11.5, color: "var(--ink-500)", padding: "16px 0", textAlign: "center", lineHeight: 1.55 }}>
          没有匹配的图。
          <button
            type="button"
            onClick={() => { setQuery(""); setOnlyTypical(false); }}
            style={{
              marginLeft: 6,
              padding: "2px 8px",
              borderRadius: 5,
              border: "1px solid var(--ink-200)",
              background: "var(--surface-card)",
              color: "var(--brand-700)",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            清除过滤
          </button>
        </div>
      ) : (
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(108px, 1fr))",
          gap: 8,
          maxHeight: 480,
          overflowY: "auto",
        }}>
          {filtered.map((v) => {
            // 2026-05-27 — 勾选态来自 image.is_typical (跟审核弹窗"系统自动附加"一致).
            // 用户原话: "系统附加的图片素材, 但是左侧素材里并没有被选中, 也不能多选" — 修法
            // 是把 picker 主操作改成多选 toggle 代表图集, 跟系统逻辑对齐.
            const on = v.image.is_typical === true;
            const busy = togglingId === v.image.image_id;
            const displayLabel = v.image.display_name?.trim() || v.label;
            return (
              <div
                key={v.id}
                style={{
                  padding: 0,
                  borderRadius: 6,
                  overflow: "hidden",
                  border: on ? "2px solid var(--brand-500)" : "1px solid var(--ink-150)",
                  background: "var(--surface-card)",
                  boxShadow: on ? "0 2px 6px rgba(217,119,87,0.15)" : "none",
                }}
              >
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    setLightboxSrc(imageOriginalUrl(slug, v.image));
                    setLightboxLabel(displayLabel);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setLightboxSrc(imageOriginalUrl(slug, v.image));
                      setLightboxLabel(displayLabel);
                    }
                  }}
                  style={{
                    position: "relative",
                    aspectRatio: aspectRatio,
                    background: "var(--ink-50)",
                    overflow: "hidden",
                    cursor: "zoom-in",
                  }}
                  title="点击放大预览大图"
                >
                  <img
                    src={v.url}
                    alt={displayLabel}
                    loading="lazy"
                    style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
                  />
                  {on && <span style={lcCheckBadge}><Icon name="check" size={9} /></span>}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (busy) return;
                      setTogglingId(v.image.image_id);
                      try {
                        await onToggleTypical(v, !on);
                      } finally {
                        setTogglingId(null);
                      }
                    }}
                    style={{
                      position: "absolute",
                      bottom: 4, right: 4,
                      padding: "2px 6px",
                      borderRadius: 999,
                      background: on ? "var(--brand-600)" : "rgba(255,255,255,0.96)",
                      border: on ? "1px solid var(--brand-600)" : "1px solid var(--ink-200)",
                      color: on ? "#fff" : "var(--ink-800)",
                      fontSize: 9.5, fontWeight: 700,
                      cursor: busy ? "wait" : "pointer",
                      boxShadow: "0 1px 3px rgba(0,0,0,0.18)",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 2,
                      opacity: busy ? 0.6 : 1,
                    }}
                    title={on ? "已加入代表图集 — 再点移出 (会一并取消系统自动附加)" : "加入代表图集 — 生图/视频时自动发给 AI 保持一致性"}
                  >
                    <Icon name={on ? "check" : "plus"} size={8} />
                    {busy ? "保存中" : (on ? "代表图" : "加入代表")}
                  </button>
                </div>
                <InlineLabel
                  value={v.image.display_name}
                  fallback={v.label}
                  onSave={async (newName) => {
                    await patchElementImage(slug, v.element.id, v.image.image_id, { display_name: newName });
                  }}
                  style={{ padding: "3px 6px", fontSize: 10 }}
                />
              </div>
            );
          })}
        </div>
      )}

      {/* 2026-05-27 — 删"清除已选素材" — 用户多选 toggle 直接点单张就行, 不需要批量清 */}

      <MediaLightbox
        open={!!lightboxSrc}
        src={lightboxSrc ?? ""}
        kind="image"
        metadata={lightboxLabel ? { provider: lightboxLabel } : undefined}
        onClose={() => setLightboxSrc(null)}
      />
    </div>
  );
}

// ─── styles ────────────────────────────────────────────────────
const lcLabel: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: "var(--ink-500)", letterSpacing: "0.04em", marginBottom: 8,
};
const lcEmpty: React.CSSProperties = { fontSize: 11.5, color: "var(--ink-400)", lineHeight: 1.6 };
const lcStrip: React.CSSProperties = {
  display: "flex", gap: 10, overflowX: "auto", paddingBottom: 6,
};
const lcCheckBadge: React.CSSProperties = {
  position: "absolute", top: 5, right: 5, width: 18, height: 18, borderRadius: 999,
  background: "var(--brand-500)", color: "#fff", display: "grid", placeItems: "center",
};
const lcKindBadge: React.CSSProperties = {
  position: "absolute", bottom: 5, left: 5,
  background: "rgba(0,0,0,0.65)", color: "#fff",
  fontSize: 9.5, fontWeight: 600, lineHeight: 1,
  padding: "3px 6px", borderRadius: 999,
};
const lcNoteInput: React.CSSProperties = {
  width: "100%", height: 30, borderRadius: 7, border: "1px solid var(--ink-200)",
  background: "var(--surface-card)", padding: "0 9px", outline: "none",
  fontSize: 12, color: "var(--ink-900)",
};
