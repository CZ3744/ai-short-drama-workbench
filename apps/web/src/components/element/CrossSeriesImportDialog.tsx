/**
 * CrossSeriesImportDialog — 跨项目素材导入弹窗 (2026-05-19 #12).
 *
 * 用户原话:"不同项目中出现的素材应该可以互相导入,避免需要每次都从零开始做。"
 *
 * 设计对齐:
 *   - 视觉与 PasteStoryboardDialog 一致: mk-card / max-w-720 / brand 主色
 *   - Select 统一组件 (components/ui/select) — 严禁 native <select>
 *   - kind tab chip 风格跟 ReferencePicker 一致
 *   - 铁律 #3 信息直接可见: 素材网格默认展开, 不折叠
 *   - 铁律 #9 toC 兜底: 不暴露 element_id / asset_id / derived_from 等技术字段
 *   - 铁律 #11 每个按钮有名字: 图标 + 文字
 *
 * API 调用:
 *   - listAllSeries()  — 拉所有系列 (过滤当前)
 *   - listElements()   — 拉来源系列的素材
 *   - importElementFromOtherSeries() — 深拷贝到目标系列
 */

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Icon } from "../shared/Icon";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { BaseDialog } from "../ui/BaseDialog";
import {
  listAllSeries,
  listElements,
  importElementFromOtherSeries,
  cardAspectByKind,
  ELEMENT_KIND_LABEL,
  type ElementData,
  type ElementKind,
} from "../../lib/elementApi";
import { Button } from "../ui/button";

// ─── props ──────────────────────────────────────────────────────────

export interface CrossSeriesImportDialogProps {
  /** 导入目标系列 slug */
  toSlug: string;
  /** 弹窗关闭回调 */
  onClose: () => void;
  /** 导入成功后回调 — 父组件用来刷新列表 */
  onImported: () => void;
}

// ─── Kind tabs ───────────────────────────────────────────────────────

const KIND_TABS: { kind: ElementKind | "all"; label: string }[] = [
  { kind: "all", label: "全部" },
  { kind: "character", label: "角色" },
  { kind: "scene", label: "场景" },
  { kind: "prop", label: "物品" },
  { kind: "wardrobe", label: "服装造型" },
  { kind: "reference", label: "参考照片" },
  { kind: "misc", label: "杂物" },
];

// ─── helpers ─────────────────────────────────────────────────────────

function kindCountLabel(elements: ElementData[], kind: ElementKind | "all"): string {
  const n = kind === "all" ? elements.length : elements.filter((e) => e.kind === kind).length;
  return n > 0 ? `(${n})` : "";
}

// ─── Component ───────────────────────────────────────────────────────

