/**
 * ManageGroupsDialog — 素材组管理弹窗 (W7 2026-05-26).
 *
 * 整合自老"我的剧组"列表页核心功能 (新建 / 改名 / 删除). 让创作者不离开素材库就能管组.
 *
 * UX 铁律:
 *   - #3 信息直接可见: 列表直接展示 name / 成员数 / 引用剧数 (不点开二级)
 *   - #6 数据保留: 删除走二次确认 + 显示"N 部剧会失去对组里素材的访问" warning
 *   - #11 按钮带文字: 全部按钮含图标 + 文字
 *   - #9 toC 兜底: 不暴露 cast_id; 一律用 "素材组" 措辞
 */

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { showErrorToast } from "../../lib/errorTranslate";
import { BaseDialog } from "../ui/BaseDialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Icon } from "../shared/Icon";
import { useConfirm } from "../ui/ConfirmModal";
import { InlineLabel } from "../shot-stage/InlineLabel";
import type { CastWithUsage } from "../../lib/castApi";

export interface ManageGroupsDialogProps {
  open: boolean;
  groups: CastWithUsage[];
  onClose: () => void;
  /** 新建素材组. caller 走 createCast + refresh. */
  onCreateGroup: (name: string, description: string) => Promise<void>;
  /** 改名/改描述. caller 走 patchCast + refresh. */
  onRenameGroup: (id: string, name: string, description: string) => Promise<void>;
  /** 删除素材组. caller 走 deleteCast + refresh. 返 warnings (可选, 后端给) 让 UI 弹通知. */
  onDeleteGroup: (id: string) => Promise<string[] | undefined>;
  /**
   * 2026-07-09 audit (asset-dialog lane): 批量"加入素材组"模式.
   * 传了非空数组时, 弹窗切到"把这些素材加入某个组"模式: 顶部提示 + 每个组行多一个「加入此组」按钮.
   * 空 / 未传 = 纯组管理模式 (新建 / 改名 / 删除). 让批量条的"加入素材组"按钮不再是死路.
   */
  memberElementIds?: string[];
  /** 把 memberElementIds 加入指定组. caller 真写后端 (shareElementToGroups) + toast + 刷新. */
  onAddMembersToGroup?: (groupId: string, elementIds: string[]) => Promise<void>;
}

