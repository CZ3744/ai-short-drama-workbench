// 来源: design-skill/video-generate/src/batch2a.jsx:650-697 + batch2b.jsx 的 diff 卡变体
// v24-batch-all · AI 建议差异卡 — 展示 modify/insert/rewrite/delete 的前后对比
import { Icon } from "../shared/Icon";
import { Button } from "../ui/button";

export type PatchKind = "modify" | "insert" | "rewrite" | "delete";

export interface PatchDiffRow {
  before?: string;
  after?: string;
  isField?: boolean;
  isNew?: boolean;
}

export interface PatchCardProps {
  kind: PatchKind;
  path: string;
  title: string;
  rows?: PatchDiffRow[];
  affect?: string;
  onAccept?: () => void;
  onReject?: () => void;
  onRegen?: () => void;
}

const KIND_LABEL: Record<PatchKind, string> = {
  modify: "改",
  insert: "加",
  rewrite: "重写",
  delete: "删",
};

export function PatchCard(p: PatchCardProps) {
  return (
    <div className="v24-patch">
      <div className="v24-patch-head">
        <span className={`v24-patch-tag v24-patch-tag--${p.kind}`}>{KIND_LABEL[p.kind]}</span>
        <span className="v24-patch-title">{p.title}</span>
        <span className="v24-patch-path" style={{ marginLeft: "auto" }}>{p.path}</span>
      </div>

      {p.rows && p.rows.length > 0 ? (
        <div className="v24-patch-body">
          {p.rows.map((r, i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {r.before ? (
                <div className="v24-patch-diff-old">
                  <span style={{ fontFamily: "ui-monospace, Consolas, monospace", fontSize: 11, opacity: 0.6 }}>−</span>
                  <span>{r.before}</span>
                </div>
              ) : null}
              {r.after ? (
                <div className="v24-patch-diff-new">
                  <Icon name="plus" size={12} />
                  <span>{r.after}</span>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {p.affect ? (
        <div className="v24-patch-affect">
          <Icon name="info" size={12} />
          <span>{p.affect}</span>
        </div>
      ) : null}

      <div className="v24-patch-acts">
        <Button variant="primary" iconLeft="check" onClick={p.onAccept}>接受</Button>
        <Button variant="ghost" iconLeft="close" onClick={p.onReject}>丢弃</Button>
        {p.onRegen ? (
          <Button variant="ghost" iconLeft="refresh" style={{ marginLeft: "auto" }} onClick={p.onRegen}>换一个</Button>
        ) : null}
      </div>
    </div>
  );
}
