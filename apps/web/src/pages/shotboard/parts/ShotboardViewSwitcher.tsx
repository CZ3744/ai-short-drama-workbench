// W10 (2026-05-26): 分镜板视图切换 — 列表 / 九宫格 / 时间线 三档.
// 默认列表 (向后兼容). 切换状态保存到 localStorage 按 slug+epId 隔离.
// UI: 紧贴 ShotGrid 顶部, 与"分镜列表"标签同行右侧.
import { Icon, type IconName } from "../../../components/shared/Icon";

export type ShotboardView = "list" | "board" | "timeline";

const VIEW_OPTIONS: Array<{ value: ShotboardView; icon: IconName; label: string; title: string }> = [
  { value: "list", icon: "list", label: "列表", title: "列表视图 — 详细信息一行一镜 (默认)" },
  { value: "board", icon: "grid", label: "九宫格", title: "九宫格 — 3×3 大图缩略, 一眼看全集" },
  { value: "timeline", icon: "clock", label: "时间线", title: "时间线 — 横向帧条, 像剪辑软件" },
];

// 2026-05-28 audit P2: 统一 localStorage 命名前缀, 跟 tasksStore (video-generate.tasks.v2) 一致.
// 读时兼容老 key 防丢用户偏好.
export function localStorageKey(slug: string, epId: string): string {
  return `video-generate.shotboard.view:${slug}:${epId}`;
}
function legacyKey(slug: string, epId: string): string {
  return `shotboard_view_${slug}_${epId}`;
}

export function loadView(slug: string, epId: string): ShotboardView {
  if (!slug || !epId) return "list";
  try {
    const v = localStorage.getItem(localStorageKey(slug, epId)) ?? localStorage.getItem(legacyKey(slug, epId));
    if (v === "board" || v === "timeline" || v === "list") return v;
  } catch {
    // 私有模式 / localStorage disabled — 安静走默认
  }
  return "list";
}

export function saveView(slug: string, epId: string, view: ShotboardView): void {
  if (!slug || !epId) return;
  try {
    localStorage.setItem(localStorageKey(slug, epId), view);
    // 清理老 key (老用户首次读时已 fallback 过)
    localStorage.removeItem(legacyKey(slug, epId));
  } catch {
    // 同上
  }
}

export interface ShotboardViewSwitcherProps {
  value: ShotboardView;
  onChange: (next: ShotboardView) => void;
}

export function ShotboardViewSwitcher({ value, onChange }: ShotboardViewSwitcherProps) {
  return (
    <div
      role="tablist"
      aria-label="分镜板视图"
      className="mk-tab-group"
      style={{ display: "inline-flex", gap: 2 }}
    >
      {VIEW_OPTIONS.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            title={opt.title}
            className={active ? "mk-tab mk-tab--active" : "mk-tab"}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              height: 30,
              padding: "0 10px",
              fontSize: 12,
              fontWeight: 600,
              borderRadius: 7,
            }}
          >
            <Icon name={opt.icon} size={12} />
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