export function ManageGroupsDialog({
  open,
  groups,
  onClose,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  memberElementIds,
  onAddMembersToGroup,
}: ManageGroupsDialogProps) {
  const confirm = useConfirm();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [editingDescId, setEditingDescId] = useState<string | null>(null);
  const [descDraft, setDescDraft] = useState("");
  // 2026-07-09 audit: 批量加入进行中的组 id (per-row loading 态)
  const [addingGroupId, setAddingGroupId] = useState<string | null>(null);

  // 2026-07-09 audit (asset-dialog lane): 是否处于"把选中素材加入组"模式.
  const addMode = !!(memberElementIds && memberElementIds.length > 0 && onAddMembersToGroup);
  const memberCount = memberElementIds?.length ?? 0;

  // 2026-07-09 audit (asset-dialog lane): 关闭时复位本地表单态 —— 下次打开回到干净初始态.
  // 对齐 ExtractFromScriptDialog 的 !open 复位; 否则用户输一半组名直接关掉, 再开还残留半截.
  useEffect(() => {
    if (!open) {
      setCreating(false);
      setNewName("");
      setNewDesc("");
      setSubmitting(false);
      setEditingDescId(null);
      setDescDraft("");
      setAddingGroupId(null);
    }
  }, [open]);

  async function handleAddToGroup(g: CastWithUsage) {
    if (!onAddMembersToGroup || !memberElementIds || memberElementIds.length === 0) return;
    setAddingGroupId(g.id);
    try {
      await onAddMembersToGroup(g.id, memberElementIds);
    } finally {
      setAddingGroupId(null);
    }
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name || submitting) return;
    setSubmitting(true);
    try {
      await onCreateGroup(name, newDesc.trim());
      toast.success(`已新建素材组「${name}」`);
      setNewName("");
      setNewDesc("");
      setCreating(false);
    } catch (e) {
      // 2026-05-28 audit P2: 走 showErrorToast 统一错误翻译
      showErrorToast(e, "新建失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(g: CastWithUsage) {
    const refMsg = g.referencing_series_count > 0
      ? `已经引用这个组的 ${g.referencing_series_count} 部剧会失去对组里素材的共享访问。本剧专属素材不受影响.`
      : `当前没有剧用着这个组, 可以安全删除.`;
    const ok = await confirm({
      title: `删了素材组「${g.name}」?`,
      description: refMsg,
      confirmLabel: "确认删除",
      cancelLabel: "取消",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      const warnings = await onDeleteGroup(g.id);
      if (warnings && warnings.length > 0) {
        toast.warning(warnings.join("\n"));
      } else {
        toast.success(`已删除素材组「${g.name}」`);
      }
    } catch (e) {
      // 2026-05-28 audit P2: 走 showErrorToast 统一错误翻译
      showErrorToast(e, "删除失败");
    }
  }

  async function handleSaveDesc(g: CastWithUsage) {
    const next = descDraft.trim();
    if (next === (g.description ?? "")) {
      setEditingDescId(null);
      return;
    }
    try {
      await onRenameGroup(g.id, g.name, next);
      toast.success("已更新描述");
      setEditingDescId(null);
    } catch (e) {
      // 2026-05-28 audit P2: 走 showErrorToast 统一错误翻译
      showErrorToast(e, "保存失败");
    }
  }

  return (
    <BaseDialog
      open={open}
      onClose={onClose}
      title={addMode ? "把素材加入素材组" : "管理素材组"}
      subtitle={
        addMode
          ? `已选 ${memberCount} 个素材 —— 点某个组的「加入此组」即可归入; 也可以先在下面新建一个组再加入.`
          : "多部剧共用同一组素材, 改一处, 所有引用这个组的剧都同步生效."
      }
      iconName="grid"
      maxWidth={680}
      footer={
        <Button variant="ghost" onClick={onClose}>
          完成
        </Button>
      }
    >
      {/* 2026-07-09 audit (asset-dialog lane): 加入模式顶部提示条 —— 让"加入素材组"批量按钮真正落地. */}
      {addMode ? (
        <div
          style={{
            marginBottom: 14,
            padding: "10px 12px",
            borderRadius: 10,
            background: "var(--brand-50, #fff7ed)",
            border: "1px solid var(--brand-200, #fed7aa)",
            fontSize: 12.5,
            color: "var(--brand-700, #c2410c)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <Icon name="users" size={14} />
          <span>
            将选中的 <b>{memberCount}</b> 个素材加入某个素材组。加入后, 用到该组的每部剧都能共用这些素材。
          </span>
        </div>
      ) : null}

      {/* 新建素材组 */}
      {creating ? (
        <div
          className="mk-card"
          style={{
            padding: 14,
            marginBottom: 14,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            background: "var(--surface-canvas)",
          }}
        >
          <div>
            <label
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.05em",
                color: "var(--ink-500)",
                display: "block",
                marginBottom: 4,
              }}
            >
              组名称
            </label>
            <Input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="例如：老头们 / 民国班底 / 都市职场"
              onKeyDown={(e) => {
                if (e.key === "Enter" && newName.trim()) void handleCreate();
              }}
            />
          </div>
          <div>
            <label
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.05em",
                color: "var(--ink-500)",
                display: "block",
                marginBottom: 4,
              }}
            >
              描述 (可选)
            </label>
            <Textarea
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              placeholder="一句话讲讲这个组装什么"
              className="min-h-[50px] text-[13px]"
            />
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button variant="ghost" onClick={() => setCreating(false)} disabled={submitting}>
              取消
            </Button>
            <Button
              variant="primary"
              iconLeft="plus"
              onClick={handleCreate}
              loading={submitting}
              disabled={!newName.trim() || submitting}
            >
              建组
            </Button>
          </div>
        </div>
      ) : (
        <div style={{ marginBottom: 12 }}>
          <Button variant="primary" iconLeft="plus" onClick={() => setCreating(true)}>
            新建素材组
          </Button>
        </div>
      )}

      {/* 现有组列表 */}
      {groups.length === 0 ? (
        <div
          style={{
            padding: 30,
            textAlign: "center",
            color: "var(--ink-400)",
            fontSize: 13,
            background: "var(--surface-canvas)",
            borderRadius: 10,
            border: "1px dashed var(--ink-200)",
          }}
        >
          还没有素材组. 点上方「新建素材组」开始.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {groups.map((g) => (
            <div
              key={g.id}
              className="mk-card"
              style={{
                padding: 12,
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
              }}
            >
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  background: "linear-gradient(135deg, var(--brand-400), var(--brand-700))",
                  color: "#fff",
                  display: "grid",
                  placeItems: "center",
                  flexShrink: 0,
                }}
              >
                <Icon name="grid" size={15} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink-900)" }}>
                  <InlineLabel
                    value={g.name}
                    fallback="未命名素材组"
                    onSave={async (next) => {
                      const trimmed = next.trim();
                      if (!trimmed || trimmed === g.name) return;
                      try {
                        await onRenameGroup(g.id, trimmed, g.description ?? "");
                        toast.success(`已改名为「${trimmed}」`);
                      } catch (e) {
                        // 2026-05-28 audit P2: 走 showErrorToast 统一错误翻译
                        showErrorToast(e, "改名失败");
                        throw e;
                      }
                    }}
                  />
                </div>
                {editingDescId === g.id ? (
                  <div style={{ marginTop: 6, display: "flex", gap: 6 }}>
                    <Input
                      value={descDraft}
                      autoFocus
                      onChange={(e) => setDescDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void handleSaveDesc(g);
                        if (e.key === "Escape") setEditingDescId(null);
                      }}
                      placeholder="一句话描述这个组"
                    />
                    <Button size="sm" variant="primary" onClick={() => void handleSaveDesc(g)}>
                      保存
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingDescId(null)}>
                      取消
                    </Button>
                  </div>
                ) : (
                  <div
                    onClick={() => {
                      setEditingDescId(g.id);
                      setDescDraft(g.description ?? "");
                    }}
                    style={{
                      fontSize: 12,
                      color: g.description ? "var(--ink-500)" : "var(--ink-400)",
                      marginTop: 2,
                      cursor: "pointer",
                      fontStyle: g.description ? undefined : "italic",
                    }}
                    title="点击改描述"
                  >
                    {g.description || "(暂无描述, 点击添加)"}
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, marginTop: 6, fontSize: 11, color: "var(--ink-500)" }}>
                  <span>
                    <Icon name="users" size={11} style={{ marginRight: 3, verticalAlign: -1 }} />
                    {g.member_element_ids.length} 个成员
                  </span>
                  <span style={{ color: g.referencing_series_count > 0 ? "var(--brand-700)" : "var(--ink-400)" }}>
                    <Icon name="film" size={11} style={{ marginRight: 3, verticalAlign: -1 }} />
                    {g.referencing_series_count > 0
                      ? `${g.referencing_series_count} 部剧用着`
                      : "暂无剧用到"}
                  </span>
                </div>
              </div>
              {/* 2026-07-09 audit (asset-dialog lane): 加入模式下每行"加入此组"按钮 —— 真写后端. */}
              {addMode ? (
                <Button
                  size="sm"
                  variant="primary"
                  iconLeft="plus"
                  loading={addingGroupId === g.id}
                  disabled={addingGroupId !== null}
                  onClick={() => void handleAddToGroup(g)}
                  title={`把选中的 ${memberCount} 个素材加入「${g.name}」`}
                >
                  加入此组
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  iconLeft="trash"
                  onClick={() => void handleDelete(g)}
                  title="删除这个素材组"
                >
                  删除
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </BaseDialog>
  );
}
