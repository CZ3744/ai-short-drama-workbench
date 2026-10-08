// VideoInstancesSection — 2026-05-18 二级架构 SettingsPage 集成.
//
// 5 个渠道卡片, 每张卡列出该 channel 下用户加的 instances. 卡底"+ 添加新模型"开 Modal.
//
// 设计原则 (CLAUDE.md UX 铁律):
//   - 用户控制权 > 系统智能: 不强制选 3.0, 用户填什么发什么
//   - 真实保存 + 状态精确: instance 增删改实时反映, 不假
//   - 数据保留 > 删除: 二次确认 + toast 通知
//   - 视觉一致: 跟原 ProviderCard 一个风格 (.mk-card / .mk-pill / .mk-btn)
//   - 不允许 icon-only 按钮

import { useEffect, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Icon } from "../shared/Icon";
import {
  listVideoChannels,
  listVideoModelInstances,
  deleteVideoModelInstance,
  migrateLegacyVideoInstances,
  type VideoChannelDef,
  type VideoChannelId,
  type VideoModelInstance,
} from "../../lib/videoModelInstancesApi";
import { showErrorToast } from "../../lib/errorTranslate";
import { SWR_KEYS } from "../../lib/swrInvalidate";
import { AddVideoModelModal } from "./AddVideoModelModal";
import { useConfirm } from "../ui/ConfirmModal";
import { Button } from "../ui/button";

interface Props {
  onChanged?: () => void;
}

export function VideoInstancesSection({ onChanged }: Props) {
  const confirm = useConfirm();
  const { data: channelsData, error: chErr } = useSWR(
    SWR_KEYS.videoChannels,
    () => listVideoChannels(),
    { revalidateOnFocus: false },
  );
  const { data: instancesData, mutate: refreshInstances, isLoading: instancesLoading } = useSWR(
    "video-model-instances",
    () => listVideoModelInstances(),
    { revalidateOnFocus: false, onError: (e) => showErrorToast(e) },
  );

  const channels = channelsData?.channels ?? [];
  const instances = instancesData?.instances ?? [];

  const [editing, setEditing] = useState<{
    channel?: VideoChannelId;
    instance?: VideoModelInstance | null;
  } | null>(null);
  const [hasTriedMigrate, setHasTriedMigrate] = useState(false);

  // 首次进入页面 & 列表空时, 自动 silently 跑 migration (legacy env → instances).
  // 不弹 toast 干扰, 只有真的迁了至少 1 条才 toast.
  useEffect(() => {
    if (hasTriedMigrate || instancesLoading || !instancesData) return;
    if (instances.length > 0) return;
    setHasTriedMigrate(true);
    migrateLegacyVideoInstances()
      .then((r) => {
        if (r.migrated.length > 0) {
          toast.success(`已从老配置迁入 ${r.migrated.length} 个视频模型实例: ${r.migrated.join(", ")}`);
          void refreshInstances();
          onChanged?.();
        }
      })
      .catch(() => {/* silent */});
  }, [hasTriedMigrate, instancesLoading, instancesData, instances.length, refreshInstances, onChanged]);

  async function handleManualMigrate() {
    try {
      const r = await migrateLegacyVideoInstances();
      if (r.migrated.length > 0) {
        toast.success(`迁入 ${r.migrated.length} 个: ${r.migrated.join(", ")}`);
      } else {
        toast.info("无可迁入实例 (已迁过 / 老 env 也空)");
      }
      await refreshInstances();
      onChanged?.();
    } catch (e) {
      showErrorToast(e, "迁移失败");
    }
  }

  async function handleDelete(inst: VideoModelInstance, channel: VideoChannelDef) {
    const ok = await confirm({
      title: `删除 ${channel.label} 的「${inst.display_name}」?`,
      description: "删除后这个视频模型实例就不能用了。本地配置文件会同步清理。",
      variant: "destructive",
      confirmLabel: "删除",
    });
    if (!ok) return;
    try {
      await deleteVideoModelInstance(inst.id);
      toast.success(`已删除 ${inst.display_name}`);
      await refreshInstances();
      onChanged?.();
    } catch (e) {
      showErrorToast(e, "删除失败");
    }
  }

  if (chErr) {
    return (
      <div className="mk-card" style={{ padding: 16, color: "var(--ink-500)", fontSize: 13 }}>
        <Icon name="warning" size={13} style={{ marginRight: 6 }} />
        无法加载视频渠道列表 ({String(chErr)})
      </div>
    );
  }

  return (
    <section style={{ marginBottom: 32 }}>
      {/* Header */}
      <div style={{ marginBottom: 16, display: "flex", alignItems: "flex-end", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.12em",
              color: "var(--brand-700)",
              textTransform: "uppercase",
              marginBottom: 4,
            }}
          >
            真实视频渠道 · 二级架构
          </div>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: "var(--ink-900)" }}>
            自填模型: 渠道 + 多模型实例
          </h3>
          <p style={{ fontSize: 12.5, color: "var(--ink-600)", marginTop: 4, maxWidth: 720, lineHeight: 1.6 }}>
            每个渠道下可添加多个模型实例 (例如可灵下加 v2 / v3-i2v / v3-i2v-pro 各 1 份). 填什么模型 id 就用什么,
            不再硬编码 3.0. 选模型时在生成按钮旁的 ModelPicker 里挑.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          iconLeft="archive"
          onClick={handleManualMigrate}
          title="从老的 env / settings 字段 (KLING_ACCESS_KEY 等) 迁入实例"
        >
          迁入老配置
        </Button>
      </div>

      {/* Channel grid */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {channels.map((ch) => {
          const inst = instances.filter((i) => i.channel === ch.id);
          return (
            <ChannelCard
              key={ch.id}
              channel={ch}
              instances={inst}
              onAdd={() => setEditing({ channel: ch.id, instance: null })}
              onEdit={(i) => setEditing({ instance: i })}
              onDelete={(i) => handleDelete(i, ch)}
            />
          );
        })}
      </div>

      {/* Modal */}
      {editing && (
        <AddVideoModelModal
          channels={channels}
          initialChannel={editing.channel}
          instance={editing.instance}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            toast.success(editing.instance ? "已保存修改" : "已添加新模型");
            await refreshInstances();
            onChanged?.();
          }}
        />
      )}
    </section>
  );
}

