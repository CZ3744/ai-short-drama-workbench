/**
 * ElementGroupBindingPanel — 素材详情侧栏「共享给素材组」面板 (W7 2026-05-26).
 *
 * 让创作者在素材详情页直接管这个素材属于哪些素材组. 改一处, 所有用到该组的剧同步生效.
 *
 * UX 铁律:
 *   - #1 用户控制权: 多选 chip, 用户自己决定加入哪几个; 不强制行为
 *   - #4 就近决策: 不让用户跑到"我的剧组"另一个页面再绑定
 *   - #5 真实保存: chip 改动立即 API 同步, 不缓存草稿
 *   - #6 数据保留: 取消勾选只是从组里移除 (软删), 素材本身仍在素材库
 *   - #11 按钮带文字
 *
 * 限制: 当前后端 share-to-groups 端点只接受 prop/wardrobe/reference/misc 4 类 (character/scene
 * 走另一条 promote 路径, 待 W8 扩展). 角色/场景类不渲染该面板, 用 tooltip 说明.
 */

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { showErrorToast } from "../../lib/errorTranslate";
import { Icon } from "../shared/Icon";
import { Button } from "../ui/button";
import {
  listCasts,
  shareElementToGroups,
  removeCastElement,
  type CastWithUsage,
} from "../../lib/castApi";
import type { ElementData } from "../../lib/elementApi";

export interface ElementGroupBindingPanelProps {
  slug: string;
  element: ElementData;
  /** 写入后回调 (caller 可 refresh 卡片 / 列表). */
  onChanged?: () => void;
}

// 后端 share-to-groups 限制
const SHARABLE_KINDS: ElementData["kind"][] = ["prop", "wardrobe", "reference", "misc"];

export function ElementGroupBindingPanel({ slug, element, onChanged }: ElementGroupBindingPanelProps) {
  const [groups, setGroups] = useState<CastWithUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  async function refreshGroups() {
    try {
      const r = await listCasts();
      setGroups(r.casts);
    } catch {
      /* silent */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshGroups();
  }, []);

  // 当前 element 已加入的组 id 集合 (从 group.member_element_ids 反查)
  const memberOf = useMemo(() => {
    const s = new Set<string>();
    for (const g of groups) {
      if (g.member_element_ids.includes(element.id)) s.add(g.id);
    }
    return s;
  }, [groups, element.id]);

  async function toggleGroup(groupId: string) {
    if (busy) return;
    setBusy(true);
    const wasInGroup = memberOf.has(groupId);
    try {
      if (wasInGroup) {
        // 取消共享 — 从该组里移除该素材
        await removeCastElement(groupId, element.id);
        toast.success(`已从素材组移除`);
      } else {
        // 加入共享 — promote 到该组
        const r = await shareElementToGroups(slug, element.id, [groupId]);
        const result = r.results.find((x) => x.cast_id === groupId);
        if (result?.status === "error") {
          throw new Error(result.message || "添加失败");
        }
        toast.success(result?.status === "already" ? "该组已经有这个素材了" : "已加入素材组共享");
      }
      await refreshGroups();
      onChanged?.();
    } catch (e) {
      // 2026-05-28 audit P2: 走 showErrorToast 统一错误翻译
      showErrorToast(e, "操作失败");
    } finally {
      setBusy(false);
    }
  }

  // 角色/场景类暂不支持共享 — 显示说明而非 chip
  // P1-36 (2026-05-28 audit wave 4): 原文案"在我的剧组里管理" 是循环引导 — 我的剧组入口已被
  // 2026-05-26 audit #6 删. 现给当前可用替代 (跨项目导入) + 已有素材组列表直链.
  if (!SHARABLE_KINDS.includes(element.kind)) {
    const kindLabel = element.kind === "character" ? "角色" : "场景";
    return (
      <div
        className="mk-card"
        style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-900)" }}>
          共享给素材组
        </div>
        <div style={{ fontSize: 12, color: "var(--ink-400)", lineHeight: 1.5 }}>
          {kindLabel}类素材暂未开放共享给素材组功能 (v2 待支持).
          <br />
          当前如需跨剧复用, 走素材详情顶部「跨项目导入」 — 选另一项目的同类素材深拷贝过来.
        </div>
        {groups.length > 0 ? (
          <div style={{ fontSize: 11, color: "var(--ink-500)", marginTop: 4 }}>
            已有素材组:
            {groups.slice(0, 5).map((g, i) => (
              <span key={g.id}>
                {i > 0 ? "、" : " "}
                <Link
                  to={`/casts/${encodeURIComponent(g.id)}`}
                  style={{ color: "var(--brand-700)", textDecoration: "none" }}
                >
                  {g.name}
                </Link>
              </span>
            ))}
            {groups.length > 5 ? ` 等 ${groups.length} 个` : ""}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className="mk-card"
      style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}
    >
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-900)" }}>
          共享给素材组
        </div>
        <div style={{ fontSize: 11.5, color: "var(--ink-500)", marginTop: 2, lineHeight: 1.5 }}>
          把这个素材共享给哪些组. 共享后这些组里的剧都能直接用.
        </div>
      </div>

      {loading ? (
        <div style={{ fontSize: 12, color: "var(--ink-400)" }}>加载素材组...</div>
      ) : groups.length === 0 ? (
        <div
          style={{
            fontSize: 12,
            color: "var(--ink-500)",
            padding: 10,
            background: "var(--surface-canvas)",
            borderRadius: 8,
            border: "1px dashed var(--ink-200)",
            lineHeight: 1.5,
          }}
        >
          还没有素材组. 去素材库页面点「管理素材组」可以新建一个.
        </div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {groups.map((g) => {
            const active = memberOf.has(g.id);
            return (
              <button
                key={g.id}
                onClick={() => void toggleGroup(g.id)}
                disabled={busy}
                title={
                  active
                    ? `已加入「${g.name}」组 — 点击移除`
                    : `点击共享到「${g.name}」组 (${g.referencing_series_count} 部剧会用上)`
                }
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "5px 10px",
                  borderRadius: 999,
                  fontSize: 11.5,
                  fontWeight: active ? 600 : 500,
                  background: active ? "#dcfce7" : "#fff",
                  color: active ? "#15803d" : "var(--ink-700)",
                  border: active ? "1px solid #86efac" : "1px solid var(--ink-200)",
                  cursor: busy ? "not-allowed" : "pointer",
                  opacity: busy ? 0.6 : 1,
                  transition: "background 120ms ease",
                }}
              >
                {active ? <Icon name="check" size={11} /> : <Icon name="plus" size={11} />}
                {g.name}
              </button>
            );
          })}
        </div>
      )}

      {memberOf.size > 0 ? (
        <div
          style={{
            fontSize: 11,
            color: "var(--ink-500)",
            padding: "6px 10px",
            background: "#f0fdf4",
            border: "1px solid #bbf7d0",
            borderRadius: 6,
            lineHeight: 1.5,
          }}
        >
          已加入 {memberOf.size} 个组共享 — 改这个素材会同步到所有用到这些组的剧.
        </div>
      ) : null}
    </div>
  );
}
