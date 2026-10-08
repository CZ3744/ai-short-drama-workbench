/**
 * ElementWorkbench — 统一素材元素详情页 (核心交付).
 *
 * 一个元素 (角色/场景/物品/参考照片/服装) = 一个独立小单元, 用同一套 UI 管理:
 * 名称 / 描述 / 标签 / 多图 / 出现在哪些分镜 / 生图(自由要求+i2i) / 提示词审核 /
 * 本地导入 / 三级废案库. 设计见 docs/ASSET_MANAGEMENT_REDESIGN.md §8.2~§8.5.
 *
 * 设计红线: tokens.css 变量 / 6 状态药丸 / mk-* 工具类 / 无 emoji / 无左侧色条卡片.
 *
 * Wave Z-8: 拆子组件 ElementWorkbenchHeader / Sidebar / Main, 主文件仅管路由 + 数据装载.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToggleSet } from "../../hooks/useToggleSet";
import { useParams, useNavigate } from "react-router-dom";
import { ROUTES } from "../../lib/routes";
import {
  getElement,
  listElements,
  patchElement,
  deleteElement,
  getElementUsage,
  importElementImage,
  patchElementImage,
  compileElementPrompt,
  setPrimaryImage,
  clearPrimaryImage,
  deleteElementImage,
  rejectElementImage,
  listRejects,
  promoteReject,
  importRejectToElement,
  setElementImageAngle,
  trashRejectVaultEntry,
  fileToBase64,
  displayNameOfImage,
  ELEMENT_ANGLE_LABEL,
  ELEMENT_ANGLE_PROMPT,
  ELEMENT_KIND_LABEL,
  autofillElementFromText,
  type ElementAngle,
  type ElementData,
  type ElementImage,
  type ElementTag,
  type ElementKind,
  type ElementUsage,
  type RejectItem,
} from "../../lib/elementApi";
import { toast } from "sonner";
import { useImageGeneration } from "../../hooks/useImageGeneration";
import { useConfirm } from "../../components/ui/ConfirmModal";
import { useSeries } from "../../hooks/useSeries";
import { useTasksStore } from "../../stores/tasksStore";
import { labelOfSource } from "../../lib/sourceLabels";
import { parseUserJsonPayload } from "../../lib/parseUserJsonPayload";
import { showErrorToast } from "../../lib/errorTranslate";
import { invalidateElements } from "../../lib/swrInvalidate";
import type { ImageReferenceInput } from "../../lib/generationApi";
import { Button } from "../../components/ui/button";

type ReferenceElementImage = ElementImage & { sourceElementName?: string };

// Wave Z-8 拆分: 子组件
import { ElementWorkbenchHeader } from "./ElementWorkbenchHeader";
import { ElementWorkbenchSidebar } from "./ElementWorkbenchSidebar";
import { ElementWorkbenchMain } from "./ElementWorkbenchMain";
import { ElementModals } from "./parts/ElementModals";
import { ElementPasteAutofillDialog } from "./parts/ElementPasteAutofillDialog";
import { type KindField } from "./parts/ElementDescriptionEditor";

// ─── 主页面状态常量 ──────────────────────────────────────────────

const KIND_FIELD_SCHEMA: Partial<Record<ElementKind, KindField[]>> = {
  character: [
    { key: "role", label: "角色定位", placeholder: "主角 / 配角 / 反派" },
    {
      key: "appearance",
      label: "外貌",
      type: "textarea",
      placeholder: "十岁男孩, 短发, 圆脸, 身材偏瘦",
      hint: "年龄/脸型/发型/身材等不随场合变的特征 — 给生图模型主要用",
    },
    {
      key: "outfit",
      label: "服装基调",
      type: "textarea",
      placeholder: "蓝色校服 / 古装 / 现代休闲",
      hint: "常穿什么风格的衣服 — 分镜里可被具体场景服装覆盖",
    },
    {
      key: "personality",
      label: "性格",
      type: "textarea",
      placeholder: "活泼 / 内向 / 暴躁",
      hint: "行为基调 — 影响剧本对白和动作, 不进生图提示词",
    },
    { key: "voice_id", label: "默认音色" },
  ],
  scene: [
    { key: "location", label: "地点", placeholder: "咖啡馆 / 桥边 / 实验室" },
    { key: "time_of_day", label: "时段", placeholder: "清晨 / 黄昏 / 雨夜" },
    { key: "mood", label: "氛围", placeholder: "温暖 / 紧张 / 疏离" },
    { key: "visual_style", label: "视觉风格", type: "textarea" },
  ],
};

const ATTR_TAG_AXIS: Record<string, string> = {
  role: "role",
  visual_style: "visual",
  location: "location",
  time_of_day: "time",
  mood: "mood",
};

// ─── 主页面 ──────────────────────────────────────────────────────

export default function ElementWorkbench() {
  const { slug = "", elementId = "" } = useParams<{ slug: string; elementId: string }>();
  const navigate = useNavigate();
  const confirm = useConfirm();

  const [element, setElement] = useState<ElementData | null>(null);
  const [usage, setUsage] = useState<ElementUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const { data: seriesData } = useSeries(slug);
  const seriesTtsProviderId = seriesData?.defaults?.tts_provider_id || "edge_tts";

  // 编辑态
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState<ElementTag[]>([]);
  const [attrs, setAttrs] = useState<Record<string, unknown>>({});
  const [dirty, setDirty] = useState(false);
  const [relatableElements, setRelatableElements] = useState<Array<{ id: string; name: string }>>([]);

  // 生成区
  const [imageModelRef, setImageModelRef] = useState<string | null>(null);
  const [llmModelRef, setLlmModelRef] = useState<string | null>(null);
  const [userInstruction, setUserInstruction] = useState("");
  // 2026-05-26 Codex P1-5 — 从 series.defaults 兜底默认模型. 新建系列勾选的默认图像/LLM 模型真带进素材详情.
  // 用户已主动设过 (imageModelRef !== null) 时不动. seriesData 加载完后跑一次.
  useEffect(() => {
    if (!seriesData) return;
    const def = seriesData.defaults as Record<string, any> | undefined;
    if (!def) return;
    if (imageModelRef === null) {
      const fallback = def.default_image || def.image_provider_id;
      if (fallback) setImageModelRef(String(fallback));
    }
    if (llmModelRef === null) {
      const fallback = def.default_llm || def.llm_provider_id;
      if (fallback) setLlmModelRef(String(fallback));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesData]);

  // AI 智能填表
  const [autofillBusy, setAutofillBusy] = useState(false);
  const [pasteAutofillOpen, setPasteAutofillOpen] = useState(false);
  const [pasteAutofillText, setPasteAutofillText] = useState("");

  // 废案库
  const [rejectTier, setRejectTier] = useState<"element" | "project" | "public">("element");
  const [rejects, setRejects] = useState<RejectItem[]>([]);
  const [rejectBrowserOpen, setRejectBrowserOpen] = useState(false);

  // 候选图放大 + 微调重抽
  const [lightboxImage, setLightboxImage] = useState<{
    url: string;
    sourceLabel?: string;
  } | null>(null);
  const [regenModalImage, setRegenModalImage] = useState<ElementImage | null>(null);

  // 多图勾选
  const [selectedRefImageIds, setSelectedRefImageIds] = useState<string[]>([]);
  const { ids: implicitRefDisabled, add: disableImplicitRef, remove: enableImplicitRef } = useToggleSet<string>();

  // 跨 element 引用
  const [crossRefImages, setCrossRefImages] = useState<ReferenceElementImage[]>([]);
  const [crossRefPickerOpen, setCrossRefPickerOpen] = useState(false);
  const [crossRefLoading, setCrossRefLoading] = useState(false);

  // 占位计数
  const [genProgress, setGenProgress] = useState<{ completed: number; total: number }>({
    completed: 0,
    total: 0,
  });
  const tasksMap = useTasksStore((s) => s.tasks);
  const persistedElementTaskCount = useMemo(() => {
    if (!elementId) return 0;
    return Object.values(tasksMap).filter(
      (t) => t.element_id === elementId && t.kind === "image" && (t.status === "queued" || t.status === "running"),
    ).length;
  }, [tasksMap, elementId]);
  const pendingSkeletonCount = Math.max(
    Math.max(0, genProgress.total - genProgress.completed),
    persistedElementTaskCount,
  );

  // BUG-25 fix: useRef 存储 timer ID，快速调用时 clearTimeout 前一个
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((msg: string) => {
    if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
    setToastMsg(msg);
    flashTimerRef.current = setTimeout(() => {
      setToastMsg(null);
      flashTimerRef.current = null;
    }, 2600);
  }, []);

  const loadElement = useCallback(async () => {
    if (!slug || !elementId) return;
    setLoading(true);
    setError(null);
    try {
      const r = await getElement(slug, elementId);
      setElement(r.element);
      setName(r.element.name);
      setDescription(r.element.description);
      setTags(r.element.tags);
      setAttrs(r.element.attrs ?? {});
      setDirty(false);
      getElementUsage(slug, elementId, r.element.kind)
        .then((u) => setUsage(u.usage))
        .catch(() => setUsage([]));
      listElements(slug)
        .then((items) =>
          setRelatableElements(
            items.elements.filter((el) => el.id !== elementId).map((el) => ({ id: el.id, name: el.name })),
          ),
        )
        .catch(() => setRelatableElements([]));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [slug, elementId]);

  useEffect(() => {
    loadElement();
  }, [loadElement]);

  const loadRejects = useCallback(
    async (tier: "element" | "project" | "public") => {
      try {
        const r = await listRejects({
          tier,
          slug: tier === "public" ? undefined : slug,
          element_id: tier === "element" ? elementId : undefined,
        });
        setRejects(r.items);
      } catch {
        setRejects([]);
      }
    },
    [slug, elementId],
  );

  useEffect(() => {
    loadRejects(rejectTier);
  }, [rejectTier, loadRejects]);

  async function saveMeta(silent = false) {
    if (!element) return;
    try {
      const r = await patchElement(slug, elementId, { name, description, tags, attrs });
      if (!silent) {
        setElement(r.element);
      }
      setDirty(false);
      if (!silent) flash("已保存");
    } catch (e) {
      if (!silent) showErrorToast(e, "保存失败");
    }
  }

  useEffect(() => {
    if (!dirty || !element) return;
    const t = setTimeout(() => {
      void saveMeta(/* silent */ true);
    }, 1200);
    return () => clearTimeout(t);
  }, [dirty, element, name, description, tags, attrs]); // eslint-disable-line react-hooks/exhaustive-deps

  // BUG-20 fix: 用 ref 存储最新 saveMeta，避免 useCallback stale closure
  const saveMetaRef = useRef(saveMeta);
  useEffect(() => { saveMetaRef.current = saveMeta; }, [saveMeta]);
  const ensureElementSaved = useCallback(async () => {
    if (!dirty) return;
    return saveMetaRef.current(/* silent */ true);
  }, [dirty]);

  function updateAttr(key: string, value: string) {
    const field = KIND_FIELD_SCHEMA[element?.kind ?? "prop"]?.find((f) => f.key === key);
    const nextValue: unknown = field?.type === "number" ? (value.trim() ? Number(value) : undefined) : value;
    setAttrs((prev) => ({ ...prev, [key]: nextValue }));
    const tagAxis = ATTR_TAG_AXIS[key];
    if (tagAxis) {
      setTags((prev) => {
        const kept = prev.filter((t) => t.axis !== tagAxis);
        return value.trim() ? [...kept, { axis: tagAxis, value: value.trim() }] : kept;
      });
    }
    setDirty(true);
  }

  function applyAutofillFields(fields: Record<string, string>) {
    if (!element) return;
    const spec = KIND_FIELD_SCHEMA[element.kind] ?? [];
    let appliedCount = 0;
    for (const f of spec) {
      if (f.key === "voice_id") continue;
      const v = fields[f.key];
      if (typeof v !== "string" || !v.trim()) continue;
      const existingVal = attrs[f.key];
      if (existingVal !== undefined && String(existingVal).trim().length > 0) continue;
      updateAttr(f.key, v.trim());
      appliedCount += 1;
    }
    return appliedCount;
  }

  async function handleAutofillFromAi() {
    if (!element) return;
    if (autofillBusy) return;
    const raw = description.trim();
    if (!raw) {
      flash("请先在「文字描述」框输入想要的素材描述");
      return;
    }
    setAutofillBusy(true);
    try {
      const r = await autofillElementFromText(slug, element.kind, {
        raw_text: raw,
        model_ref: llmModelRef ?? undefined,
      });
      const count = applyAutofillFields(r.fields) ?? 0;
      if (count === 0) {
        flash("AI 没能从描述中提取到字段, 试试把描述写得更具体");
      } else {
        flash(`已用 ${labelOfSource(r.provider_id)} 智能填了 ${count} 个字段`);
      }
    } catch (e) {
      showErrorToast(e, "AI 填字段失败");
    } finally {
      setAutofillBusy(false);
    }
  }

  function handleImportAutofillPaste() {
    if (!element) return;
    const r = parseUserJsonPayload<unknown>(pasteAutofillText);
    if (!r.ok) {
      flash(r.message);
      return;
    }
    const parsed = r.data;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      flash("JSON 不是对象格式 — 应该形如 { \"role\": \"主角\", ... }");
      return;
    }
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v == null) continue;
      if (typeof v === "string") fields[k] = v;
      else if (typeof v === "number" || typeof v === "boolean") fields[k] = String(v);
    }
    const count = applyAutofillFields(fields) ?? 0;
    if (count === 0) {
      flash("没有可用字段被填进去 — 字段名要与下方表单一致");
      return;
    }
    flash(`已从外部 AI 结果导入 ${count} 个字段`);
    setPasteAutofillOpen(false);
    setPasteAutofillText("");
  }

  async function handleDelete() {
    if (!element) return;
    // P2-8 (2026-07-10): 删前告知"这个素材还被哪几镜引用", 二次确认要给用户做决定的信息(铁律#6),
    // 全程"第 N 镜"人话不暴露 s0001(铁律#9). 先用已加载的 usage 兜底, 再实时刷新一次拿最新引用;
    // 查询失败不阻塞删除(降级为老文案).
    let usageList: ElementUsage[] = usage;
    try {
      const u = await getElementUsage(slug, elementId, element.kind);
      usageList = u.usage;
    } catch {
      /* 实时查询失败 — 用已加载的 usage 兜底, 仍不阻塞删除 */
    }
    let description = "该素材将移入回收站，90 天内可恢复。";
    if (usageList.length > 0) {
      // 2026-07-10 Fable 二轮验收 P2-8 — shot_index 是 1 基, 直接用不 +1(否则第 1 镜显示成"第 2 镜").
      const sample = usageList.slice(0, 3).map((x) => `第 ${x.shot_index} 镜`).join("、");
      const more = usageList.length > 3 ? ` 等共 ${usageList.length} 镜` : "";
      description =
        `「${element.name}」正被 ${sample}${more} 引用（共 ${usageList.length} 镜）。` +
        "移入回收站后这些分镜会失去它的形象参考，生成时会提示缺素材。90 天内可恢复。";
    }
    const ok = await confirm({
      title: `移到回收站「${element.name}」?`,
      description,
      variant: "destructive",
      confirmLabel: "移到回收站",
    });
    if (!ok) return;
    try {
      const res = await deleteElement(slug, elementId);
      await invalidateElements(slug);
      // 后端引用警告不再默默丢弃 — 逐条 toast.warning(sonner 挂在 app 根, 跳转后仍可见)
      if (res.warnings) for (const w of res.warnings) toast.warning(w, { duration: 8000 });
      navigate(ROUTES.elements(slug));
    } catch (e) {
      showErrorToast(e, "移入回收站失败");
    }
  }

  async function handleImportLocal(files: FileList | File[] | null) {
    if (!files || files.length === 0) return;
    try {
      const fileList = Array.from(files);
      for (const file of fileList) {
        const { base64, mime, filename } = await fileToBase64(file);
        const displayName = filename.replace(/\.[^.]+$/, "").slice(0, 50) || filename;
        await importElementImage(slug, elementId, {
          image_base64: base64,
          mime,
          filename,
          note: filename,
          display_name: displayName,
        });
      }
      flash(`已导入 ${fileList.length} 张本地图片`);
      loadElement();
    } catch (e) {
      showErrorToast(e, "导入失败");
    }
  }

  const allRefImages = useMemo<ReferenceElementImage[]>(() => {
    const own = element?.images ?? [];
    return [...own, ...crossRefImages];
  }, [element?.images, crossRefImages]);

  const buildSelectedReferenceImages = useCallback((): ImageReferenceInput[] => {
    if (!element) return [];
    const refs: ImageReferenceInput[] = [];
    for (const id of selectedRefImageIds) {
      const im = allRefImages.find((x) => x.image_id === id);
      if (!im) continue;
      const baseLabel = im.angle ? `角度:${im.angle}` : displayNameOfImage(im);
      const label = im.sourceElementName ? `${baseLabel} · 来自:${im.sourceElementName}` : baseLabel;
      if (im.asset_id) {
        refs.push({ asset_id: im.asset_id, label });
      } else if (im.vault_id) {
        refs.push({ vault_id: im.vault_id, label });
      }
    }
    return refs;
  }, [element, selectedRefImageIds, allRefImages]);

  const compilePromptForPanel = useCallback(
    async ({ polish, user_instruction }: { polish: boolean; user_instruction?: string }) => {
      const r = await compileElementPrompt(slug, elementId, {
        user_instruction: user_instruction ?? "",
        llm_model_ref: llmModelRef ?? undefined,
        polish,
      });
      if (r.polish_error) flash(`润色未成功,已用模板提示词:${r.polish_error}`);
      const refPreviews: Array<{ url: string; label?: string }> = [];
      for (const id of selectedRefImageIds) {
        const im = allRefImages.find((x) => x.image_id === id);
        if (im?.url) {
          const baseLabel = im.angle ? `角度:${im.angle}` : displayNameOfImage(im);
          refPreviews.push({
            url: im.url,
            label: im.sourceElementName ? `${baseLabel} · 来自:${im.sourceElementName}` : baseLabel,
          });
        }
      }
      return {
        full_prompt: r.full_prompt,
        negative_prompt: r.negative_prompt,
        reference_images: refPreviews,
      };
    },
    [slug, elementId, llmModelRef, flash, selectedRefImageIds, allRefImages],
  );

  const handlePickFromLibraryConfirm = useCallback(
    async (elementIds: string[]) => {
      if (!elementIds.length) return;
      setCrossRefLoading(true);
      try {
        const fetched = await Promise.all(
          elementIds.map((id) => getElement(slug, id).catch(() => null)),
        );
        const newImages: ReferenceElementImage[] = [];
        for (const r of fetched) {
          if (!r) continue;
          const el = r.element;
          const typical = el.images.filter((im) => im.is_typical === true);
          const candidates = typical.length > 0
            ? typical
            : el.primary_image_id
              ? el.images.filter((im) => im.image_id === el.primary_image_id)
              : el.images.slice(0, 1);
          for (const im of candidates) {
            if (allRefImages.some((x) => x.image_id === im.image_id)) continue;
            newImages.push({
              ...im,
              origin: "cross_element_ref" as ElementImage["origin"],
              sourceElementName: el.name,
            });
          }
        }
        if (newImages.length === 0) {
          flash("所选素材无可引用的图片(该素材还没有图)");
          return;
        }
        setCrossRefImages((prev) => [...prev, ...newImages]);
        setSelectedRefImageIds((prev) => {
          const toAdd = newImages.map((im) => im.image_id).filter((id) => !prev.includes(id));
          return [...prev, ...toAdd].slice(0, 8);
        });
        flash(`已引入 ${newImages.length} 张来自其他素材的参考图`);
      } catch (e) {
        showErrorToast(e, "引用素材图失败");
      } finally {
        setCrossRefLoading(false);
      }
    },
    [slug, allRefImages, flash],
  );

  const { trigger: triggerRegen, generating: regenBusy } = useImageGeneration({
    target: { kind: "element", series_slug: slug, target_id: elementId },
    mode: "sync",
    displayName: element?.name,
    confirmBatch: false,
    onSuccess: (result) => {
      const next = result.target_state as ElementData | undefined;
      if (next) setElement(next);
      setRegenModalImage(null);
      flash(`已用此图微调重抽出 ${result.images.length} 张`);
    },
    onError: (err) => {
      showErrorToast(err, "重抽失败");
    },
  });

  const handleRegenConfirm = useCallback(
    async (extra: string) => {
      if (!regenModalImage) return;
      try {
        const r = await compileElementPrompt(slug, elementId, {
          user_instruction: extra,
          i2i_base_image_id: regenModalImage.image_id,
          llm_model_ref: undefined,
          polish: false,
        });
        const refs = buildSelectedReferenceImages();
        await triggerRegen({
          prompt: r.full_prompt,
          negative_prompt: r.negative_prompt,
          model_ref: imageModelRef ?? undefined,
          count: 1,
          i2i_base: { image_id: regenModalImage.image_id },
          reference_images: refs.length > 0 ? refs : undefined,
        });
      } catch (e) {
        showErrorToast(e, "编译提示词失败");
      }
    },
    [regenModalImage, slug, elementId, imageModelRef, triggerRegen, flash, buildSelectedReferenceImages],
  );

  async function handleSetPrimary(imageId: string) {
    try {
      const r = await setPrimaryImage(slug, elementId, imageId);
      setElement(r.element);
      // 2026-05-28 深度打磨 #6: 显示影响范围 — 用户改主图后, 不知道这影响哪些镜头.
      // 现在并行拉 usage 列表, flash 显示"主图已更新, 影响 N 个分镜". 用户原话铁律 #5
      // 状态精确 + 让 cascade 可见. 失败不阻塞主流程 (主图已存, 提示是 nice-to-have).
      try {
        const usage = await getElementUsage(slug, elementId);
        const count = usage.total_count;
        if (count > 0) {
          flash(`主图已更新 — 全项目 ${count} 个分镜会用新参考 (下次抽卡 / 重抽视频时这些镜会引用新主图; 已生成的不会自动重做)`);
        } else {
          flash("已设为主图（暂未被任何分镜引用）");
        }
      } catch {
        flash("已设为主图（全项目锚定参考）");
      }
    } catch (e) {
      showErrorToast(e, "设主图失败");
    }
  }

  async function handleClearPrimary() {
    try {
      const r = await clearPrimaryImage(slug, elementId);
      setElement(r.element);
      flash("已取消主图（图片保留，再次点「设为主图」可重新锚定）");
    } catch (e) {
      showErrorToast(e, "取消主图失败");
    }
  }

  async function handleDeleteImage(imageId: string) {
    try {
      const r = await deleteElementImage(slug, elementId, imageId);
      setElement(r.element);
    } catch (e) {
      showErrorToast(e, "删除图片失败");
    }
  }

  async function handleReject(imageId: string) {
    const ok = await confirm({
      title: "将这张图移到废案库?",
      description: '移走后这张图不出现在图库里, 但可以在"废案库 → 浏览废案"里再导入回来 — 不会真删源文件。',
      variant: "warning",
      confirmLabel: "移入废案库",
    });
    if (!ok) return;
    try {
      const r = await rejectElementImage(slug, elementId, imageId);
      setElement(r.element);
      flash("已移入该素材的废案库 — 在「废案库」可恢复");
      if (rejectTier === "element") loadRejects("element");
    } catch (e) {
      showErrorToast(e, "加入废案库失败");
    }
  }

  async function handleRenameImage(image: ElementImage, newName: string) {
    if (!element) throw new Error("素材未加载");
    const displayName = newName.trim();
    if (!displayName) throw new Error("展示名不能为空");
    if (displayName.length > 50) throw new Error("展示名最多 50 个字");
    if (/[\\/]/.test(displayName)) throw new Error("展示名不能包含 / 或 \\");
    const duplicate = element.images.some(
      (im) => im.image_id !== image.image_id && im.display_name?.trim() === displayName,
    );
    if (duplicate) throw new Error("同一素材内已有同名图片");
    try {
      const r = await patchElementImage(slug, elementId, image.image_id, { display_name: displayName });
      setElement(r.element);
      flash(`已重命名为「${displayName}」`);
    } catch (e) {
      showErrorToast(e, "重命名失败");
      throw e instanceof Error ? e : new Error(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleToggleAvailable(image: ElementImage, next: boolean) {
    try {
      const r = await patchElementImage(slug, elementId, image.image_id, { available_for_shot: next });
      setElement(r.element);
      flash(next ? "已纳入选用集(可被分镜挑选)" : "已退回草稿池(仅在本素材内可见, 不出现在分镜)");
    } catch (e) {
      showErrorToast(e, "更新可用状态失败");
    }
  }

  async function handleToggleTypical(image: ElementImage, next: boolean) {
    try {
      const r = await patchElementImage(slug, elementId, image.image_id, { is_typical: next });
      setElement(r.element);
      flash(next ? "已设为代表图 — 生分镜时自动作生图参考" : "已取消代表图标记");

      if (!next) return;
      let usageList: ElementUsage[] = [];
      try {
        const u = await getElementUsage(slug, elementId, r.element.kind);
        usageList = u.usage;
      } catch {
        return;
      }
      if (usageList.length === 0) return;

      type Grp = { epId: string; shotIds: string[] };
      const groups: Record<string, Grp> = {};
      for (const u of usageList) {
        if (!groups[u.episode_id]) groups[u.episode_id] = { epId: u.episode_id, shotIds: [] };
        if (!groups[u.episode_id].shotIds.includes(u.shot_id)) {
          groups[u.episode_id].shotIds.push(u.shot_id);
        }
      }
      const grpArr = Object.values(groups);
      const totalShots = grpArr.reduce((s, g) => s + g.shotIds.length, 0);

      const ok = await confirm({
        title: `已更新代表图. 是否一键重抽引用此素材的 ${totalShots} 个分镜首帧?`,
        description:
          `· 这个素材被 ${grpArr.length} 个剧集 / ${totalShots} 个分镜引用\n` +
          `· 重抽后这些分镜会用最新代表图作参考, 保持五官 / 主体一致\n` +
          `· 不影响其他没引用此素材的分镜\n` +
          `· 用当前选择的图像模型 (在右侧 ModelPicker 切换)`,
        variant: "default",
        confirmLabel: `一键重抽 (${totalShots} 镜)`,
        cancelLabel: "暂不重抽",
      });
      if (!ok) return;

      let okCount = 0;
      let failCount = 0;
      for (const grp of grpArr) {
        try {
          const { startAutoPipeline } = await import("../../lib/autoPipelineApi");
          await startAutoPipeline(slug, grp.epId, {
            only_firstframes: true,
            shot_ids: grp.shotIds,
            image_provider_id: imageModelRef ?? undefined,
            auto_pick_strategy: "quality_score",
          });
          okCount += 1;
        } catch (err) {
          failCount += 1;
          showErrorToast(err, `启动 ${grp.epId} 失败`);
        }
      }
      flash(
        `已启动 ${okCount} 个管线重抽${failCount > 0 ? ` · ${failCount} 个失败` : ""} — 在主界面进度面板查看`,
      );
    } catch (e) {
      showErrorToast(e, "更新典型标志失败");
    }
  }

  async function handlePromote(vaultId: string, to: "project" | "public") {
    try {
      await promoteReject({ vault_id: vaultId, to, slug });
      flash(`已升级到${to === "project" ? "项目" : "公共"}废案库`);
    } catch (e) {
      showErrorToast(e, "升级失败");
    }
  }

  async function handlePurgeReject(item: RejectItem) {
    const tierLabel =
      rejectTier === "element" ? "本素材" : rejectTier === "project" ? "本项目" : "公共";
    const name = item.element_name ?? "这张废案";
    const ok = await confirm({
      title: `彻底清理「${name}」(${tierLabel}废案库)?`,
      description:
        "· 这张废案会立即从所有废案库消失\n" +
        "· 源文件将移入归档回收站, 90 天后系统自动清理\n" +
        "· 90 天内可以联系开发恢复, 但 UI 上不再可见",
      variant: "destructive",
      confirmLabel: "彻底清理",
    });
    if (!ok) return;
    try {
      await trashRejectVaultEntry(item.vault_id);
      flash("已彻底清理 — 文件进入归档回收站, 90 天后自动删除");
      loadRejects(rejectTier);
    } catch (e) {
      showErrorToast(e, "彻底清理失败");
    }
  }

  async function handleImportReject(vaultId: string) {
    try {
      const r = await importRejectToElement(slug, elementId, vaultId);
      setElement(r.element);
      flash("已从废案库导入回图库");
    } catch (e) {
      showErrorToast(e, "导入失败");
    }
  }

  // W2 (2026-05-26) — 给单张图打 / 更新维度标签 (pose/expression/outfit/lighting/free).
  // 走 PATCH /elements/:id/images/:imageId 接受 image_tags.
  //
  // P1-33 (2026-05-28 audit wave 4): 这里只 throw 不 toast, 由 ImageTagsButton 单点 toast,
  // 避免 caller + callee 双 toast (用户看到错误显示两次).
  async function handleSetImageTags(imageId: string, tags: import("../../lib/elementApi").ImageTag[]) {
    const r = await patchElementImage(slug, elementId, imageId, { image_tags: tags });
    setElement(r.element);
    flash(tags.length > 0 ? `已更新维度标签 (${tags.length} 条)` : "已清空该图维度标签");
  }

  async function handleSetAngle(imageId: string, angle: ElementAngle | null) {
    if (!element) return;
    try {
      const r = await setElementImageAngle(slug, elementId, imageId, angle, element.attrs ?? {});
      setElement(r.element);
      setAttrs(r.element.attrs ?? {});
      flash(angle ? `已标记为「${ELEMENT_ANGLE_LABEL[angle]}」角度` : "已取消角度标签");
    } catch (e) {
      showErrorToast(e, "标记角度失败");
    }
  }

  function handleRegenerateAngle(
    angle: ElementAngle | null,
    modelRef: string | null,
    baseImageId: string,
  ) {
    if (!element) return;
    const baseImage = element.images.find((im) => im.image_id === baseImageId);
    if (!baseImage) return;
    if (modelRef) setImageModelRef(modelRef);
    if (angle) {
      const hint = ELEMENT_ANGLE_PROMPT[angle];
      setUserInstruction(hint);
    }
    setRegenModalImage(baseImage);
  }

  function copyPrompt(im: ElementImage) {
    if (im.prompt_snapshot) {
      navigator.clipboard?.writeText(im.prompt_snapshot).catch(() => {});
      flash("已复制该图的完整提示词");
    } else {
      flash(
        im.origin === "imported"
          ? "导入图无提示词记录(本地导入,非 AI 生成)"
          : im.origin === "legacy"
            ? "该图无提示词记录(早期生成数据未保存提示词,新生图已修复)"
            : "该图无提示词记录(可能是历史数据)"
      );
    }
  }

  if (loading) {
    return <div style={{ padding: 40, textAlign: "center", color: "var(--ink-400)" }}>加载中…</div>;
  }
  if (error || !element) {
    return (
      <div style={{ maxWidth: 720, margin: "40px auto", padding: 24 }}>
        <div className="mk-card" style={{ padding: 24 }}>
          <div style={{ color: "var(--err)", marginBottom: 8 }}>加载素材失败：{error ?? "不存在"}</div>
          <Button variant="secondary" iconLeft="arrowLeft" onClick={() => navigate(ROUTES.elements(slug))}>
            返回素材库
          </Button>
        </div>
      </div>
    );
  }

  const kindFields = KIND_FIELD_SCHEMA[element.kind] ?? [];

  return (
    <div className="element-workbench-page" style={{ maxWidth: 1180, margin: "0 auto", padding: "20px 32px 60px", minHeight: "100%", background: "var(--surface-canvas)" }}>
      <ElementWorkbenchHeader
        element={element}
        name={name}
        dirty={dirty}
        onNameChange={(next) => {
          setName(next);
          setDirty(true);
        }}
        onSave={() => void saveMeta()}
        onBack={() => navigate(ROUTES.elements(slug))}
        onDelete={handleDelete}
      />

      <div className="element-workbench-columns" style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 22, alignItems: "start" }}>
        {/* ── 左栏：信息 (侧边栏) ── */}
        <ElementWorkbenchSidebar
          slug={slug}
          element={element}
          elementId={elementId}
          description={description}
          kindFields={kindFields}
          attrs={attrs}
          tags={tags}
          relatableElements={relatableElements}
          usage={usage}
          seriesTtsProviderId={seriesTtsProviderId}
          llmModelRef={llmModelRef}
          autofillBusy={autofillBusy}
          onDescriptionChange={(next) => {
            setDescription(next);
            setDirty(true);
          }}
          onLlmModelChange={setLlmModelRef}
          onAutofillFromAi={handleAutofillFromAi}
          onOpenPasteAutofill={() => {
            setPasteAutofillText("");
            setPasteAutofillOpen(true);
          }}
          onUpdateAttr={updateAttr}
          onUpdateVoiceCloneSampleUrl={(newUrl) =>
            setAttrs((prev) => ({ ...prev, voice_clone_sample_url: newUrl }))
          }
          onFlash={flash}
          onReloadElement={loadElement}
          onTagsChange={(t) => {
            setTags(t);
            setDirty(true);
          }}
          onOpenElement={(id) => navigate(ROUTES.elementDetail(slug, id))}
          onNavigateToShot={(epId, shotId) =>
            navigate(`/studio/${slug}/shot-stage/${epId}/${shotId}`)
          }
          // W2 (2026-05-26) — character 组合面板写回 element 后, 同步本地 attrs 状态.
          onElementUpdated={(next) => {
            setElement(next);
            setAttrs(next.attrs ?? {});
          }}
        />

        {/* ── 右栏：生成 + 图库 ── */}
        <ElementWorkbenchMain
          slug={slug}
          elementId={elementId}
          element={element}
          imageModelRef={imageModelRef}
          onImageModelChange={setImageModelRef}
          llmModelRef={llmModelRef}
          onLlmModelChange={setLlmModelRef}
          userInstruction={userInstruction}
          compilePromptForPanel={compilePromptForPanel}
          buildSelectedReferenceImages={buildSelectedReferenceImages}
          allRefImages={allRefImages}
          selectedRefImageIds={selectedRefImageIds}
          onSelectedRefImageIdsChange={setSelectedRefImageIds}
          implicitRefDisabled={implicitRefDisabled}
          onToggleImplicitRef={(asset_id, nextActive) => {
            if (nextActive) enableImplicitRef(asset_id);
            else disableImplicitRef(asset_id);
          }}
          onPickFromLibrary={() => setCrossRefPickerOpen(true)}
          onSetGenProgress={setGenProgress}
          onImportLocal={handleImportLocal}
          ensureElementSaved={ensureElementSaved}
          onGenerationSuccess={(result) => {
            const next = result.target_state as ElementData | undefined;
            if (next) setElement(next);
            flash(`已生成 ${result.images.length} 张,已累加进图库`);
          }}
          genProgress={genProgress}
          pendingSkeletonCount={pendingSkeletonCount}
          onSetPrimary={handleSetPrimary}
          onClearPrimary={handleClearPrimary}
          onCopyPrompt={copyPrompt}
          onReject={handleReject}
          onSetAngle={handleSetAngle}
          onSetImageTags={handleSetImageTags}
          onOpenLightbox={(img) => setLightboxImage(img)}
          onOpenRegen={(im) => setRegenModalImage(im)}
          onRenameImage={handleRenameImage}
          onToggleAvailable={handleToggleAvailable}
          onToggleTypical={handleToggleTypical}
          onRegenerateAngle={handleRegenerateAngle}
          rejectTier={rejectTier}
          onRejectTierChange={setRejectTier}
          rejects={rejects}
          onImportReject={handleImportReject}
          onPromoteReject={handlePromote}
          onPurgeReject={handlePurgeReject}
          onOpenRejectBrowser={() => setRejectBrowserOpen(true)}
        />
      </div>

      {/* 提示词审核弹窗 — 已被 ImageGenerationPanel 内部接管, 这里不再重复 */}

      <ElementModals
        slug={slug}
        element={element}
        rejectBrowserOpen={rejectBrowserOpen}
        rejectTier={rejectTier}
        onRejectTierChange={setRejectTier}
        rejects={rejects}
        onImportReject={handleImportReject}
        onPromoteReject={handlePromote}
        onPurgeReject={handlePurgeReject}
        onCloseRejectBrowser={() => setRejectBrowserOpen(false)}
        lightboxImage={lightboxImage}
        onLightboxClose={() => setLightboxImage(null)}
        onCopyPrompt={copyPrompt}
        onOpenRegen={(im) => setRegenModalImage(im)}
        onOpenLightbox={(img) => setLightboxImage(img)}
        regenModalImage={regenModalImage}
        regenBusy={regenBusy}
        defaultExtra={userInstruction}
        imageModelRef={imageModelRef}
        onImageModelRefChange={setImageModelRef}
        onRegenConfirm={(extra) => { void handleRegenConfirm(extra); }}
        onRegenClose={() => { setRegenModalImage(null); setUserInstruction(""); }}
        onRegenInpainted={(newVaultId) => {
          flash(`局部重抽完成,新图已存到资料库(${newVaultId.slice(0, 12)}...) — 请到资料库查看`);
          setRegenModalImage(null);
          loadElement();
        }}
        onRegenPreviewPrompt={() => {
          flash(`完整提示词审核 (含所有参考图缩略图) 在右侧"生成新图"面板 — 关弹窗后能直接点`);
        }}
        allRefImages={allRefImages}
        selectedRefImageIds={selectedRefImageIds}
        onSelectedRefImageIdsChange={setSelectedRefImageIds}
        onPickFromLibrary={() => setCrossRefPickerOpen(true)}
        crossRefPickerOpen={crossRefPickerOpen}
        crossRefLoading={crossRefLoading}
        onCrossRefPickerClose={() => setCrossRefPickerOpen(false)}
        onCrossRefPickerConfirm={(ids) => {
          setCrossRefPickerOpen(false);
          void handlePickFromLibraryConfirm(ids);
        }}
      />

      <ElementPasteAutofillDialog
        open={pasteAutofillOpen}
        text={pasteAutofillText}
        onTextChange={setPasteAutofillText}
        onConfirm={handleImportAutofillPaste}
        onClose={() => setPasteAutofillOpen(false)}
      />

      {/* toast */}
      {toastMsg ? (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            background: "var(--ink-900)",
            color: "#fff",
            padding: "10px 18px",
            borderRadius: 999,
            fontSize: 13,
            zIndex: 300,
            boxShadow: "var(--shadow-lg)",
          }}
        >
          {toastMsg}
        </div>
      ) : null}
    </div>
  );
}