// ─── ChannelCard ────────────────────────────────────────────────────

function ChannelCard({
  channel,
  instances,
  onAdd,
  onEdit,
  onDelete,
}: {
  channel: VideoChannelDef;
  instances: VideoModelInstance[];
  onAdd: () => void;
  onEdit: (i: VideoModelInstance) => void;
  onDelete: (i: VideoModelInstance) => void;
}) {
  return (
    <div className="mk-card" style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <Icon name="video" size={14} style={{ color: "var(--brand-600)" }} />
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink-900)" }}>{channel.label}</div>
        <span
          className="mk-pill"
          style={{ background: "var(--ink-50)", color: "var(--ink-600)", height: 20, fontSize: 10.5 }}
        >
          {channel.auth === "bearer"
            ? "Bearer Token"
            : channel.auth === "jwt_aksk"
              ? "AK + SK · JWT"
              : "AK + SK · V4 签名"}
        </span>
        {channel.needs_secret && (
          <span
            className="mk-pill"
            style={{ background: "var(--ink-50)", color: "var(--ink-600)", height: 20, fontSize: 10.5 }}
          >
            双 Key
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: "var(--ink-500)" }}>
          {instances.length} 个实例
        </span>
      </div>

      {/* Instances list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {instances.map((inst) => (
          <div
            key={inst.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 12px",
              borderRadius: 6,
              border: "1px solid var(--ink-100)",
              background: "var(--ink-50)",
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-900)" }}>
                {inst.display_name}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--ink-500)",
                  marginTop: 2,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                <code style={{ fontFamily: "monospace" }}>{inst.model_id}</code>
                {inst.api_base_url ? ` · ${inst.api_base_url}` : ""}
              </div>
            </div>
            {inst.api_key_present ? (
              <span className="mk-pill mk-pill--picked" style={{ height: 20, fontSize: 10.5 }}>
                Key 已填
              </span>
            ) : (
              <span className="mk-pill mk-pill--draft" style={{ height: 20, fontSize: 10.5 }}>
                Key 未填
              </span>
            )}
            {channel.needs_secret &&
              (inst.secret_key_present ? (
                <span className="mk-pill mk-pill--picked" style={{ height: 20, fontSize: 10.5 }}>
                  SK 已填
                </span>
              ) : (
                <span className="mk-pill mk-pill--draft" style={{ height: 20, fontSize: 10.5 }}>
                  SK 未填
                </span>
              ))}
            <Button variant="secondary" size="sm" iconLeft="edit" onClick={() => onEdit(inst)} title="编辑">
              编辑
            </Button>
            <Button variant="danger" size="sm" iconLeft="trash" onClick={() => onDelete(inst)} title="删除">
              删除
            </Button>
          </div>
        ))}

        {instances.length === 0 && (
          <div style={{ padding: 12, fontSize: 12, color: "var(--ink-500)" }}>
            尚未添加 {channel.label} 实例。点击下方"添加新模型"开始。
          </div>
        )}

        <Button
          variant="secondary"
          size="sm"
          iconLeft="plus"
          onClick={onAdd}
          style={{ alignSelf: "flex-start", marginTop: 4 }}
        >
          添加新模型
        </Button>
      </div>
    </div>
  );
}
