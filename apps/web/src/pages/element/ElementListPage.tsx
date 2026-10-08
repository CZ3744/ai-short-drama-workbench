/**
 * ElementListPage — 统一素材列表页.
 *
 * 一个组件渲染全部 kind: /studio/:slug/elements (全部) 与
 * /studio/:slug/elements/kind/:kind (按类别). 见 docs/ASSET_MANAGEMENT_REDESIGN.md §8.1.
 *
 * 设计红线: tokens.css 变量 / 6 状态药丸 / mk-* 工具类 / 无 emoji / 无左侧色条卡片.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { showErrorToast } from "../../lib/errorTranslate";
import { Icon } from "../../components/shared/Icon";
import { ROUTES } from "../../lib/routes";
import {
  listElements,
  createElement,
  importElementImage,
  patchElement,
  fileToBase64,
  cardAspectByKind,
  getElementUsage,
  ELEMENT_KIND_LABEL,
  type ElementData,
  type ElementKind,
} from "../../lib/elementApi";
// W5 (2026-05-26): 合并视图 (素材组成员 + 本剧专属) + 来源徽章
// W7 (2026-05-26): 素材组管理统一从这里入口 (新建 / 改名 / 删除 + 多组过滤 chip)
import {
  getEffectiveElements,
  listCasts,
  createCast,
  patchCast,
  deleteCast,
  shareElementToGroups,
  type CastWithUsage,
} from "../../lib/castApi";
import { ManageGroupsDialog } from "../../components/element/ManageGroupsDialog";
import { useConfirm } from "../../components/ui/ConfirmModal";
import { InlineLabel } from "../../components/shot-stage/InlineLabel";
import { PromptDialog } from "../../components/ui/prompt-dialog";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { CrossSeriesImportDialog } from "../../components/element/CrossSeriesImportDialog";
import { ExtractFromScriptDialog } from "../../components/element/ExtractFromScriptDialog";
import { BatchElementImageDialog } from "../../components/element/BatchElementImageDialog";
import { Button } from "../../components/ui/button";

const CREATABLE_KINDS: ElementKind[] = ["character", "scene", "prop", "wardrobe", "reference", "misc"];
const FILTER_TABS: { kind: ElementKind | "all"; label: string }[] = [
  { kind: "all", label: "全部" },
  { kind: "character", label: "角色" },
  { kind: "scene", label: "场景" },
  { kind: "prop", label: "物品" },
  { kind: "wardrobe", label: "服装" },
  { kind: "reference", label: "参考照片" },
  { kind: "misc", label: "杂物" },
];

const STATUS_PILL: Record<ElementData["status"], { cls: string; label: string }> = {
  drafted: { cls: "mk-pill--draft", label: "草稿" },
  has_images: { cls: "mk-pill--ready", label: "有候选图" },
  locked: { cls: "mk-pill--approved", label: "已锁定主图" },
};

export default function ElementListPage() {
  const { slug = "", kind: routeKind } = useParams<{ slug: string; kind?: string }>();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const activeKind = (routeKind as ElementKind | undefined) ?? "all";

  // W5: element 含 _source / _cast_id 字段, 来自 effective-elements 合并视图
  const [elements, setElements] = useState<
    Array<ElementData & { _source?: "cast" | "local"; _cast_id?: string }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // W5: 来源过滤 — all = 合并视图, cast = 仅显示来自素材组, local = 仅本剧专属
  const [sourceFilter, setSourceFilter] = useState<"all" | "cast" | "local">("all");
  // W7: 素材组列表 (顶部 chip 栏 + 徽章 tooltip 用)
  const [groups, setGroups] = useState<CastWithUsage[]>([]);
  // W7: 选中的素材组 (chip 多选过滤). 空集 = 不按组过滤 (显示全部 source).
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());
  // W7: 管理素材组弹窗
  const [manageGroupsOpen, setManageGroupsOpen] = useState(false);
  // 2026-07-09 audit (asset-dialog lane): 同一弹窗两种入口 —— 顶部"管理素材组"(纯管理) vs
  // 批量条"加入素材组"(把选中素材加进组). 用 mode 区分, 让批量按钮不再是死路.
  const [manageGroupsMode, setManageGroupsMode] = useState<"manage" | "add">("manage");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<ElementKind>("prop");
  // 2026-07-22 X5-5 (A4-12): 抽出共享 handler —— 工具栏"新建素材"按钮和空状态内嵌 CTA
  // 复用同一开表单逻辑, 避免两处各写一份重复实现(解耦信仰).
  const openCreateForm = () => {
    setCreating((v) => {
      const next = !v;
      // 2026-07-09 audit (asset-dialog lane): 打开新建表单时默认类型跟随当前类别 tab,
      // 否则在"角色"tab 建了默认"物品", 会被 activeKind 过滤掉 —— 建完像凭空消失(铁律5).
      if (next) setNewKind(activeKind === "all" ? "prop" : (activeKind as ElementKind));
      return next;
    });
  };
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [extractOpen, setExtractOpen] = useState(false);
  // 2026-05-19 #4: 一键补全所有素材图 (走 only_element_images Auto Pipeline)
  const [showBatchElementImage, setShowBatchElementImage] = useState(false);
  // P1-1: 搜索框 — debounce 按 name/description/tags 过滤
  const [searchText, setSearchText] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchText.trim().toLowerCase()), 250);
    return () => clearTimeout(t);
  }, [searchText]);
  // P1-2: 排序下拉
  const [sortBy, setSortBy] = useState<"updated_at" | "name" | "image_count" | "typical_count">("updated_at");
  // P1-3: 批量多选
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const quickThrowInputRef = useRef<HTMLInputElement | null>(null);

  // 2026-05-19 #14: 快速扔图改为页面级 PromptDialog (取代 window.prompt 浏览器原生弹窗).
  // 用户原话"要做成页面级别的弹窗" — 一致体验,有设计感.
  const [quickThrowDialog, setQuickThrowDialog] = useState<{
    open: boolean;
    file: File | null;
    fallback: string;
    busy: boolean;
  }>({ open: false, file: null, fallback: "", busy: false });

  async function refresh() {
    if (!slug) return;
    setLoading(true);
    setError(null);
    try {
      // W5: 走 effective-elements 合并视图 — 失败 fallback 到 listElements (向后兼容旧服务).
      try {
        const r = await getEffectiveElements(slug, activeKind === "all" ? undefined : { kind: activeKind as ElementKind });
        setElements(r.elements);
      } catch {
        const r2 = await listElements(slug, activeKind === "all" ? undefined : (activeKind as ElementKind));
        // 老接口没 _source — 视为 local
        setElements(r2.elements.map((el) => ({ ...el, _source: "local" as const })));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  // W7: 拉素材组列表 (chip 栏 + 徽章 tooltip + 管理弹窗共用)
  async function refreshGroups() {
    try {
      const r = await listCasts();
      setGroups(r.casts);
    } catch {
      /* silent: chip 栏可空, 列表页主链路不阻塞 */
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, routeKind]);

  useEffect(() => {
    void refreshGroups();
  }, []);

  // W7: 组名查找 (徽章 tooltip 用 — 知道某 element 来自哪个组)
  const groupNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of groups) m.set(g.id, g.name);
    return m;
  }, [groups]);

  // W7: element 反向索引 — id → 出现在哪几个组里 (徽章 "在 N 个组共享" + tooltip 用).
  // 数据源: 组列表里每个组的 member_element_ids.
  const elementGroupMembership = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const g of groups) {
      for (const eid of g.member_element_ids) {
        const arr = m.get(eid) ?? [];
        arr.push(g.id);
        m.set(eid, arr);
      }
    }
    return m;
  }, [groups]);

  const filtered = useMemo(() => {
    let arr = elements;
    if (activeKind !== "all") arr = arr.filter((el) => el.kind === activeKind);
    // W5: 来源过滤 (合并视图下用户挑"仅素材组"或"仅本剧专属")
    if (sourceFilter === "cast") arr = arr.filter((el) => el._source === "cast");
    else if (sourceFilter === "local") arr = arr.filter((el) => el._source !== "cast");
    // W7: 按素材组过滤 — chip 多选时取交集 (element 必须出现在所有选中的组里; 简化策略改"在选中的任一个组里" 更合用户直觉)
    if (selectedGroupIds.size > 0) {
      arr = arr.filter((el) => {
        const member = elementGroupMembership.get(el.id) ?? [];
        return member.some((gid) => selectedGroupIds.has(gid));
      });
    }
    // P1-1: 搜索框 — 按 name/description/tags.value 过滤
    if (debouncedSearch) {
      arr = arr.filter((el) => {
        if (el.name.toLowerCase().includes(debouncedSearch)) return true;
        if (el.description?.toLowerCase().includes(debouncedSearch)) return true;
        if (el.tags.some((t) => t.value?.toLowerCase().includes(debouncedSearch))) return true;
        return false;
      });
    }
    // P1-4: 置顶排最前 (attrs.pinned === true)
    // P1-2: 排序
    arr = [...arr].sort((a, b) => {
      // 置顶始终排最前
      const pinA = (a.attrs as Record<string, unknown>)?.pinned === true ? 1 : 0;
      const pinB = (b.attrs as Record<string, unknown>)?.pinned === true ? 1 : 0;
      if (pinA !== pinB) return pinB - pinA;
      switch (sortBy) {
        case "name":
          return a.name.localeCompare(b.name, "zh-CN");
        case "image_count":
          return b.images.length - a.images.length;
        case "typical_count": {
          const ta = a.images.filter((im) => im.is_typical === true).length;
          const tb = b.images.filter((im) => im.is_typical === true).length;
          return tb - ta;
        }
        default: // updated_at
          return b.updated_at.localeCompare(a.updated_at);
      }
    });
    return arr;
  }, [elements, activeKind, sourceFilter, selectedGroupIds, elementGroupMembership, debouncedSearch, sortBy]);

  async function handleCreate() {
    if (!newName.trim()) return;
    try {
      const r = await createElement(slug, { kind: newKind, name: newName.trim() });
      setCreating(false);
      setNewName("");
      toast.success(`已加入素材库：${r.element.name}`, { duration: 2400 });
      // 2026-07-09 audit (asset-dialog lane): 若新素材类型不在当前类别 tab 下, 跳到对应 tab —
      // 否则 filtered 会按 activeKind 过滤掉它, 出现"成功 toast 但列表没动 / 素材凭空消失"(违反铁律5).
      if (activeKind !== "all" && newKind !== activeKind) {
        navigate(ROUTES.elementsByKind(slug, newKind));
      } else {
        // 留在列表页 + refresh 让新素材立即出现
        await refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function validateDisplayName(value: string): string | null {
    const name = value.trim();
    if (!name) return "展示名不能为空";
    if (name.length > 50) return "展示名最多 50 个字";
    if (/[\\/]/.test(name)) return "展示名不能包含路径分隔符";
    return null;
  }

  function handleQuickThrow(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    const fallback = file.name.replace(/\.[^.]+$/, "").slice(0, 50) || "未命名杂物";
    // 2026-05-19 #14: 不再用 window.prompt — 打开页面级 PromptDialog 让用户输入展示名.
    setQuickThrowDialog({ open: true, file, fallback, busy: false });
  }

  async function submitQuickThrow(rawName: string) {
    const { file } = quickThrowDialog;
    if (!file) {
      setQuickThrowDialog((s) => ({ ...s, open: false, file: null, busy: false }));
      return;
    }
    const displayName = rawName.trim();
    const invalid = validateDisplayName(displayName);
    if (invalid) {
      toast.error(invalid);
      return;
    }
    setQuickThrowDialog((s) => ({ ...s, busy: true }));
    try {
      const created = await createElement(slug, {
        kind: "misc",
        name: displayName,
        description: "快速扔图导入的零散参考素材",
      });
      const { base64, mime, filename } = await fileToBase64(file);
      await importElementImage(slug, created.element.id, {
        image_base64: base64,
        mime,
        filename,
        note: filename,
        display_name: displayName,
      });
      await refresh();
      toast.success(`已放进杂物：${displayName}`);
      setQuickThrowDialog({ open: false, file: null, fallback: "", busy: false });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setQuickThrowDialog((s) => ({ ...s, busy: false }));
    } finally {
      if (quickThrowInputRef.current) quickThrowInputRef.current.value = "";
    }
  }

  function cancelQuickThrow() {
    setQuickThrowDialog({ open: false, file: null, fallback: "", busy: false });
    if (quickThrowInputRef.current) quickThrowInputRef.current.value = "";
  }

  function openElement(el: ElementData) {
    navigate(ROUTES.elementDetail(slug, el.id));
  }

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto", padding: "24px 32px" }}>
      {/* 头部 — 2026-05-26 Codex P2-9: flex-wrap 让窄屏(1280×720)按钮换行不挤压介绍文案,
          介绍区 minWidth 防止中文字符被挤成逐字竖排. */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 8, gap: 16, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 320px", minWidth: 280 }}>
          <h1
            style={{
              fontFamily: "'Noto Serif SC', 'Source Han Serif SC', serif",
              fontSize: 24,
              fontWeight: 700,
              color: "var(--ink-900)",
              margin: 0,
            }}
          >
            素材库
          </h1>
          <p style={{ fontSize: 13, color: "var(--ink-500)", marginTop: 4, maxWidth: 560 }}>
            素材库是整部剧的视觉一致性「真相源」。角色、场景、物品、参考照片都在这里统一管理，分镜生成时取锚定参考。
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            ref={quickThrowInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => handleQuickThrow(e.target.files)}
          />
          <Button variant="secondary" iconLeft="upload" onClick={() => quickThrowInputRef.current?.click()}>
            快速扔图
          </Button>
          <Button variant="secondary" iconLeft="image" onClick={() => setImportModalOpen(true)}>
            从其他项目导入
          </Button>
          <Button variant="secondary" iconLeft="sparkles" onClick={() => setExtractOpen(true)}>
            从剧本一键生成
          </Button>
          <Button variant="secondary" iconLeft="trash" onClick={() => navigate(ROUTES.elementsTrash())}>
            回收站
          </Button>
          {/* W7 (2026-05-26): 素材组管理整合到素材库 — 不再独立"剧组"入口. */}
          <Button
            variant="secondary"
            iconLeft="grid"
            onClick={() => {
              setManageGroupsMode("manage");
              setManageGroupsOpen(true);
            }}
            title="把跨剧反复出现的角色 / 场景放进一个素材组, 多部剧共用同一组素材"
          >
            管理素材组
          </Button>
          {/* 2026-05-19 #4: 一键补全素材图 — 走 only_element_images 路径 */}
          <Button
            variant="primary"
            iconLeft="sparkles"
            title="为所有还没生成参考图的素材自动按顺序补全"
            onClick={() => setShowBatchElementImage(true)}
          >
            一键补全素材图
          </Button>
          <Button
            variant="primary"
            iconLeft="grid"
            onClick={openCreateForm}
          >
            新建素材
          </Button>
        </div>
      </div>

      {/* 新建行 */}
      {creating ? (
        <div
          className="mk-card"
          style={{ padding: 14, marginBottom: 16, display: "flex", gap: 10, alignItems: "center" }}
        >
          <Select
            value={newKind}
            onChange={(v) => setNewKind(v as ElementKind)}
            options={CREATABLE_KINDS.map((k) => ({ value: k, label: ELEMENT_KIND_LABEL[k] }))}
            ariaLabel="新建素材类型"
            maxWidth={140}
          />
          <Input
            placeholder="素材名称，如「主角的怀表」"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            className="flex-1"
            autoFocus
          />
          <Button variant="primary" onClick={handleCreate}>
            创建
          </Button>
          <Button variant="ghost" onClick={() => setCreating(false)}>
            取消
          </Button>
        </div>
      ) : null}

      {/* 类别筛选 tabs */}
      <div className="mk-tab-group" style={{ marginBottom: 12, flexWrap: "wrap" }}>
        {FILTER_TABS.map((tab) => {
          const isActive = tab.kind === activeKind;
          return (
            <button
              key={tab.kind}
              className={`mk-tab ${isActive ? "mk-tab--active" : ""}`}
              onClick={() =>
                navigate(
                  tab.kind === "all" ? ROUTES.elements(slug) : ROUTES.elementsByKind(slug, tab.kind),
                )
              }
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* W7 (2026-05-26): 按素材组过滤 — 多选 chip 栏. 没素材组时整栏隐藏. */}
      {groups.length > 0 ? (
        <div
          style={{
            marginBottom: 12,
            padding: "10px 12px",
            background: "var(--surface-canvas)",
            border: "1px dashed var(--ink-200)",
            borderRadius: 10,
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              fontSize: 11.5,
              fontWeight: 700,
              color: "var(--ink-500)",
              letterSpacing: "0.05em",
            }}
          >
            按素材组过滤:
          </span>
          {groups.map((g) => {
            const active = selectedGroupIds.has(g.id);
            return (
              <button
                key={g.id}
                onClick={() => {
                  setSelectedGroupIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(g.id)) next.delete(g.id);
                    else next.add(g.id);
                    return next;
                  });
                }}
                title={`${g.name} · ${g.member_element_ids.length} 个成员 · ${g.referencing_series_count} 部剧用着`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "4px 11px",
                  borderRadius: 999,
                  fontSize: 12,
                  fontWeight: active ? 600 : 500,
                  cursor: "pointer",
                  background: active ? "var(--brand-100, #fde2cf)" : "#fff",
                  color: active ? "var(--brand-700, #c2410c)" : "var(--ink-700)",
                  border: active
                    ? "1px solid var(--brand-400, #d97757)"
                    : "1px solid var(--ink-200)",
                  transition: "background 120ms ease",
                }}
              >
                {active ? <Icon name="check" size={11} /> : null}
                {g.name}
                <span
                  style={{
                    fontSize: 10.5,
                    opacity: 0.6,
                    fontFeatureSettings: '"tnum"',
                  }}
                >
                  · {g.member_element_ids.length}
                </span>
              </button>
            );
          })}
          {selectedGroupIds.size > 0 ? (
            <button
              onClick={() => setSelectedGroupIds(new Set())}
              style={{
                fontSize: 11,
                color: "var(--ink-500)",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                textDecoration: "underline",
                padding: "4px 6px",
              }}
            >
              清空筛选
            </button>
          ) : null}
        </div>
      ) : null}

      {/* W5: 来源切换 — 只在 elements 含 cast 项时显示, 让用户挑"全部 / 仅来自素材组 / 仅本剧专属" */}
      {(() => {
        const castCount = elements.filter((el) => el._source === "cast").length;
        const localCount = elements.filter((el) => el._source !== "cast").length;
        if (castCount === 0) return null;
        const tabs: Array<{ key: typeof sourceFilter; label: string }> = [
          { key: "all", label: `全部 (${castCount + localCount})` },
          { key: "cast", label: `仅来自素材组 (${castCount})` },
          { key: "local", label: `仅本剧专属 (${localCount})` },
        ];
        return (
          <div className="mk-tab-group" style={{ marginBottom: 18, flexWrap: "wrap" }}>
            {tabs.map((t) => (
              <button
                key={t.key}
                className={`mk-tab ${sourceFilter === t.key ? "mk-tab--active" : ""}`}
                onClick={() => setSourceFilter(t.key)}
                style={{ fontSize: 12 }}
              >
                {t.label}
              </button>
            ))}
          </div>
        );
      })()}

      {/* P1-1: 搜索框 + P1-2: 排序下拉 + P1-3: 批量操作条 */}
      {filtered.length > 0 || debouncedSearch || selectedIds.size > 0 ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
          <div style={{ position: "relative", flex: "1 1 200px", maxWidth: 360 }}>
            <Icon name="search" size={14} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--ink-400)", pointerEvents: "none" }} />
            <Input
              placeholder="搜索素材名称、描述、标签…"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              style={{ paddingLeft: 32, height: 34 }}
            />
          </div>
          <Select
            value={sortBy}
            onChange={(v) => setSortBy(v as typeof sortBy)}
            options={[
              { value: "updated_at", label: "最近更新" },
              { value: "name", label: "名称 A→Z" },
              { value: "image_count", label: "图片数" },
              { value: "typical_count", label: "代表图数" },
            ]}
            ariaLabel="排序方式"
            maxWidth={140}
          />
          {/* P1-3: 批量多选 — 全选 / 取消 */}
          {filtered.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              iconLeft={selectedIds.size === filtered.length && filtered.length > 0 ? "check" : "grid"}
              onClick={() => {
                if (selectedIds.size === filtered.length) {
                  setSelectedIds(new Set());
                } else {
                  setSelectedIds(new Set(filtered.map((el) => el.id)));
                }
              }}
            >
              {selectedIds.size === filtered.length && filtered.length > 0 ? "取消全选" : "全选"}
            </Button>
          )}
          {debouncedSearch && (
            <span style={{ fontSize: 12, color: "var(--ink-400)" }}>
              匹配 {filtered.length} 项
            </span>
          )}
        </div>
      ) : null}

      {/* P1-3: 批量操作条 — 选中 N 个素材时出现 */}
      {selectedIds.size > 0 && (
        <div
          style={{
            display: "flex", alignItems: "center", gap: 10, marginBottom: 14, padding: "10px 14px",
            background: "var(--brand-50, #fff7ed)", border: "1px solid var(--brand-200, #fed7aa)",
            borderRadius: 10, flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--brand-700)" }}>
            已选 {selectedIds.size} 个素材
          </span>
          <span style={{ flex: 1 }} />
          <Button
            variant="secondary"
            size="sm"
            iconLeft="grid"
            onClick={() => {
              // 2026-07-09 audit (asset-dialog lane): 走 add 模式打开弹窗 —— 弹窗里每个组有"加入此组"
              // 按钮, 真把选中素材写进组. 不再是"点了只打开组管理弹窗、无处落地"的死路.
              setManageGroupsMode("add");
              setManageGroupsOpen(true);
            }}
          >加入素材组</Button>
          <Button
            variant="danger"
            size="sm"
            iconLeft="trash"
            onClick={async () => {
              // 2026-07-09 audit (asset-dialog lane): 批量删除加二次确认, 与单个删除一致(铁律6).
              // 批量误触代价更大, 更该确认.
              // P2-8 (2026-07-10): 删前聚合查引用, 让用户知道"选中素材还牵连多少镜"(铁律#6 二次确认要给决策信息);
              // 全程"第 N 镜"人话, 不暴露 s0001(铁律#9). 查询失败降级为老文案, 不阻塞删除.
              let description = "素材会移入回收站, 90 天内可在回收站恢复。";
              try {
                const usages = await Promise.all(
                  [...selectedIds].map((id) => getElementUsage(slug, id).catch(() => null)),
                );
                const affectedShots = new Set<string>();
                let referencedCount = 0;
                for (const u of usages) {
                  if (u && u.total_count > 0) {
                    referencedCount++;
                    for (const x of u.usage) affectedShots.add(`${x.episode_id}:${x.shot_id}`);
                  }
                }
                if (referencedCount > 0) {
                  description =
                    `选中的 ${selectedIds.size} 个素材中，有 ${referencedCount} 个正被分镜引用（共牵连 ${affectedShots.size} 镜）。` +
                    "移入回收站后这些分镜会失去形象参考，生成时会提示缺素材。90 天内可在回收站恢复。";
                }
              } catch {
                /* 引用查询失败不阻塞删除 — 降级为老文案 */
              }
              const ok0 = await confirm({
                title: `移到回收站 ${selectedIds.size} 个素材?`,
                description,
                confirmLabel: "移到回收站",
                cancelLabel: "取消",
                variant: "destructive",
              });
              if (!ok0) return;
              let ok = 0;
              let fail = 0;
              let hadRefWarnings = false;
              for (const id of selectedIds) {
                try {
                  const { deleteElement: del } = await import("../../lib/elementApi");
                  const res = await del(slug, id);
                  if (res.warnings && res.warnings.length > 0) hadRefWarnings = true;
                  ok++;
                } catch { fail++; }
              }
              setSelectedIds(new Set());
              await refresh();
              if (ok > 0) toast.success(`已移入回收站 ${ok} 个素材${fail > 0 ? `，${fail} 个失败` : ""}`);
              else if (fail > 0) showErrorToast(new Error(`${fail} 个素材删除失败`), "批量删除失败");
              // P2-8: 后端引用警告不再默默丢弃 — 有牵连分镜时给一条汇总提醒(不逐条刷屏, 上面确认框已列明细).
              if (hadRefWarnings) {
                toast.warning("部分素材仍被分镜引用，已移入回收站；请到分镜板更新受影响的镜头。", { duration: 8000 });
              }
            }}
          >移到回收站</Button>
          <Button
            variant="ghost"
            size="sm"
            iconLeft="close"
            onClick={() => setSelectedIds(new Set())}
          >取消选择</Button>
        </div>
      )}

      {/* 列表 */}
      {error ? (
        <div className="mk-card" style={{ padding: 16, color: "var(--err)" }}>
          加载失败：{error}
          <Button variant="ghost" size="sm" iconLeft="refresh" style={{ marginLeft: 10 }} onClick={refresh}>
            重试
          </Button>
        </div>
      ) : loading ? (
        <div style={{ padding: 40, textAlign: "center", color: "var(--ink-400)" }}>加载中…</div>
      ) : filtered.length === 0 ? (
        <div className="mk-card" style={{ padding: 40, textAlign: "center" }}>
          <div style={{ fontSize: 14, color: "var(--ink-600)", marginBottom: 6 }}>
            还没有{activeKind === "all" ? "" : ELEMENT_KIND_LABEL[activeKind as ElementKind]}素材
          </div>
          <div style={{ fontSize: 12.5, color: "var(--ink-400)", marginBottom: 14 }}>
            同一素材会在多个分镜里复用，保持一致。
          </div>
          {/* 2026-07-22 X5-5 (A4-12): 原来只写"点右上「新建素材」开始", 没有内嵌按钮 —
              用户得自己去页面右上角找。空状态块内直接给一个可点击 CTA, 复用工具栏同款 handler。 */}
          <Button variant="primary" iconLeft="grid" onClick={openCreateForm}>
            新建素材
          </Button>
        </div>
      ) : (
        /* 2026-05-19 #10: CSS columns Masonry 布局 — 卡片按各自 aspect 自然流动, 不强求对齐.
           用户原话"角色 portrait, 场景 landscape, 物品 square 不强制对齐, 像七巧板那样铺二维平面". */
        <div
          style={{
            columnWidth: 230,
            columnGap: 14,
          }}
        >
          {filtered.map((el) => {
            const primary = el.images.find((im) => im.image_id === el.primary_image_id) ?? el.images[0];
            const pill = STATUS_PILL[el.status];
            // 2026-05-20 P2: 优先用 is_placeholder 字段判断 (精确), fallback 老 fragile 字符串兜底兼容历史数据
            const isPlaceholder =
              (el as ElementData & { is_placeholder?: boolean }).is_placeholder === true
              // ── fallback: 老数据没有 is_placeholder 字段 ──
              || el.description === "auto-extracted placeholder"
              || (el.kind === "character" && (el as { role?: string }).role === "auto-extracted");
            const isSelected = selectedIds.has(el.id);
            return (
              <div
                key={`${el.kind}-${el.id}`}
                className="mk-card"
                onClick={(e) => {
                  // P1-3: 批量模式下点卡片 toggle 选中, 非批量模式进详情
                  if (selectedIds.size > 0) {
                    e.stopPropagation();
                    setSelectedIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(el.id)) next.delete(el.id);
                      else next.add(el.id);
                      return next;
                    });
                  } else {
                    openElement(el);
                  }
                }}
                style={{
                  padding: 0, overflow: "hidden", cursor: "pointer", display: "flex", flexDirection: "column",
                  // Masonry 关键: 防卡片跨列断开
                  breakInside: "avoid",
                  marginBottom: 14,
                  // 占位素材视觉标记: 虚线橙色描边, 让用户一眼看出"待补图"
                  ...(isPlaceholder ? {
                    border: "1.5px dashed var(--brand-400, #d97757)",
                    background: "var(--brand-25, rgba(217,119,87,0.04))",
                  } : {}),
                  // P1-3: 选中高亮
                  ...(isSelected ? {
                    outline: "2px solid var(--brand-500, #c2410c)",
                    outlineOffset: -2,
                  } : {}),
                }}
                title={isPlaceholder
                  ? "拆分镜时自动建的占位素材 — 还没图. 点开补描述 / 抽图后即可被分镜引用."
                  : undefined}
              >
                {/* P1-3: 批量选择 checkbox — hover 或已选时可见 */}
                <div
                  style={{
                    position: "absolute", top: 8, left: 8, zIndex: 2,
                    width: 22, height: 22, borderRadius: 6,
                    background: isSelected ? "var(--brand-500, #c2410c)" : "rgba(255,255,255,0.85)",
                    border: isSelected ? "none" : "1.5px solid var(--ink-300)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    cursor: "pointer", transition: "all 120ms ease",
                    opacity: isSelected || selectedIds.size > 0 ? 1 : 0,
                  }}
                  className="card-select-checkbox"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(el.id)) next.delete(el.id);
                      else next.add(el.id);
                      return next;
                    });
                  }}
                >
                  {isSelected && <Icon name="check" size={13} style={{ color: "#fff" }} />}
                </div>

                {/* P1-4: 置顶按钮 — hover 或已置顶时可见 */}
                {(() => {
                  const isPinned = (el.attrs as Record<string, unknown>)?.pinned === true;
                  return (
                    <button
                      type="button"
                      aria-label={isPinned ? `取消置顶${el.name}` : `置顶${el.name}`}
                      aria-pressed={isPinned}
                      style={{
                        position: "absolute", top: 8, right: 8, zIndex: 2,
                        width: 26, height: 26, borderRadius: 6,
                        background: isPinned ? "var(--brand-500, #c2410c)" : "rgba(255,255,255,0.85)",
                        border: isPinned ? "none" : "1.5px solid var(--ink-200)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        cursor: "pointer", transition: "all 120ms ease",
                        opacity: isPinned ? 1 : 0.6,
                      }}
                      className="card-pin-btn"
                      title={isPinned ? "取消置顶" : "置顶"}
                      onClick={async (e) => {
                        e.stopPropagation();
                        try {
                          const nextAttrs = { ...(el.attrs ?? {}), pinned: !isPinned };
                          await patchElement(slug, el.id, { attrs: nextAttrs });
                          await refresh();
                          toast.success(isPinned ? "已取消置顶" : "已置顶");
                        } catch (err) {
                          showErrorToast(err, "操作失败");
                        }
                      }}
                    >
                      <Icon name="pin" size={13} style={{ color: isPinned ? "#fff" : "var(--ink-500)" }} />
                    </button>
                  );
                })()}

                <div
                  className={cardAspectByKind(el.kind)}
                  style={{
                    background: "var(--surface-canvas)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    overflow: "hidden",
                  }}
                >
                  {primary?.url ? (
                    <img
                      src={primary.url}
                      alt={primary?.display_name?.trim() || primary?.note?.trim() || el.name}
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                  ) : (
                    <Icon name="image" size={28} style={{ color: "var(--ink-300)" }} />
                  )}
                </div>
                <div style={{ padding: "10px 12px" }} onClick={(e) => e.stopPropagation()}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, flexWrap: "wrap" }}>
                    <span className="mk-chip mk-chip--ghost" style={{ fontSize: 11 }}>
                      {ELEMENT_KIND_LABEL[el.kind]}
                    </span>
                    <span className={`mk-pill ${pill.cls}`} style={{ fontSize: 10.5 }}>
                      {pill.label}
                    </span>
                    {/* 2026-05-19 Wave O Entity-first: 占位素材显眼 badge */}
                    {isPlaceholder ? (
                      <span
                        style={{
                          fontSize: 10.5,
                          padding: "1px 7px",
                          borderRadius: 999,
                          background: "var(--brand-100, rgba(217,119,87,0.12))",
                          color: "var(--brand-700, #c2410c)",
                          fontWeight: 600,
                          border: "1px solid var(--brand-300, rgba(217,119,87,0.3))",
                        }}
                      >
                        待补图
                      </span>
                    ) : null}
                    {/* W7 (2026-05-26): 共享徽章 — 标"在 N 个组共享" / "本剧专属" + tooltip 显具体组名. */}
                    {(() => {
                      const inGroups = elementGroupMembership.get(el.id) ?? [];
                      if (inGroups.length > 0) {
                        const groupNames = inGroups
                          .map((gid) => groupNameById.get(gid) ?? gid)
                          .join("、");
                        return (
                          <span
                            style={{
                              fontSize: 10.5,
                              padding: "1px 7px",
                              borderRadius: 999,
                              background: "#dcfce7",
                              color: "#15803d",
                              fontWeight: 600,
                              border: "1px solid #86efac",
                            }}
                            title={`已加入素材组: ${groupNames} (多部剧共用同一份, 改一处, 用到这些组的剧都同步生效)`}
                          >
                            在 {inGroups.length} 个组共享
                          </span>
                        );
                      }
                      // 本剧专属 — 没出现在任何素材组里
                      return (
                        <span
                          style={{
                            fontSize: 10.5,
                            padding: "1px 7px",
                            borderRadius: 999,
                            background: "var(--ink-100)",
                            color: "var(--ink-600)",
                            fontWeight: 600,
                            border: "1px solid var(--ink-200)",
                          }}
                          title="本剧专属素材, 还没加入任何素材组. 可以在素材详情页添加共享."
                        >
                          本剧专属
                        </span>
                      );
                    })()}
                  </div>
                  {/* 2026-05-17: inline rename - 点击名字 → input → Enter/blur 保存
                      之前用户提过"图片素材底下也要能自己改", 现在补上 (复用 InlineLabel) */}
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink-900)", marginBottom: 2 }}>
                    <InlineLabel
                      value={el.name}
                      fallback="未命名"
                      onSave={async (newName) => {
                        const trimmed = newName.trim();
                        if (!trimmed || trimmed === el.name) return;
                        try {
                          await patchElement(slug, el.id, { name: trimmed });
                          await refresh();
                          toast.success(`已重命名为 "${trimmed}"`);
                        } catch (e) {
                          // 2026-05-28 audit P2: 走 showErrorToast 统一错误翻译
                          showErrorToast(e, "重命名失败");
                          throw e;
                        }
                      }}
                    />
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--ink-500)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {el.description || "（暂无描述）"}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--ink-400)", marginTop: 6 }}>
                    {(() => {
                      // 2026-05-18 三池模型统计: 代表图优先显示, 没有代表图才显示总数.
                      // 2026-07-09 audit: 去掉星号 emoji, 换统一 Icon(spark), 与全站线性图标一致(文件头"无 emoji").
                      const typicalCount = el.images.filter((im) => im.is_typical === true).length;
                      if (typicalCount > 0) {
                        return (
                          <>
                            <span style={{ color: "var(--brand-700, #c2410c)", fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 3 }}>
                              <Icon name="spark" size={12} />
                              {typicalCount} 代表图
                            </span>
                            <span> / {el.images.length} 张 · {el.tags.length} 标签</span>
                          </>
                        );
                      }
                      return `${el.images.length} 张图 · ${el.tags.length} 个标签`;
                    })()}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {importModalOpen ? (
        <CrossSeriesImportDialog
          toSlug={slug}
          onClose={() => setImportModalOpen(false)}
          onImported={() => {
            setImportModalOpen(false);
            void refresh();
          }}
        />
      ) : null}

      {/* 2026-05-19: 从剧本一键生成素材对话框 (LLM 分析剧本 → 落盘 N 个 element) */}
      <ExtractFromScriptDialog
        slug={slug}
        open={extractOpen}
        onClose={() => setExtractOpen(false)}
        onExtracted={() => {
          void refresh();
        }}
      />

      {/* 2026-05-19 #4: 一键补全所有素材图 (走 only_element_images Auto Pipeline) */}
      <BatchElementImageDialog
        open={showBatchElementImage}
        slug={slug}
        onClose={() => {
          setShowBatchElementImage(false);
          // 关闭后 refresh 让新生成的图立刻出现
          void refresh();
        }}
      />

      {/* 2026-05-19 #14: 快速扔图页面级 PromptDialog (取代 window.prompt 浏览器原生弹窗) */}
      <PromptDialog
        open={quickThrowDialog.open}
        title="给这张杂物图起一个展示名"
        description="放进杂物库后, 后续可以在分镜里作参考素材引用。可以随时改名。"
        label="展示名"
        placeholder={quickThrowDialog.fallback}
        defaultValue={quickThrowDialog.fallback}
        confirmText="放进杂物"
        cancelText="取消"
        busy={quickThrowDialog.busy}
        onClose={cancelQuickThrow}
        onSubmit={submitQuickThrow}
      />

      {/* W7 (2026-05-26): 管理素材组弹窗 — 新建 / 改名 / 删除. 改完刷新 chip 栏 + 徽章.
          2026-07-09 audit (asset-dialog lane): add 模式下额外传选中素材 + 加入回调, 让批量"加入素材组"真落地. */}
      <ManageGroupsDialog
        open={manageGroupsOpen}
        groups={groups}
        onClose={() => setManageGroupsOpen(false)}
        memberElementIds={manageGroupsMode === "add" ? Array.from(selectedIds) : undefined}
        onAddMembersToGroup={async (groupId, ids) => {
          let added = 0;
          let already = 0;
          let fail = 0;
          for (const id of ids) {
            try {
              const r = await shareElementToGroups(slug, id, [groupId]);
              const res = r.results.find((x) => x.cast_id === groupId);
              if (res?.status === "added") added++;
              else if (res?.status === "already") already++;
              else fail++;
            } catch {
              fail++;
            }
          }
          await refreshGroups();
          await refresh();
          const gName = groups.find((g) => g.id === groupId)?.name ?? "素材组";
          if (added > 0) {
            toast.success(
              `已把 ${added} 个素材加入「${gName}」` +
                (already > 0 ? `，${already} 个原本就在组里` : "") +
                (fail > 0 ? `，${fail} 个未能加入` : ""),
            );
          } else if (already > 0 && fail === 0) {
            toast.info(`选中的素材已经都在「${gName}」里了`);
          } else {
            showErrorToast(new Error(`${fail} 个素材未能加入「${gName}」`), "加入素材组失败");
          }
        }}
        onCreateGroup={async (name, desc) => {
          await createCast({ name, description: desc || undefined });
          await refreshGroups();
        }}
        onRenameGroup={async (id, name, desc) => {
          await patchCast(id, { name, description: desc });
          await refreshGroups();
        }}
        onDeleteGroup={async (id) => {
          const r = await deleteCast(id);
          await refreshGroups();
          return r.warnings;
        }}
      />
    </div>
  );
}

