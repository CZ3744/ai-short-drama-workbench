// 来源: design-skill/video-generate/src/batch2b.jsx:1320-1491 (FailureCenter)
// v24-batch-all · 单镜失败中心
//
// 布局:
//   左列: 失败堆栈 (按时间倒序) — 每条: 阶段 / 模型 / code / 错误摘要 / [切模型重试]
//   右列: 提示词历史时间线 + 点开查看 request/response JSON
//
// 路由: /studio/:slug/shot-stage/:epId/:shotId/failures

import { useCallback, useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ModelSplitButton } from "../../components/shot-stage";
import { Icon } from "../../components/shared/Icon";
import { Button } from "../../components/ui/button";
import { listShotFailures, retryFailure, retryWithModel, dismissFailure, isNotImplemented, type ShotFailure } from "../../lib/shotApi";
import { labelOfStage, labelOfErrorCode, friendlyTaskError, labelEpisodeId } from "../../lib/sourceLabels";
import { useShots } from "../../hooks/useShots";
import { formatBeijingTime } from "../../lib/format";
import { showErrorToast } from "../../lib/errorTranslate";

export default function ShotFailureCenter() {
  const { slug = "", epId = "", shotId = "" } = useParams();
  const navigate = useNavigate();
  const { shots } = useShots(slug || undefined, epId || undefined);
  const currentShot = shots.find((shot) => shot.id === shotId);
  const shotLabel = currentShot?.title?.trim() || (currentShot ? `第 ${currentShot.index} 镜` : "镜头失败记录");
  const [failures, setFailures] = useState<ShotFailure[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notImpl, setNotImpl] = useState(false);

  // BUG-24 fix: 用 useCallback 包裹 reload，加入 useEffect deps
  const reload = useCallback(async () => {
    try {
      // 2026-05-26 walkthrough fix: shotId 不全局唯一, 必须传 slug+epId 显式定位.
      const r = await listShotFailures(shotId, slug || undefined, epId || undefined);
      // W3-A: isNotImplemented 只在后端真的返回 not_implemented:true 时为 true;
      // 后端 GET /shots/:sid/failures 现在已接通, 空数组就是「暂无失败」, 不是「未实现」。
      if (isNotImplemented(r)) {
        setNotImpl(true);
        setFailures([]);
      } else {
        setNotImpl(false);
        setFailures(Array.isArray(r?.failures) ? r.failures : []);
      }
    } catch (err) {
      showErrorToast(err, "加载失败记录失败");
    }
  }, [shotId, slug, epId]);

  useEffect(() => { void reload(); }, [reload]);

  async function doRetry(aid: string) {
    setBusy(aid);
    try {
      await retryFailure(shotId, aid);
      await reload();
    } catch (err) {
      showErrorToast(err, "重试失败");
    } finally {
      setBusy(null);
    }
  }
  async function doRetryModel(aid: string, model: string) {
    setBusy(aid);
    try {
      await retryWithModel(shotId, aid, model);
      await reload();
    } catch (err) {
      showErrorToast(err, "换模型重试失败");
    } finally {
      setBusy(null);
    }
  }
  async function doDismiss(aid: string) {
    setBusy(aid);
    try {
      await dismissFailure(shotId, aid);
      setFailures(failures.filter((f) => f.attempt_id !== aid));
    } catch (err) {
      showErrorToast(err, "忽略失败记录失败");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="v24-stage-page">
      <div style={{ padding: "14px 24px", background: "var(--surface-card)", borderBottom: "1px solid var(--ink-100)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <Button variant="ghost" iconLeft="back" onClick={() => navigate(`/studio/${encodeURIComponent(slug)}/shot-stage/${encodeURIComponent(epId)}/${encodeURIComponent(shotId)}`)}>
          返回单镜创作
        </Button>
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--brand-700)", letterSpacing: "0.06em" }}>失败中心</span>
        <span className="v24-shot-title" style={{ fontSize: 15, overflowWrap: "anywhere" }}>{shotLabel}</span>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--ink-500)" }}>
          {labelEpisodeId(epId)} · 共 {failures.length} 条记录
        </span>
      </div>

      {notImpl ? (
        <div style={{ padding: "8px 24px", background: "var(--warn-bg)", color: "var(--ink-700)", fontSize: 12 }}>
          ⚠ 失败中心功能尚在接通中 — 后端 <code>GET /api/v2/shots/{"{shotId}"}/failures</code> 暂未返回真实数据。
        </div>
      ) : null}

      {/* W3-A: 单列布局 — 右栏 320px「提示词历史」尚未实现, 直接收掉, 避免占用空间。
         后续 prompt-history 接通后, 可以再加一行 Section 在左侧主流之下。 */}
      <div className="v24-stage-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
          {failures.length === 0 ? (
            <div className="mk-card" style={{ padding: 40, textAlign: "center", color: "var(--ink-400)" }}>
              {notImpl ? "失败中心功能尚在接通中" : "此分镜暂无失败记录"}
            </div>
          ) : failures.map((f) => (
            <div key={f.attempt_id} className="mk-card" style={{ padding: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ padding: "2px 8px", background: "var(--err-bg)", color: "var(--err)", fontSize: 10, fontWeight: 700, borderRadius: 999 }}>
                  {labelOfErrorCode(f.code) ?? "ERROR"}
                </span>
                <span style={{ fontSize: 12, color: "var(--ink-500)" }}>{labelOfStage(f.stage)}</span>
                {f.model ? <span style={{ fontSize: 11, color: "var(--brand-700)" }}>· {f.model}</span> : null}
                <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--ink-400)", fontFamily: "ui-monospace, monospace" }}>
                  {formatBeijingTime(f.at, { mode: "full" })}
                </span>
              </div>
              <div style={{ marginTop: 8, fontSize: 13, color: "var(--ink-800)", lineHeight: 1.6 }}>
                {friendlyTaskError(f.message)}
              </div>
              <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <Button variant="ghost" iconLeft="refresh" onClick={() => doRetry(f.attempt_id)} disabled={busy === f.attempt_id}>
                  原样重试
                </Button>
                {/* 核心: split-button 切模型重试. 使用 ModelSplitButton 但仅处理 change 事件触发重试 */}
                <ModelSplitButton
                  actionKey={f.stage === "video" ? "i2v" : "t2i"}
                  label="切模型重试"
                  compact
                  onGenerate={(modelId) => doRetryModel(f.attempt_id, modelId)}
                  onChange={(modelId) => doRetryModel(f.attempt_id, modelId)}
                  defaultModel={f.suggested_model}
                />
                <Button variant="ghost" iconLeft="close" style={{ marginLeft: "auto" }} onClick={() => doDismiss(f.attempt_id)} disabled={busy === f.attempt_id}>
                  忽略
                </Button>
                <Button variant="ghost" iconLeft="code" onClick={() => setExpanded(expanded === f.attempt_id ? null : f.attempt_id)}>
                  {expanded === f.attempt_id ? "收起" : "展开"} JSON
                </Button>
              </div>
              {expanded === f.attempt_id ? (
                <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <JsonBox title="Request" value={f.request_json} />
                  <JsonBox title="Response" value={f.response_json} />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function JsonBox({ title, value }: { title: string; value: unknown }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--ink-500)", marginBottom: 4 }}>{title}</div>
      <pre style={{ padding: 10, background: "#1a1816", color: "#e7e2d6", borderRadius: 8, fontSize: 10, maxHeight: 200, overflow: "auto" }}>
{value ? JSON.stringify(value, null, 2) : "(无)"}
      </pre>
    </div>
  );
}
