/**
 * CastDetailPage — IP 容器详情 + 成员管理 (W5 2026-05-26).
 *
 * 三段式布局:
 *   - 顶部: cast.name (inline 改名) + description + 软删 + 引用系列数
 *   - 中段: 4 个 kind tab (character/scene/wardrobe/prop) + member 网格 + "新建/从系列导入" 按钮
 *   - 右侧栏: 挂载本 cast 的 series 列表
 *
 * 设计 (UX 铁律):
 *   - #1 用户控制权: 软删走二次确认 (useConfirm) + warnings 提示
 *   - #2 可干预: 每个 cast member 显示完整字段, 可 inline 编辑名
 *   - #6 数据保留: 删 cast 走软删, 显示"N 部剧受影响"warning
 *   - #9 toC 兜底: 不暴露 cast_id, series 列表用 title (slug 仅当链接 href)
 *   - #11 按钮带文字: 全部按钮含 icon + 文字
 *
 * 实现决策: cast member 卡片点击不进完整 ElementWorkbench (981 行强耦合 series), 走轻量
 * inline 编辑 (改名 + 改描述 + 上传图). 复杂场景未来扩展 CastElementWorkbench 时再独立做.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { showErrorToast } from "../../lib/errorTranslate";
import { Icon } from "../../components/shared/Icon";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { InlineLabel } from "../../components/shot-stage/InlineLabel";
import { useConfirm } from "../../components/ui/ConfirmModal";
import { BaseDialog } from "../../components/ui/BaseDialog";
import { VoiceSelector } from "../../components/element/VoiceSelector";
import { ROUTES } from "../../lib/routes";
import {
  readCast,
  patchCast,
  deleteCast,
  listCastElements,
  createCastElement,
  patchCastElement,
  addCastElementImage,
  deleteCastElementImage,
  promoteSeriesElementToCast,
  uploadCastVoiceSample,
  patchCastVoice,
  removeCastVoice,
  type CastWithUsage,
  type CastVoiceAsset,
} from "../../lib/castApi";
import {
  ELEMENT_KIND_LABEL,
  cardAspectByKind,
  fileToBase64,
  listAllSeries,
  listElements,
  type ElementData,
  type ElementKind,
} from "../../lib/elementApi";
import { listSeries, type SeriesRecord } from "../../lib/seriesApi";

// promote 弹窗目前后端只支持 prop/wardrobe/reference/misc 4 类
const PROMOTE_SUPPORTED_KINDS: ElementKind[] = ["prop", "wardrobe", "reference", "misc"];
const TAB_KINDS: ElementKind[] = ["character", "scene", "wardrobe", "prop"];
const CREATABLE_KINDS: ElementKind[] = ["character", "scene", "prop", "wardrobe", "reference", "misc"];

// 2026-07-09 audit(铁律9 toC 兜底): 情绪 → 中文人话映射. 英文 key 才是 compose/dialogueParser
// 真正查 voice_style_map 用的值 (见 packages/drama/src/dialogueParser.ts EMOTION_CN_TO_EN),
// 不再把裸 english key 甩给创作者.
const EMOTION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "default", label: "默认 (所有对白兜底)" },
  { value: "crying", label: "哭泣" },
  { value: "sad", label: "悲伤" },
  { value: "angry", label: "愤怒" },
  { value: "cold", label: "冷漠" },
  { value: "laugh", label: "大笑" },
  { value: "happy", label: "开心" },
];
const KNOWN_EMOTION_VALUES = new Set(EMOTION_OPTIONS.map((o) => o.value));

export default function CastDetailPage() {
  const { castId = "" } = useParams<{ castId: string }>();
  const navigate = useNavigate();
  const confirm = useConfirm();

  const [cast, setCast] = useState<CastWithUsage | null>(null);
  const [members, setMembers] = useState<ElementData[]>([]);
  const [referencingSeries, setReferencingSeries] = useState<SeriesRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeKind, setActiveKind] = useState<ElementKind>("character");

  // 新建成员表单
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newKind, setNewKind] = useState<ElementKind>("character");
  const [submitting, setSubmitting] = useState(false);

  // promote 弹窗
  const [promoteOpen, setPromoteOpen] = useState(false);

  // 2026-07-09 audit(用户明令红线: 弹窗要页面级, 不用浏览器原生): 编辑剧组描述改用 BaseDialog
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState("");
  const [savingDesc, setSavingDesc] = useState(false);

  // 选中成员侧栏 (轻量 inline 编辑)
  const [selectedId, setSelectedId] = useState<string | null>(null);

  async function refresh() {
    if (!castId) return;
    setLoading(true);
    setError(null);
    try {
      const [castR, memR, seriesR] = await Promise.all([
        readCast(castId),
        listCastElements(castId),
        listSeries(),
      ]);
      setCast(castR.cast);
      setMembers(memR.elements);
      setReferencingSeries((seriesR.series ?? []).filter((s) => s.cast_id === castId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [castId]);

  const filtered = useMemo(() => members.filter((m) => m.kind === activeKind), [members, activeKind]);
  const selectedMember = useMemo(() => members.find((m) => m.id === selectedId) ?? null, [members, selectedId]);

  async function handleRenameCast(newName: string) {
    if (!cast) return;
    const trimmed = newName.trim();
    if (!trimmed || trimmed === cast.name) return;
    try {
      await patchCast(cast.id, { name: trimmed });
      toast.success(`已重命名为「${trimmed}」`);
      await refresh();
    } catch (e) {
      // 2026-05-28 audit P2: 走 showErrorToast 统一错误翻译
      showErrorToast(e, "重命名失败");
      throw e;
    }
  }

  // 2026-07-09 audit(用户明令红线: "弹窗不要做成浏览器层面的, 要做成页面级别的弹窗"):
  // 打开页面级 BaseDialog 编辑描述, 替换原生 window.prompt (割裂 + 无多行/取消保护).
  function handleEditDesc() {
    if (!cast) return;
    setDescDraft(cast.description ?? "");
    setEditingDesc(true);
  }

  async function handleSaveDesc() {
    if (!cast) return;
    const next = descDraft.trim();
    if (next === (cast.description ?? "").trim()) {
      setEditingDesc(false);
      return;
    }
    setSavingDesc(true);
    try {
      await patchCast(cast.id, { description: next });
      toast.success("描述已更新");
      setEditingDesc(false);
      await refresh();
    } catch (e) {
      // 2026-05-28 audit P2: 走 showErrorToast 统一错误翻译
      showErrorToast(e, "修改失败");
    } finally {
      setSavingDesc(false);
    }
  }

  async function handleDeleteCast() {
    if (!cast) return;
    const ok = await confirm({
      title: `送进垃圾桶: 剧组「${cast.name}」?`,
      description:
        cast.referencing_series_count > 0
          ? `当前有 ${cast.referencing_series_count} 部剧用着这个剧组, 删除后这些剧将看不到剧组共享的素材 (但本剧专属素材保留). 数据保留, 可在系统层手动恢复.`
          : "数据保留在系统中, 可手动恢复.",
      confirmLabel: "确认删除",
      cancelLabel: "取消",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      const r = await deleteCast(cast.id);
      if (r.warnings?.length) {
        for (const w of r.warnings) toast.warning(w, { duration: 8000 });
      } else {
        toast.success("已删除");
      }
      navigate("/studio");
    } catch (e) {
      // 2026-05-28 audit P2: 走 showErrorToast 统一错误翻译
      showErrorToast(e, "删除失败");
    }
  }

  async function handleCreateMember() {
    if (!cast) return;
    const name = newName.trim();
    if (!name || submitting) return;
    setSubmitting(true);
    try {
      await createCastElement(cast.id, {
        kind: newKind,
        name,
        description: newDesc.trim() || undefined,
      });
      toast.success(`已新建「${name}」`);
      setCreating(false);
      setNewName("");
      setNewDesc("");
      setActiveKind(newKind);
      await refresh();
    } catch (e) {
      // 2026-05-28 audit P2: 走 showErrorToast 统一错误翻译
      showErrorToast(e, "新建失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRenameMember(member: ElementData, newName: string) {
    if (!cast) return;
    const trimmed = newName.trim();
    if (!trimmed || trimmed === member.name) return;
    try {
      await patchCastElement(cast.id, member.id, { name: trimmed });
      toast.success(`已重命名为「${trimmed}」`);
      await refresh();
    } catch (e) {
      // 2026-05-28 audit P2: 走 showErrorToast 统一错误翻译
      showErrorToast(e, "重命名失败");
      throw e;
    }
  }

  async function handleUploadMemberImage(member: ElementData, file: File) {
    if (!cast) return;
    try {
      const { base64, mime, filename } = await fileToBase64(file);
      await addCastElementImage(cast.id, member.id, {
        origin: "imported",
        url: base64,
        mime,
        display_name: filename,
        note: `从本地导入: ${filename}`,
      });
      toast.success("图片已导入");
      await refresh();
    } catch (e) {
      // 2026-05-28 audit P2: 走 showErrorToast 统一错误翻译
      showErrorToast(e, "导入失败");
    }
  }

  async function handleDeleteMemberImage(member: ElementData, imageId: string) {
    if (!cast) return;
    // 2026-07-09 audit(铁律6 数据保留 + 铁律5 状态精确): 后端 removeCastElementImage 只把这张图
    // 从剧组成员里摘掉引用 (不动内容寻址源文件), 但暂无剧组回收站可从 UI 捞回. 故弱化为"移出剧组"
    // 语义 + 讲清两种来源后果, 既不谎称"可恢复"(会违反状态精确), 也不再用吓人的"不可撤销".
    const ok = await confirm({
      title: "把这张图移出剧组?",
      description:
        "移出后, 所有用这个剧组的剧都不会再看到它. 若这张图是从某部剧导入的, 那部剧仍保留自己的副本; 直接上传到这里的图, 移出后需要重新上传.",
      confirmLabel: "移出剧组",
      cancelLabel: "留着",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await deleteCastElementImage(cast.id, member.id, imageId);
      toast.success("已移出剧组");
      await refresh();
    } catch (e) {
      // 2026-05-28 audit P2: 走 showErrorToast 统一错误翻译
      showErrorToast(e, "移出失败");
    }
  }

  // ── render ─────────────────────────────────────────────────────────

  if (loading) {
    return <div style={{ padding: 40, textAlign: "center", color: "var(--ink-400)" }}>加载中…</div>;
  }
  if (error || !cast) {
    return (
      <div className="mk-card" style={{ margin: "32px auto", maxWidth: 720, padding: 24, color: "var(--err)" }}>
        加载失败：{error || "找不到这个剧组"}
        <Button variant="ghost" size="sm" iconLeft="back" style={{ marginLeft: 10 }} onClick={() => navigate("/studio")}>
          返回列表
        </Button>
      </div>
    );
  }

  return (
    <div className="cast-detail-page" style={{ maxWidth: 1280, margin: "0 auto", padding: "24px 32px" }}>
      {/* 返回链接 */}
      <Button variant="ghost" size="sm" iconLeft="back" onClick={() => navigate("/studio")} style={{ marginBottom: 12 }}>
        返回我的剧组
      </Button>

      {/* 顶部 header */}
      <div className="mk-card cast-detail-header" style={{ padding: 20, marginBottom: 16, display: "flex", gap: 16, alignItems: "flex-start" }}>
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: 14,
            background: "linear-gradient(135deg, var(--brand-400), var(--brand-700))",
            color: "#fff",
            display: "grid",
            placeItems: "center",
            flexShrink: 0,
          }}
        >
          <Icon name="users" size={26} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: "var(--ink-500)", textTransform: "uppercase", marginBottom: 4 }}>
            剧组详情
          </div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "var(--ink-900)", marginBottom: 6 }}>
            <InlineLabel value={cast.name} fallback="未命名剧组" onSave={handleRenameCast} />
          </div>
          <div
            style={{ fontSize: 13, color: "var(--ink-600)", lineHeight: 1.55, cursor: "pointer" }}
            onClick={handleEditDesc}
            title="点击编辑描述"
          >
            {cast.description?.trim() || <span style={{ color: "var(--ink-400)", fontStyle: "italic" }}>(点击添加描述)</span>}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
            <span className="mk-chip mk-chip--ghost" style={{ fontSize: 11 }}>
              <Icon name="grid" size={11} style={{ marginRight: 4 }} />
              {members.length} 个成员
            </span>
            <span
              className="mk-chip"
              style={{
                fontSize: 11,
                background: cast.referencing_series_count > 0 ? "var(--brand-50, #fef3ec)" : "var(--ink-50)",
                color: cast.referencing_series_count > 0 ? "var(--brand-700, #c2410c)" : "var(--ink-500)",
                border: `1px solid ${cast.referencing_series_count > 0 ? "var(--brand-200, rgba(217,119,87,0.3))" : "var(--ink-200)"}`,
              }}
            >
              <Icon name="film" size={11} style={{ marginRight: 4 }} />
              {cast.referencing_series_count} 部剧用着
            </span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {/* 2026-05-26 audit #6: CastDashboardPage 已删 — 单用户本机不做"独立 IP 容器跨剧台账", 用素材组顶替. */}
          <Button variant="danger" iconLeft="trash" onClick={handleDeleteCast}>
            送进垃圾桶
          </Button>
        </div>
      </div>

      {/* 主体: 中段 + 右侧栏 */}
      <div className="cast-detail-columns" style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 16 }}>
        {/* 中段: 成员管理 */}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12, alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            {/* kind tab */}
            <div className="mk-tab-group">
              {TAB_KINDS.map((k) => {
                const count = members.filter((m) => m.kind === k).length;
                return (
                  <button
                    key={k}
                    className={`mk-tab ${k === activeKind ? "mk-tab--active" : ""}`}
                    onClick={() => setActiveKind(k)}
                  >
                    {ELEMENT_KIND_LABEL[k]} {count > 0 ? `(${count})` : ""}
                  </button>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Button variant="secondary" iconLeft="image" onClick={() => setPromoteOpen(true)}>
                从一部剧导入成员
              </Button>
              <Button variant="primary" iconLeft="plus" onClick={() => { setNewKind(activeKind); setCreating(true); }}>
                {activeKind === "character" ? "新建演员" : "新建剧组成员"}
              </Button>
            </div>
          </div>

          {/* 新建成员表单 */}
          {creating ? (
            <div className="mk-card" style={{ padding: 14, marginBottom: 14, display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <Select
                  value={newKind}
                  onChange={(v) => setNewKind(v as ElementKind)}
                  options={CREATABLE_KINDS.map((k) => ({ value: k, label: ELEMENT_KIND_LABEL[k] }))}
                  ariaLabel="新建成员类型"
                  maxWidth={130}
                />
                <Input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="名字, 例「老张 (核心角色)」"
                  onKeyDown={(e) => e.key === "Enter" && handleCreateMember()}
                  className="flex-1"
                />
              </div>
              <Textarea
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                placeholder="一两句描述 (可选), 例「头发花白, 戴金丝眼镜, 沉默寡言」"
                className="min-h-[60px] text-[13px]"
              />
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <Button variant="ghost" onClick={() => setCreating(false)} disabled={submitting}>取消</Button>
                <Button variant="primary" iconLeft="plus" onClick={handleCreateMember} loading={submitting} disabled={!newName.trim() || submitting}>
                  创建
                </Button>
              </div>
            </div>
          ) : null}

          {/* 成员卡片网格 */}
          {filtered.length === 0 ? (
            <div className="mk-card" style={{ padding: 40, textAlign: "center" }}>
              <div style={{ fontSize: 14, color: "var(--ink-600)", marginBottom: 6 }}>
                {ELEMENT_KIND_LABEL[activeKind]}下还没有成员
              </div>
              <div style={{ fontSize: 12.5, color: "var(--ink-400)" }}>
                点上面「{activeKind === "character" ? "新建演员" : "新建剧组成员"}」或「从一部剧导入成员」开始, 多部剧可共用这一组成员.
              </div>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12 }}>
              {filtered.map((m) => {
                const primary = m.images.find((im) => im.image_id === m.primary_image_id) ?? m.images[0];
                const isSelected = selectedId === m.id;
                return (
                  <div
                    key={m.id}
                    className="mk-card mk-card-hov"
                    onClick={() => setSelectedId(isSelected ? null : m.id)}
                    style={{
                      padding: 0,
                      overflow: "hidden",
                      cursor: "pointer",
                      display: "flex",
                      flexDirection: "column",
                      border: isSelected ? "2px solid var(--brand-500)" : undefined,
                    }}
                  >
                    <div
                      className={cardAspectByKind(m.kind)}
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
                          alt={primary.display_name || m.name}
                          style={{ width: "100%", height: "100%", objectFit: "cover" }}
                        />
                      ) : (
                        <Icon name="image" size={28} style={{ color: "var(--ink-300)" }} />
                      )}
                    </div>
                    <div style={{ padding: "8px 10px" }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-900)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {m.name}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--ink-400)", marginTop: 2 }}>
                        {m.images.length} 张图
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* 选中成员: inline 编辑面板 */}
          {selectedMember ? (
            <CastMemberEditPanel
              key={selectedMember.id}
              castId={cast.id}
              member={selectedMember}
              voiceAsset={cast.voice_assets?.find((v) => v.member_element_id === selectedMember.id)}
              onRename={(n) => handleRenameMember(selectedMember, n)}
              onUploadImage={(f) => handleUploadMemberImage(selectedMember, f)}
              onDeleteImage={(imgId) => handleDeleteMemberImage(selectedMember, imgId)}
              onClose={() => setSelectedId(null)}
              onVoiceChanged={refresh}
            />
          ) : null}
        </div>

        {/* 右侧栏: 引用系列列表 */}
        <div className="mk-card" style={{ padding: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: "var(--ink-500)", textTransform: "uppercase", marginBottom: 10 }}>
            用这个剧组的剧
          </div>
          {referencingSeries.length === 0 ? (
            <div style={{ fontSize: 12.5, color: "var(--ink-400)", lineHeight: 1.55 }}>
              暂无剧加入这个剧组. 去任一剧的总览页, 顶部「加入剧组」下拉选择即可共用素材.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {referencingSeries.map((s) => (
                <a
                  key={s.slug}
                  onClick={() => navigate(ROUTES.seriesDetail(s.slug))}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 10px",
                    borderRadius: 8,
                    cursor: "pointer",
                    fontSize: 13,
                    color: "var(--ink-700)",
                    background: "var(--ink-50)",
                  }}
                >
                  <Icon name="film" size={13} />
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</span>
                  <Icon name="chevRight" size={11} style={{ color: "var(--ink-400)" }} />
                </a>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* promote 弹窗 */}
      {promoteOpen ? (
        <PromoteFromSeriesDialog
          castId={cast.id}
          castName={cast.name}
          onClose={() => setPromoteOpen(false)}
          onPromoted={() => {
            setPromoteOpen(false);
            void refresh();
          }}
        />
      ) : null}

      {/* 2026-07-09 audit: 编辑剧组描述 — 页面级 BaseDialog (替换原生 window.prompt) */}
      <BaseDialog
        open={editingDesc}
        onClose={() => setEditingDesc(false)}
        busy={savingDesc}
        iconName="edit"
        title="编辑剧组描述"
        subtitle="一句话讲讲这个剧组装了什么, 方便日后一眼认出."
        ariaLabel="编辑剧组描述"
        maxWidth={520}
        footer={
          <>
            <Button variant="ghost" iconLeft="close" onClick={() => setEditingDesc(false)} disabled={savingDesc}>
              取消
            </Button>
            <Button variant="primary" iconLeft="check" onClick={handleSaveDesc} loading={savingDesc} disabled={savingDesc}>
              保存描述
            </Button>
          </>
        }
      >
        <Textarea
          autoFocus
          value={descDraft}
          onChange={(e) => setDescDraft(e.target.value)}
          placeholder="例「都市悬疑剧的固定班底: 老张、小李和那间旧咖啡馆」(留空则不显示描述)"
          className="min-h-[120px] text-[13px]"
        />
      </BaseDialog>
    </div>
  );
}

// ─── 子组件: 成员编辑面板 (inline) ─────────────────────────────────

interface CastMemberEditPanelProps {
  castId: string;
  member: ElementData;
  voiceAsset?: CastVoiceAsset;
  onRename: (newName: string) => Promise<void>;
  onUploadImage: (file: File) => Promise<void>;
  onDeleteImage: (imageId: string) => Promise<void>;
  onClose: () => void;
  onVoiceChanged: () => Promise<void>;
}

function CastMemberEditPanel({
  castId, member, voiceAsset, onRename, onUploadImage, onDeleteImage, onClose, onVoiceChanged,
}: CastMemberEditPanelProps) {
  const fileRef = useRef<HTMLInputElement | null>(null);

  const memberLabel = member.kind === "character" ? "演员" : "剧组成员";
  return (
    <div className="mk-card" style={{ marginTop: 14, padding: 16, borderColor: "var(--brand-300)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: "var(--ink-900)" }}>
          <InlineLabel value={member.name} fallback={`未命名${memberLabel}`} onSave={onRename} />
        </div>
        <Button variant="ghost" size="sm" iconLeft="close" onClick={onClose}>关闭</Button>
      </div>
      <div style={{ fontSize: 12, color: "var(--ink-500)", marginBottom: 12, lineHeight: 1.55 }}>
        {member.description || <span style={{ fontStyle: "italic", color: "var(--ink-400)" }}>(暂无描述)</span>}
      </div>

      {/* 图片网格 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-700)" }}>图片 ({member.images.length})</span>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onUploadImage(f);
            if (fileRef.current) fileRef.current.value = "";
          }}
        />
        <Button variant="secondary" size="sm" iconLeft="upload" onClick={() => fileRef.current?.click()}>
          上传图片
        </Button>
      </div>
      {member.images.length === 0 ? (
        <div style={{ padding: 24, textAlign: "center", color: "var(--ink-400)", fontSize: 12, background: "var(--ink-50)", borderRadius: 8 }}>
          还没有图片, 点上面「上传图片」加一张作为代表
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 8 }}>
          {member.images.map((im) => (
            <div key={im.image_id} style={{ position: "relative", borderRadius: 8, overflow: "hidden", aspectRatio: "1 / 1", background: "var(--surface-canvas)" }}>
              {im.url ? (
                <img src={im.url} alt={im.display_name || "图片"} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              ) : (
                <div style={{ width: "100%", height: "100%", display: "grid", placeItems: "center" }}>
                  <Icon name="image" size={24} style={{ color: "var(--ink-300)" }} />
                </div>
              )}
              <Button
                variant="danger"
                size="xs"
                iconLeft="trash"
                aria-label="把这张图移出剧组"
                title="把这张图移出剧组"
                onClick={() => void onDeleteImage(im.image_id)}
                style={{ position: "absolute", top: 4, right: 4 }}
              >
                移出
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* W6 (2026-05-26): 配音区 — 仅 character kind 显示 */}
      {member.kind === "character" ? (
        <CastVoiceSection
          castId={castId}
          memberElementId={member.id}
          voiceAsset={voiceAsset}
          onChanged={onVoiceChanged}
        />
      ) : null}
    </div>
  );
}

// ─── 子组件: cast 层 character 配音区 (W6 2026-05-26) ─────────────

interface CastVoiceSectionProps {
  castId: string;
  memberElementId: string;
  voiceAsset?: CastVoiceAsset;
  onChanged: () => Promise<void>;
}

function CastVoiceSection({ castId, memberElementId, voiceAsset, onChanged }: CastVoiceSectionProps) {
  const confirm = useConfirm();
  const fileRef = useRef<HTMLInputElement | null>(null);

  // 本地编辑态 (用户改完点 "保存配音字段" 才落盘, 避免每输一个字符 PATCH)
  const [providerKv, setProviderKv] = useState<Array<{ k: string; v: string }>>([]);
  const [styleKv, setStyleKv] = useState<Array<{ k: string; v: string }>>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // 同步 voiceAsset → 本地编辑态 (切换 member 时 reset)
  useEffect(() => {
    setProviderKv(Object.entries(voiceAsset?.provider_voice_ids ?? {}).map(([k, v]) => ({ k, v })));
    setStyleKv(Object.entries(voiceAsset?.voice_style_map ?? {}).map(([k, v]) => ({ k, v })));
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberElementId, voiceAsset?.updated_at]);

  // 样本 URL: 从 "cast:<castId>:assets/voices/<filename>" 拆出 filename, 走静态 audio src
  const sampleAudioSrc = useMemo(() => {
    const id = voiceAsset?.voice_sample_vault_id;
    if (!id?.startsWith(`cast:${castId}:`)) return null;
    const rel = id.slice(`cast:${castId}:`.length); // "assets/voices/xxx.mp3"
    // 后端目前未提供 cast assets 静态服务路由, 先用 placeholder. (静态文件路径需要 server 配 express.static)
    // TODO: 加 GET /api/v2/casts/:castId/assets/voices/:filename 静态端点后启用
    return `/api/v2/casts/${encodeURIComponent(castId)}/${rel}`;
  }, [voiceAsset?.voice_sample_vault_id, castId]);

  async function handleUploadSample(file: File) {
    try {
      await uploadCastVoiceSample(castId, memberElementId, file);
      toast.success("已上传配音样本");
      await onChanged();
    } catch (e) {
      // 2026-05-28 audit P2: 走 showErrorToast 统一错误翻译
      showErrorToast(e, "上传失败");
    }
  }

  async function handleDeleteVoice() {
    const ok = await confirm({
      // 2026-07-09 audit(铁律9 toC 兜底): 去掉裸 voice_id, 讲人话.
      title: "删除这位演员的全部配音?",
      description: "语音样本、各 TTS 服务的声音设置和情绪→音色映射会一起清空. 之后可以重新配.",
      confirmLabel: "删除",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await removeCastVoice(castId, memberElementId);
      toast.success("已删除");
      await onChanged();
    } catch (e) {
      // 2026-05-28 audit P2: 走 showErrorToast 统一错误翻译
      showErrorToast(e, "删除失败");
    }
  }

  async function handleSaveFields() {
    setSaving(true);
    try {
      const provider_voice_ids: Record<string, string> = {};
      for (const { k, v } of providerKv) if (k.trim() && v.trim()) provider_voice_ids[k.trim()] = v.trim();
      const voice_style_map: Record<string, string> = {};
      for (const { k, v } of styleKv) if (k.trim() && v.trim()) voice_style_map[k.trim()] = v.trim();
      await patchCastVoice(castId, memberElementId, { provider_voice_ids, voice_style_map });
      toast.success("配音字段已保存");
      setDirty(false);
      await onChanged();
    } catch (e) {
      // 2026-05-28 audit P2: 走 showErrorToast 统一错误翻译
      showErrorToast(e, "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ marginTop: 16, padding: 14, background: "var(--ink-50)", borderRadius: 10, borderLeft: "3px solid var(--brand-400)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink-900)", display: "flex", alignItems: "center", gap: 6 }}>
          {/* 2026-07-09 audit(铁律8 视觉一致): emoji 🎙️ → 统一 Icon(mic) */}
          <Icon name="mic" size={14} />
          配音 (跨剧共享)
        </div>
        {voiceAsset ? (
          <Button variant="ghost" size="xs" iconLeft="trash" onClick={handleDeleteVoice}>
            删除全部
          </Button>
        ) : null}
      </div>
      <div style={{ fontSize: 11, color: "var(--ink-500)", lineHeight: 1.55, marginBottom: 10 }}>
        在这里给这位演员定的声音, 所有用这个剧组的剧都自动共用 — 同一个人在不同剧里也是同一把嗓子.
      </div>

      {/* 样本 */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-700)", marginBottom: 6 }}>语音克隆样本</div>
        {sampleAudioSrc ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <audio controls src={sampleAudioSrc} style={{ flex: 1, height: 32 }} />
            <Button variant="secondary" size="sm" iconLeft="upload" onClick={() => fileRef.current?.click()}>
              替换
            </Button>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ flex: 1, padding: "8px 10px", background: "#fff", borderRadius: 6, fontSize: 12, color: "var(--ink-400)" }}>
              暂无样本 (.wav / .mp3, 最大 10MB)
            </div>
            <Button variant="primary" size="sm" iconLeft="upload" onClick={() => fileRef.current?.click()}>
              上传
            </Button>
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="audio/*,.wav,.mp3,.m4a,.aac,.webm,.ogg"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleUploadSample(f);
            if (fileRef.current) fileRef.current.value = "";
          }}
        />
      </div>

      {/* 2026-07-09 audit(铁律9 toC 兜底 + 铁律8 一致): 情绪→音色 可视化编辑, 取代裸 voice_id KV.
          情绪走中文下拉, 音色走 VoiceSelector(下拉 + 试听), 数据仍是 { 情绪key: voice_id } 与后端
          voice_style_map 完全一致, 只是换了人话皮. */}
      <EmotionVoiceEditor
        kv={styleKv}
        setKv={(next) => { setStyleKv(next); setDirty(true); }}
      />

      {/* 高级(默认折叠): 只有同时接多家 TTS 服务的用户才需要按服务单独指定声音 ID.
          与 ShotPromptColumn "高级:直接编辑提示词" 同款 details 折叠模式. */}
      <details style={{ marginTop: 2, marginBottom: 2 }}>
        <summary style={{ fontSize: 11, color: "var(--ink-500)", cursor: "pointer", fontWeight: 600 }}>
          高级: 按 TTS 服务单独指定声音 ID
        </summary>
        <div style={{ marginTop: 8 }}>
          <KvEditor
            title="不同 TTS 服务各自的声音 ID"
            hint="仅当你同时接了多家 TTS 服务、想为每家单独指定声音时才需要填. 左边填服务代号 (例 minimax_t2a / elevenlabs), 右边填该服务里的声音 ID."
            kv={providerKv}
            setKv={(next) => { setProviderKv(next); setDirty(true); }}
            keyPlaceholder="服务代号"
            valuePlaceholder="声音 ID"
          />
        </div>
      </details>

      {dirty ? (
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
          <Button variant="primary" size="sm" iconLeft="check" onClick={handleSaveFields} loading={saving} disabled={saving}>
            保存配音字段
          </Button>
        </div>
      ) : null}
    </div>
  );
}

interface KvEditorProps {
  title: string;
  hint?: string;
  kv: Array<{ k: string; v: string }>;
  setKv: (next: Array<{ k: string; v: string }>) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}

function KvEditor({ title, hint, kv, setKv, keyPlaceholder, valuePlaceholder }: KvEditorProps) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-700)", marginBottom: 4 }}>{title}</div>
      {hint ? <div style={{ fontSize: 10.5, color: "var(--ink-400)", marginBottom: 6 }}>{hint}</div> : null}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {kv.map((row, i) => (
          <div key={i} style={{ display: "flex", gap: 6 }}>
            <Input
              value={row.k}
              onChange={(e) => {
                const next = [...kv];
                next[i] = { ...next[i], k: e.target.value };
                setKv(next);
              }}
              placeholder={keyPlaceholder}
              className="flex-1"
            />
            <Input
              value={row.v}
              onChange={(e) => {
                const next = [...kv];
                next[i] = { ...next[i], v: e.target.value };
                setKv(next);
              }}
              placeholder={valuePlaceholder}
              className="flex-1"
            />
            <Button
              variant="ghost"
              size="sm"
              iconLeft="trash"
              aria-label="删除该项"
              onClick={() => setKv(kv.filter((_, j) => j !== i))}
            >
              删除
            </Button>
          </div>
        ))}
        <Button
          variant="ghost"
          size="sm"
          iconLeft="plus"
          onClick={() => setKv([...kv, { k: "", v: "" }])}
        >
          加一项
        </Button>
      </div>
    </div>
  );
}

// ─── 子组件: 情绪 → 音色 可视化编辑器 (2026-07-09 audit) ─────────────
// 替换原来把 voice_id 裸字段甩给创作者的 KvEditor: 情绪走中文下拉, 音色走 VoiceSelector(下拉 + 试听).
// 内部数据仍是 { emotionKey: voice_id } (与后端 voice_style_map 一致), 只换人话皮.

interface EmotionVoiceEditorProps {
  kv: Array<{ k: string; v: string }>;
  setKv: (next: Array<{ k: string; v: string }>) => void;
}

function EmotionVoiceEditor({ kv, setKv }: EmotionVoiceEditorProps) {
  const usedKeys = new Set(kv.map((r) => r.k));
  // "加一条"默认选下一个还没用过的情绪, 避免一上来就撞车
  const nextUnused = EMOTION_OPTIONS.find((o) => !usedKeys.has(o.value))?.value ?? "default";

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-700)", marginBottom: 4 }}>
        不同情绪用不同声音 (可选)
      </div>
      <div style={{ fontSize: 10.5, color: "var(--ink-400)", marginBottom: 6, lineHeight: 1.5 }}>
        平时用一个声音, 哭戏 / 怒吼想换个更有戏的时在这里加. 先给「默认」兜底, 再按需为某些情绪单独指定.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {kv.map((row, i) => {
          // 当前行可选情绪 = 未被其它行占用的 + 自己当前值; 兼容历史自定义 key
          const options: Array<{ value: string; label: string }> = [
            ...EMOTION_OPTIONS.filter((o) => o.value === row.k || !usedKeys.has(o.value)),
            ...(row.k && !KNOWN_EMOTION_VALUES.has(row.k)
              ? [{ value: row.k, label: `${row.k} (自定义)` }]
              : []),
          ];
          return (
            <div key={i} style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
              <Select
                value={row.k || "default"}
                onChange={(val) => {
                  const next = [...kv];
                  next[i] = { ...next[i], k: val };
                  setKv(next);
                }}
                options={options}
                ariaLabel="情绪"
                maxWidth={150}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <VoiceSelector
                  compact
                  value={row.v || undefined}
                  onChange={(voiceId) => {
                    const next = [...kv];
                    next[i] = { ...next[i], v: voiceId };
                    setKv(next);
                  }}
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                iconLeft="trash"
                aria-label="删掉这条情绪声音"
                title="删掉这条情绪声音"
                onClick={() => setKv(kv.filter((_, j) => j !== i))}
              >
                删除
              </Button>
            </div>
          );
        })}
        <Button
          variant="ghost"
          size="sm"
          iconLeft="plus"
          disabled={kv.length >= EMOTION_OPTIONS.length}
          onClick={() => setKv([...kv, { k: nextUnused, v: "" }])}
        >
          加一条情绪声音
        </Button>
      </div>
    </div>
  );
}

// ─── 子组件: 从系列导入成员 (promote) 弹窗 ──────────────────────────

interface PromoteDialogProps {
  castId: string;
  castName: string;
  onClose: () => void;
  onPromoted: () => void;
}

function PromoteFromSeriesDialog({ castId, castName, onClose, onPromoted }: PromoteDialogProps) {
  const [seriesList, setSeriesList] = useState<Array<{ slug: string; title: string }>>([]);
  const [pickedSlug, setPickedSlug] = useState<string>("");
  const [elements, setElements] = useState<ElementData[]>([]);
  const [pickedElementId, setPickedElementId] = useState<string>("");
  const [nameOverride, setNameOverride] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [loadingElements, setLoadingElements] = useState(false);

  // 加载系列列表
  useEffect(() => {
    void (async () => {
      try {
        const r = await listAllSeries();
        setSeriesList(r.series.map((s) => ({ slug: s.slug, title: s.title })));
      } catch (e) {
        // 2026-05-28 audit P2: 走 showErrorToast 统一错误翻译
        showErrorToast(e, "加载系列列表失败");
      }
    })();
  }, []);

  // 切系列时拉 element 列表
  useEffect(() => {
    if (!pickedSlug) {
      setElements([]);
      return;
    }
    setLoadingElements(true);
    void (async () => {
      try {
        const r = await listElements(pickedSlug);
        // 仅展示后端支持 promote 的 kind
        setElements(r.elements.filter((el) => PROMOTE_SUPPORTED_KINDS.includes(el.kind)));
        setPickedElementId("");
      } catch (e) {
        // 2026-05-28 audit P2: 走 showErrorToast 统一错误翻译
        showErrorToast(e, "加载系列素材失败");
      } finally {
        setLoadingElements(false);
      }
    })();
  }, [pickedSlug]);

  async function handlePromote() {
    if (!pickedSlug || !pickedElementId || submitting) return;
    setSubmitting(true);
    try {
      const r = await promoteSeriesElementToCast(
        castId,
        pickedSlug,
        pickedElementId,
        nameOverride.trim() || undefined,
      );
      toast.success(`已送进剧组「${castName}」: ${r.element.name} (复制 ${r.copied_images}/${r.total_images} 张图)`);
      if (r.hint) toast.info(r.hint, { duration: 7000 });
      if (r.errors?.length) {
        toast.warning(`部分图片复制失败: ${r.errors.length} 张, 详见控制台`, { duration: 6000 });
        // eslint-disable-next-line no-console
        console.warn("[CastPromote] errors:", r.errors);
      }
      onPromoted();
    } catch (e) {
      // 2026-05-28 audit P2: 走 showErrorToast 统一错误翻译
      showErrorToast(e, "送进剧组失败");
    } finally {
      setSubmitting(false);
    }
  }

  // 2026-07-09 audit(铁律8 一致 + dialog-interaction): 手写 fixed 卡片迁到 BaseDialog,
  // 自动获得 ESC 关闭 / 焦点 / 统一外壳, 与其余弹窗行为一致 (原来缺 ESC).
  return (
    <BaseDialog
      open
      onClose={onClose}
      busy={submitting}
      iconName="image"
      title={`从一部剧把素材送进剧组「${castName}」`}
      subtitle="目前仅支持物品 / 服装 / 参考照片 / 杂物 4 类共享. 角色 / 场景的跨剧共用走另一条路径 (后续支持)."
      ariaLabel="从一部剧导入成员"
      maxWidth={560}
      footer={
        <>
          <Button variant="ghost" iconLeft="close" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button
            variant="primary"
            iconLeft="check"
            onClick={handlePromote}
            loading={submitting}
            disabled={!pickedSlug || !pickedElementId || submitting}
          >
            共享给整个剧组
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: "var(--ink-500)", textTransform: "uppercase", display: "block", marginBottom: 6 }}>
            从哪部剧?
          </label>
          <Select
            value={pickedSlug}
            onChange={setPickedSlug}
            options={seriesList.map((s) => ({ value: s.slug, label: s.title }))}
            placeholder="选剧…"
            ariaLabel="选剧"
          />
        </div>
        {pickedSlug ? (
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: "var(--ink-500)", textTransform: "uppercase", display: "block", marginBottom: 6 }}>
              选哪个素材送进剧组共享?
            </label>
            {loadingElements ? (
              <div style={{ fontSize: 12, color: "var(--ink-400)" }}>加载中…</div>
            ) : elements.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--ink-400)" }}>
                这部剧下没有可共享的素材 (仅物品 / 服装 / 参考照片 / 杂物 可共享).
              </div>
            ) : (
              <Select
                value={pickedElementId}
                onChange={setPickedElementId}
                options={elements.map((el) => ({
                  value: el.id,
                  label: `${el.name} (${ELEMENT_KIND_LABEL[el.kind]})`,
                  description: `${el.images.length} 张图`,
                }))}
                placeholder="选素材…"
                ariaLabel="选素材"
              />
            )}
          </div>
        ) : null}
        {pickedElementId ? (
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: "var(--ink-500)", textTransform: "uppercase", display: "block", marginBottom: 6 }}>
              改名 (可选)
            </label>
            <Input
              value={nameOverride}
              onChange={(e) => setNameOverride(e.target.value)}
              placeholder="留空 = 沿用源名字"
            />
          </div>
        ) : null}
      </div>
    </BaseDialog>
  );
}
