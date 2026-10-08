/**
 * UpstreamDiffModal — 显示"本地 vs 上游"字段级 diff + 让用户勾选要拉哪些 (W3).
 *
 * 触发: UpstreamDownstreamPanel 点"查看变更"按钮.
 * 流程: 拉 GET /upstream-diff → 渲染 diff → 用户勾 checkbox → POST /pull-from-upstream.
 *
 * UX 铁律:
 *   #1 用户控制 — 默认全不勾, 用户主动选
 *   #2 可干预   — diff 完整展示, 用户能看到字面变化
 *   #6 数据保留 — 拉主图是追加, 不删本地图 (文案明示)
 *   #9 toC 兜底 — 不暴露 element_id, 用素材名 + 字段中文标签
 *   #11 按钮带文字 — 主操作按钮"拉取所选"+"取消"
 */

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { BaseDialog } from "../ui/BaseDialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  getUpstreamDiff,
  pullFromUpstream,
  type ElementData,
  type SyncField,
  type UpstreamDiffResponse,
} from "../../lib/elementApi";
import { showErrorToast } from "../../lib/errorTranslate";

export interface UpstreamDiffModalProps {
  open: boolean;
  slug: string;
  element: ElementData;
  onClose: () => void;
  /** 拉取成功后回写父组件的最新 element. */
  onPulled: (next: ElementData) => void;
}

// 中文字段标签 (绝不暴露技术 key)
const FIELD_LABEL: Record<SyncField, string> = {
  description: "描述",
  tags: "标签",
  primary_image: "主图",
  image_briefs: "图规划",
};

export function UpstreamDiffModal({ open, slug, element, onClose, onPulled }: UpstreamDiffModalProps) {
  const [loading, setLoading] = useState(false);
  const [diff, setDiff] = useState<UpstreamDiffResponse | null>(null);
  const [selected, setSelected] = useState<Set<SyncField>>(new Set());
  const [applying, setApplying] = useState(false);

  // 打开时拉 diff
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setDiff(null);
    setSelected(new Set());
    getUpstreamDiff(slug, element.id)
      .then((d) => { if (alive) setDiff(d); })
      .catch((e) => { if (alive) showErrorToast(e, "检查原版更新失败"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, slug, element.id]);

  // 可勾选的字段 (只列 diff 里真有变化的)
  const availableFields = useMemo<SyncField[]>(() => {
    if (!diff?.diff) return [];
    const out: SyncField[] = [];
    if (diff.diff.description) out.push("description");
    if (diff.diff.tags) out.push("tags");
    if (diff.diff.primary_image_snapshot) out.push("primary_image");
    if (diff.diff.image_briefs_count) out.push("image_briefs");
    return out;
  }, [diff]);

  function toggle(field: SyncField) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(field)) next.delete(field); else next.add(field);
      return next;
    });
  }

  async function handlePull() {
    if (selected.size === 0) {
      toast.info("请至少勾选一项要拉取的字段");
      return;
    }
    setApplying(true);
    try {
      const res = await pullFromUpstream(slug, element.id, Array.from(selected));
      const labels = res.updated_fields.map((f) => FIELD_LABEL[f]).join("、");
      toast.success(labels ? `已从原版同步: ${labels}` : "原版已无新变化");
      onPulled(res.element);
      onClose();
    } catch (e) {
      showErrorToast(e, "同步失败");
    } finally {
      setApplying(false);
    }
  }

  // 截短长文本展示 (保留头 200 / 尾 80, 中间省略)
  function truncate(s: string, max = 280): string {
    if (s.length <= max) return s;
    return `${s.slice(0, 200)} ... [省略 ${s.length - 280} 字] ... ${s.slice(-80)}`;
  }

  const hasUpstream = diff?.source !== null && diff?.source !== undefined;
  const hasDiff = !!diff?.diff;

  return (
    <BaseDialog
      open={open}
      onClose={onClose}
      title="检查原版有没有更新"
      subtitle={
        hasUpstream
          ? `来源: ${diff?.source?.name ?? ""} (项目: ${diff?.source?.series_slug ?? ""})`
          : "无原版"
      }
      iconName="link"
      busy={applying}
      maxWidth={820}
      footer={
        <div style={{ display: "flex", gap: 8 }}>
          <Button variant="ghost" onClick={onClose} disabled={applying}>
            取消
          </Button>
          <Button
            variant="primary"
            iconLeft="download"
            onClick={handlePull}
            disabled={!hasDiff || selected.size === 0 || applying}
          >
            {applying ? "同步中..." : `从原版同步所选 (${selected.size})`}
          </Button>
        </div>
      }
    >
      {loading ? (
        <div style={{ padding: 24, textAlign: "center", color: "var(--ink-500)" }}>加载中...</div>
      ) : !diff ? (
        <div style={{ padding: 24, textAlign: "center", color: "var(--ink-500)" }}>没拉到差异数据</div>
      ) : !hasUpstream ? (
        <EmptyHint
          icon="alert-triangle"
          title="原版已不存在"
          text="源项目或源素材已被删除, 当前素材无法再同步."
        />
      ) : !hasDiff ? (
        <EmptyHint
          icon="check-circle"
          title="已是最新"
          text={
            diff.reason === "up_to_date"
              ? "原版最近一次更新时间早于或等于本地, 没有新内容可同步."
              : "原版和本地各字段都一致, 没有差异."
          }
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink-500)" }}>
            勾选要同步的字段. 仅会更新勾选项, 不会动其他字段. 主图是追加新图, 不会删本地图.
          </p>
          {availableFields.map((field) => (
            <FieldDiffCard
              key={field}
              field={field}
              checked={selected.has(field)}
              onToggle={() => toggle(field)}
              localLabel={renderLocalSide(field, element, diff)}
              upstreamLabel={renderUpstreamSide(field, diff)}
              truncate={truncate}
            />
          ))}
        </div>
      )}
    </BaseDialog>
  );
}

