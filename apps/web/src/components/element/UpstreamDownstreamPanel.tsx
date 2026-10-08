/**
 * UpstreamDownstreamPanel — 同源派生关系侧栏面板 (W3 2026-05-26).
 *
 * 在 ElementWorkbench sidebar 显示, 条件: element.derived_from 存在 或 derivatives 非空.
 *
 * 上游块: 显示来源系列 + 元素名 + "查看变更"按钮 + "已是最新" / "有更新" 徽章
 * 下游块: 列出所有 derivatives 卡片 + 每个有"推送到这个剧"按钮
 *
 * UX 铁律:
 *   #3 信息直接可见 — 上游/下游块默认展开, 不藏 details
 *   #10 优雅空状态 — 没派生关系时整个面板不渲染 (避免占位)
 *   #11 按钮带文字 — 全部按钮图标 + 文字
 *   #9 toC 兜底 — 不暴露 element_id, 用素材名 + 项目名
 */

import { useCallback, useEffect, useState } from "react";
import { Icon } from "../shared/Icon";
import { Button } from "../ui/button";
import { UpstreamDiffModal } from "./UpstreamDiffModal";
import { PushToDownstreamModal } from "./PushToDownstreamModal";
import {
  listDerivatives,
  getUpstreamDiff,
  type DerivativeEntry,
  type ElementData,
  type UpstreamDiffResponse,
} from "../../lib/elementApi";

export interface UpstreamDownstreamPanelProps {
  slug: string;
  element: ElementData;
  /** 拉取/推送成功后写回父态. 拉取会刷新本地 element. */
  onElementUpdated: (next: ElementData) => void;
  onFlash: (msg: string) => void;
}