export function CrossSeriesImportDialog({ toSlug, onClose, onImported }: CrossSeriesImportDialogProps) {
  // 系列列表
  const [allSeries, setAllSeries] = useState<Array<{ slug: string; title: string }>>([]);
  const [seriesLoading, setSeriesLoading] = useState(true);

  // 来源选择
  const [fromSlug, setFromSlug] = useState("");

  // 素材列表
  const [elements, setElements] = useState<ElementData[]>([]);
  const [elementsLoading, setElementsLoading] = useState(false);

  // kind 筛选
  const [filterKind, setFilterKind] = useState<ElementKind | "all">("all");

  // 选中素材 + 命名覆盖
  const [pickedId, setPickedId] = useState("");
  const [nameOverride, setNameOverride] = useState("");

  // 导入状态
  const [importing, setImporting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // ── 拉系列列表 ─────────────────────────────────────────────────────
  useEffect(() => {
    setSeriesLoading(true);
    listAllSeries()
      .then((r) => setAllSeries(r.series.filter((s) => s.slug !== toSlug)))
      .catch((e) => setErrorMsg(e instanceof Error ? e.message : String(e)))
      .finally(() => setSeriesLoading(false));
  }, [toSlug]);

  // ── 拉选中系列的素材 ───────────────────────────────────────────────
  useEffect(() => {
    if (!fromSlug) {
      setElements([]);
      setPickedId("");
      return;
    }
    setElementsLoading(true);
    setPickedId("");
    setErrorMsg(null);
    listElements(fromSlug)
      .then((r) => setElements(r.elements))
      .catch((e) => {
        setErrorMsg(e instanceof Error ? e.message : String(e));
        setElements([]);
      })
      .finally(() => setElementsLoading(false));
  }, [fromSlug]);

  // ── 过滤按 kind ─────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    if (filterKind === "all") return elements;
    return elements.filter((e) => e.kind === filterKind);
  }, [elements, filterKind]);

  const pickedEl = elements.find((e) => e.id === pickedId);

  // ── 导入 ────────────────────────────────────────────────────────────
  async function handleImport() {
    if (!fromSlug || !pickedId) return;
    setImporting(true);
    setErrorMsg(null);
    try {
      await importElementFromOtherSeries(toSlug, {
        from_slug: fromSlug,
        element_id: pickedId,
        name_override: nameOverride.trim() || undefined,
      });
      toast.success(`已导入到素材库${nameOverride.trim() ? `：${nameOverride.trim()}` : ""}`, {
        duration: 2400,
      });
      onImported();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setImporting(false);
    }
  }

  // ── Series select options ─────────────────────────────────────────
  const seriesOptions = useMemo(
    () => [
      { value: "__pick__", label: "— 选一个项目 —" },
      // 2026-07-09 audit(铁律9 toC 兜底): 下拉只用系列标题, 不再把技术 slug 拼在标题旁
      // (title（slug）泄漏 URL 机器标识). 选项 value 仍用唯一 slug 保证选择正确, 与姊妹弹窗
      // PromoteFromSeriesDialog 一致.
      ...allSeries.map((s) => ({ value: s.slug, label: s.title })),
    ],
    [allSeries],
  );

  return (
    <BaseDialog
      open={true}
      onClose={onClose}
      busy={importing}
      zIndex={220}
      iconName="upload"
      title="从其他项目导入素材"
      subtitle="把另一项目里的角色、场景、物品一键复制到当前项目。图片走内容寻址，相同图片不重复占存储。"
      ariaLabel="从其他项目导入素材"
      // 2026-05-26 audit #10: 切 tab (kind 切换 / 不同源项目切换) 时弹窗尺寸跳, 用 minWidth/minHeight 稳定外壳.
      minWidth={760}
      minHeight={520}
      footer={
        <>
          <Button variant="ghost" iconLeft="close" disabled={importing} onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            iconLeft="upload"
            loading={importing}
            disabled={importing || !fromSlug || !pickedId}
            onClick={handleImport}
          >
            {importing ? "导入中…" : "导入到当前项目"}
          </Button>
        </>
      }
    >
          {/* 错误提示 */}
          {errorMsg ? (
            <div
              className="mk-card"
              style={{
                padding: "8px 12px",
                marginBottom: 12,
                color: "var(--err)",
                fontSize: 12.5,
                background: "var(--err-bg, #fff1f0)",
              }}
            >
              {errorMsg}
            </div>
          ) : null}

          {/* ── 来源项目选择 ─────────────────────────────────── */}
          <div style={{ marginBottom: 14 }}>
            <div className="mk-label" style={{ marginBottom: 6 }}>
              来源项目
            </div>
            {seriesLoading ? (
              <div style={{ fontSize: 12, color: "var(--ink-400)", padding: "8px 0" }}>
                加载项目列表…
              </div>
            ) : allSeries.length === 0 ? (
              <div
                className="mk-card"
                style={{ padding: "10px 14px", fontSize: 12.5, color: "var(--ink-500)" }}
              >
                没有其他项目。先去 Studio 创建另一个系列，再来导入素材。
              </div>
            ) : (
              <Select
                value={fromSlug || "__pick__"}
                onChange={(v) => setFromSlug(v === "__pick__" ? "" : v)}
                options={seriesOptions}
                ariaLabel="选择来源项目"
                placeholder="选一个项目"
                className="w-full"
              />
            )}
          </div>

          {/* ── 素材列表 (仅选完来源项目后展示) ─────────────── */}
          {fromSlug ? (
            <>
              {/* kind 筛选 chips */}
              <div
                style={{
                  display: "flex",
                  gap: 5,
                  flexWrap: "wrap",
                  marginBottom: 10,
                  alignItems: "center",
                }}
              >
                <span className="mk-label" style={{ marginBottom: 0, marginRight: 4 }}>
                  按类型筛选
                </span>
                {/* 2026-05-20 Wave T S23 — 跨项目导入按类型筛选,迁到 App Store 风格 mk-tab-group */}
                <div className="mk-tab-group">
                  {KIND_TABS.map((tab) => {
                    const isActive = tab.kind === filterKind;
                    const count = kindCountLabel(elements, tab.kind);
                    return (
                      <button
                        key={tab.kind}
                        className={`mk-tab ${isActive ? "mk-tab--active" : ""}`}
                        onClick={() => setFilterKind(tab.kind)}
                      >
                        {tab.label}
                        {count ? (
                          <span style={{ marginLeft: 3, opacity: 0.7 }}>{count}</span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 素材网格 */}
              {elementsLoading ? (
                <div style={{ padding: "20px 0", textAlign: "center", color: "var(--ink-400)", fontSize: 13 }}>
                  加载素材中…
                </div>
              ) : filtered.length === 0 ? (
                <div
                  className="mk-card"
                  style={{ padding: "20px 14px", textAlign: "center", fontSize: 13, color: "var(--ink-500)" }}
                >
                  该项目{filterKind !== "all" ? `暂无「${ELEMENT_KIND_LABEL[filterKind as ElementKind]}」类` : "暂无"}素材
                </div>
              ) : (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
                    gap: 10,
                    marginBottom: 14,
                  }}
                >
                  {filtered.map((el) => {
                    const isPicked = el.id === pickedId;
                    const primary =
                      el.images.find((im) => im.image_id === el.primary_image_id) ?? el.images[0];
                    const typicalCount = el.images.filter((im) => im.is_typical === true).length;
                    // 角色音色徽章
                    const charAttrs = (el.attrs ?? {}) as {
                      voice_id?: string;
                      voice_style_map?: Record<string, string>;
                      voice_clone_sample_url?: string;
                    };
                    const hasVoiceClone =
                      el.kind === "character" && !!charAttrs.voice_clone_sample_url;
                    const hasVoice =
                      el.kind === "character" &&
                      !hasVoiceClone &&
                      !!(charAttrs.voice_id || charAttrs.voice_style_map);

                    return (
                      <div
                        key={el.id}
                        className="mk-card"
                        onClick={() => {
                          setPickedId(el.id);
                          // 重置覆盖名
                          if (el.id !== pickedId) setNameOverride("");
                        }}
                        style={{
                          padding: 6,
                          cursor: "pointer",
                          border: isPicked
                            ? "2px solid var(--brand-500)"
                            : "1px solid var(--ink-200)",
                          position: "relative",
                          transition: "border-color 0.15s",
                        }}
                      >
                        {/* 选中角标 */}
                        {isPicked ? (
                          <div
                            style={{
                              position: "absolute",
                              top: 6,
                              right: 6,
                              width: 18,
                              height: 18,
                              borderRadius: "50%",
                              background: "var(--brand-500)",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              zIndex: 2,
                            }}
                          >
                            <Icon name="check" size={11} style={{ color: "white" }} />
                          </div>
                        ) : null}

                        {/* 缩略图 */}
                        <div
                          className={cardAspectByKind(el.kind)}
                          style={{
                            background: "var(--surface-canvas)",
                            borderRadius: 4,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            marginBottom: 6,
                            overflow: "hidden",
                            position: "relative",
                          }}
                        >
                          {primary?.url ? (
                            <img
                              src={primary.url}
                              alt={primary?.display_name?.trim() || primary?.note?.trim() || el.name}
                              style={{ width: "100%", height: "100%", objectFit: "cover" }}
                            />
                          ) : (
                            <Icon name="image" size={22} style={{ color: "var(--ink-300)" }} />
                          )}
                          {/* 音色徽章 */}
                          {(hasVoice || hasVoiceClone) ? (
                            <div
                              title={
                                hasVoiceClone
                                  ? "带声音克隆样本"
                                  : `带音色：${charAttrs.voice_id || "style_map"}`
                              }
                              style={{
                                position: "absolute",
                                top: 4,
                                left: 4,
                                background: hasVoiceClone
                                  ? "rgba(217,119,6,0.92)"
                                  : "rgba(59,130,246,0.9)",
                                color: "white",
                                fontSize: 9,
                                fontWeight: 600,
                                padding: "1px 5px",
                                borderRadius: 8,
                                display: "flex",
                                alignItems: "center",
                                gap: 3,
                              }}
                            >
                              <Icon name="bolt" size={8} />
                              {hasVoiceClone ? "声音克隆" : "音色"}
                            </div>
                          ) : null}
                        </div>

                        {/* 元信息 */}
                        <div
                          style={{
                            fontSize: 10.5,
                            color: "var(--ink-400)",
                            marginBottom: 2,
                          }}
                        >
                          {ELEMENT_KIND_LABEL[el.kind]}
                        </div>
                        <div
                          style={{
                            fontSize: 12,
                            fontWeight: 600,
                            color: "var(--ink-900)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {el.name}
                        </div>
                        <div style={{ fontSize: 10.5, color: "var(--ink-400)", marginTop: 1 }}>
                          {typicalCount > 0 ? (
                            <>
                              <span
                                style={{ color: "var(--brand-700, #c2410c)", fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 2 }}
                                title="代表图 (自动作生图参考)"
                              >
                                {/* 2026-07-09 audit(铁律8 视觉一致): emoji ⭐ → 统一 Icon(spark 星形) */}
                                <Icon name="spark" size={11} />
                                {typicalCount}
                              </span>
                              <span> / {el.images.length} 图</span>
                            </>
                          ) : (
                            `${el.images.length} 张图`
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* ── 选中素材 — 命名覆盖 ─────────────────────── */}
              {pickedEl ? (
                <div
                  className="mk-card"
                  style={{
                    padding: "12px 14px",
                    marginBottom: 14,
                    background: "var(--brand-50, #fff7ed)",
                    border: "1px solid var(--brand-200, #fed7aa)",
                  }}
                >
                  <div className="mk-label" style={{ marginBottom: 6 }}>
                    自定义导入名称（可选）
                  </div>
                  <Input
                    value={nameOverride}
                    onChange={(e) => setNameOverride(e.target.value)}
                    placeholder={`留空则使用原名「${pickedEl.name}」，重名时自动加"（导入）"后缀`}
                  />
                  <div style={{ fontSize: 11, color: "var(--ink-400)", marginTop: 5 }}>
                    已选：{ELEMENT_KIND_LABEL[pickedEl.kind]}「{pickedEl.name}」
                    （{pickedEl.images.length} 张图）
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
    </BaseDialog>
  );
}