// ─── 子组件 ────────────────────────────────────────────────────────

interface FieldDiffCardProps {
  field: SyncField;
  checked: boolean;
  onToggle: () => void;
  localLabel: string;
  upstreamLabel: string;
  truncate: (s: string, max?: number) => string;
}

function FieldDiffCard(props: FieldDiffCardProps) {
  const { field, checked, onToggle, localLabel, upstreamLabel, truncate } = props;
  return (
    <div
      style={{
        border: `1px solid var(--ink-200)`,
        borderRadius: "var(--r-md)",
        padding: 12,
        background: checked ? "var(--brand-50)" : "var(--surface)",
        transition: "background-color 120ms",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <Checkbox checked={checked} onCheckedChange={onToggle} />
        <button
          type="button"
          onClick={onToggle}
          style={{
            fontSize: 13.5,
            fontWeight: 600,
            color: "var(--ink-800)",
            border: "none",
            background: "transparent",
            cursor: "pointer",
            padding: 0,
          }}
        >
          {FIELD_LABEL[field]}
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 12 }}>
        <SideBox title="本地" body={truncate(localLabel)} tone="local" />
        <SideBox title="原版" body={truncate(upstreamLabel)} tone="upstream" />
      </div>
    </div>
  );
}

function SideBox({ title, body, tone }: { title: string; body: string; tone: "local" | "upstream" }) {
  const bg = tone === "local" ? "var(--ink-50)" : "var(--brand-50)";
  const labelColor = tone === "local" ? "var(--ink-500)" : "var(--brand-700)";
  return (
    <div style={{ background: bg, padding: 8, borderRadius: "var(--r-sm)" }}>
      <div style={{ fontSize: 10.5, fontWeight: 600, color: labelColor, marginBottom: 4 }}>{title}</div>
      <div style={{ whiteSpace: "pre-wrap", color: "var(--ink-700)", lineHeight: 1.5 }}>{body || "(空)"}</div>
    </div>
  );
}

function EmptyHint({ icon: _icon, title, text }: { icon: string; title: string; text: string }) {
  return (
    <div style={{ padding: 24, textAlign: "center" }}>
      <div style={{ fontSize: 16, fontWeight: 600, color: "var(--ink-700)", marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 12.5, color: "var(--ink-500)" }}>{text}</div>
    </div>
  );
}

// ─── 渲染左右两侧文本 ──────────────────────────────────────────────

function renderLocalSide(field: SyncField, element: ElementData, diff: UpstreamDiffResponse): string {
  const d = diff.diff;
  if (!d) return "";
  if (field === "description" && d.description) return d.description.from;
  if (field === "tags" && d.tags) {
    const all = element.tags ?? [];
    return all.length > 0 ? all.map((t) => `${t.axis}:${t.value}`).join(" / ") : "(无标签)";
  }
  if (field === "primary_image" && d.primary_image_snapshot) {
    return d.primary_image_snapshot.from ?? "(无主图)";
  }
  if (field === "image_briefs" && d.image_briefs_count) {
    return `${d.image_briefs_count.from} 张图规划`;
  }
  return "";
}

function renderUpstreamSide(field: SyncField, diff: UpstreamDiffResponse): string {
  const d = diff.diff;
  if (!d) return "";
  if (field === "description" && d.description) return d.description.to;
  if (field === "tags" && d.tags) {
    const added = d.tags.added.map((t) => `+${t.axis}:${t.value}`);
    const removed = d.tags.removed.map((t) => `-${t.axis}:${t.value}`);
    const segs = [...added, ...removed];
    return segs.length > 0 ? segs.join(" / ") : "(标签一致)";
  }
  if (field === "primary_image" && d.primary_image_snapshot) {
    return d.primary_image_snapshot.to ?? "(无主图)";
  }
  if (field === "image_briefs" && d.image_briefs_count) {
    return `${d.image_briefs_count.to} 张图规划`;
  }
  return "";
}