export function UpstreamDownstreamPanel({ slug, element, onElementUpdated, onFlash }: UpstreamDownstreamPanelProps) {
  const [derivatives, setDerivatives] = useState<DerivativeEntry[]>([]);
  const [derivativesLoaded, setDerivativesLoaded] = useState(false);
  const [upstreamDiff, setUpstreamDiff] = useState<UpstreamDiffResponse | null>(null);
  const [showDiffModal, setShowDiffModal] = useState(false);
  const [pushTarget, setPushTarget] = useState<DerivativeEntry | null>(null);

  // 拉 derivatives + upstream-diff 摘要 (用来决定徽章是 "已是最新" 还是 "有 N 项更新")
  const reload = useCallback(async () => {
    try {
      const d = await listDerivatives(slug, element.id);
      setDerivatives(d.derivatives);
      setDerivativesLoaded(true);
    } catch {
      // 不阻塞页面 — 反查失败仅不显示下游块即可
      setDerivativesLoaded(true);
    }

    if (element.derived_from) {
      try {
        const ud = await getUpstreamDiff(slug, element.id);
        setUpstreamDiff(ud);
      } catch {
        setUpstreamDiff(null);
      }
    } else {
      setUpstreamDiff(null);
    }
  }, [slug, element.id, element.derived_from]);

  useEffect(() => { void reload(); }, [reload]);

  const hasUpstream = !!element.derived_from;
  const hasDerivatives = derivatives.length > 0;

  // 关系都没就不渲染 (避免空面板占侧栏空间)
  if (!hasUpstream && !hasDerivatives && derivativesLoaded) return null;
  if (!hasUpstream && !derivativesLoaded) return null;

  return (
    <>
      <div className="mk-card" style={{ padding: 14 }}>
        <div className="mk-label" style={{ marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
          <Icon name="link" size={14} style={{ color: "var(--brand-600)" }} />
          原版 / 复制版
        </div>
        <p style={{ margin: "0 0 14px", fontSize: 11.5, color: "var(--ink-500)", lineHeight: 1.55 }}>
          跨项目复制后形成同源关系, 可以双向同步字段保持一致, 不再各自独立改.
        </p>

        {hasUpstream ? (
          <UpstreamSection
            slug={slug}
            element={element}
            diff={upstreamDiff}
            onOpenDiff={() => setShowDiffModal(true)}
          />
        ) : null}

        {hasUpstream && hasDerivatives ? <div style={{ height: 14 }} /> : null}

        {hasDerivatives ? (
          <DownstreamSection
            derivatives={derivatives}
            onPushClick={(d) => setPushTarget(d)}
          />
        ) : null}
      </div>

      <UpstreamDiffModal
        open={showDiffModal}
        slug={slug}
        element={element}
        onClose={() => setShowDiffModal(false)}
        onPulled={(next) => {
          onElementUpdated(next);
          onFlash("已从原版同步更新");
          void reload();
        }}
      />

      {pushTarget ? (
        <PushToDownstreamModal
          open={!!pushTarget}
          slug={slug}
          elementId={element.id}
          elementName={element.name}
          target={pushTarget}
          onClose={() => setPushTarget(null)}
          onPushed={() => {
            onFlash(`已同步到「${pushTarget.series_title}」`);
            void reload();
          }}
        />
      ) : null}
    </>
  );
}

// ─── 上游块 ──────────────────────────────────────────────────────

interface UpstreamSectionProps {
  slug: string;
  element: ElementData;
  diff: UpstreamDiffResponse | null;
  onOpenDiff: () => void;
}

function UpstreamSection({ element, diff, onOpenDiff }: UpstreamSectionProps) {
  if (!element.derived_from) return null;

  // 计算"有几项可更新"
  const updateCount = (() => {
    if (!diff?.diff) return 0;
    let n = 0;
    if (diff.diff.description) n++;
    if (diff.diff.tags) n++;
    if (diff.diff.primary_image_snapshot) n++;
    if (diff.diff.image_briefs_count) n++;
    return n;
  })();

  // 上游不存在的特殊态
  const upstreamMissing = diff?.reason === "upstream_series_missing" || diff?.reason === "upstream_element_missing";

  return (
    <div>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-800)", marginBottom: 8 }}>
        原版来源
      </div>
      <div
        style={{
          border: "1px solid var(--ink-200)",
          borderRadius: "var(--r-sm)",
          padding: 10,
          background: "var(--surface)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-800)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {diff?.source?.name ?? "(加载中)"}
            </div>
            <div style={{ fontSize: 11, color: "var(--ink-500)", marginTop: 2 }}>
              项目: {element.derived_from.series_slug}
            </div>
          </div>
          <UpstreamBadge missing={upstreamMissing} updateCount={updateCount} />
        </div>
        <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
          <Button
            variant="secondary"
            size="xs"
            iconLeft="search"
            onClick={onOpenDiff}
            disabled={upstreamMissing}
          >
            检查原版有没有更新
          </Button>
        </div>
      </div>
    </div>
  );
}

function UpstreamBadge({ missing, updateCount }: { missing: boolean; updateCount: number }) {
  if (missing) {
    return (
      <span
        style={{
          fontSize: 11,
          color: "var(--ink-500)",
          background: "var(--ink-100)",
          padding: "2px 8px",
          borderRadius: "var(--r-pill, 999px)",
          whiteSpace: "nowrap",
        }}
      >
        原版已删除
      </span>
    );
  }
  if (updateCount > 0) {
    return (
      <span
        style={{
          fontSize: 11,
          color: "#fff",
          background: "var(--amber-500, #f59e0b)",
          padding: "2px 8px",
          borderRadius: "var(--r-pill, 999px)",
          whiteSpace: "nowrap",
          fontWeight: 600,
        }}
      >
        有 {updateCount} 项更新
      </span>
    );
  }
  return (
    <span
      style={{
        fontSize: 11,
        color: "var(--green-700, #15803d)",
        background: "var(--green-50, #f0fdf4)",
        padding: "2px 8px",
        borderRadius: "var(--r-pill, 999px)",
        whiteSpace: "nowrap",
      }}
    >
      已是最新
    </span>
  );
}

// ─── 下游块 ──────────────────────────────────────────────────────

interface DownstreamSectionProps {
  derivatives: DerivativeEntry[];
  onPushClick: (d: DerivativeEntry) => void;
}

function DownstreamSection({ derivatives, onPushClick }: DownstreamSectionProps) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-800)" }}>
          已被这些剧复制 <span style={{ color: "var(--ink-400)", fontWeight: 400 }}>· {derivatives.length}</span>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {derivatives.map((d) => (
          <div
            key={`${d.series_slug}/${d.element_id}`}
            style={{
              border: "1px solid var(--ink-200)",
              borderRadius: "var(--r-sm)",
              padding: 10,
              background: "var(--surface)",
            }}
          >
            <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-800)" }}>
              {d.element_name}
            </div>
            <div style={{ fontSize: 11, color: "var(--ink-500)", marginTop: 2 }}>
              项目: {d.series_title}
            </div>
            <div style={{ marginTop: 8 }}>
              <Button
                variant="secondary"
                size="xs"
                iconLeft="upload"
                onClick={() => onPushClick(d)}
              >
                同步到这部剧
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
