import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Drawer } from "../ui/drawer";
import { useSessionStore } from "../../stores/sessionStore";
import { listSeries } from "../../lib/api";
import { getProviderHealth, type ProviderHealthResponse } from "../../lib/providerApi";
import { safeStorage } from "../../lib/safeStorage";
import { cn } from "../../lib/cn";
import { Check, Circle, ChevronRight, PartyPopper } from "../shared/LucideIcon";

// ── localStorage keys ──
// 2026-05-28 audit P2: 统一 localStorage 命名前缀 video-generate.* (跟 tasksStore 一致).
// 读时兼容老 key 防丢用户偏好.
const LS_ALL_DONE = "video-generate.onboarding.checklist-all-done.v4e";
const LS_ALL_DONE_LEGACY = "checklist_v4e_all_done";
const LS_RAN_EXAMPLE = "video-generate.onboarding.checklist-ran-example.v4e";
const LS_RAN_EXAMPLE_LEGACY = "checklist_v4e_ran_example";

function readLsCompat(key: string, legacyKey: string): string | null {
  return safeStorage.getItem(key) ?? safeStorage.getItem(legacyKey);
}
function writeLsCompat(key: string, legacyKey: string, value: string): void {
  safeStorage.setItem(key, value);
  safeStorage.removeItem(legacyKey); // 清掉老 key 防双写
}

// ── item definition ──
interface ChecklistItemDef {
  id: string;
  label: string;
  hint: string;
}

// 2026-07-09 audit: 文案改真实 —
//  - "跑一次示例项目/克隆一份示例" 其实只跳转+任意系列即打勾(承诺克隆但不克隆), 改成
//    与真实行为一致的"建第一个系列"(有系列即算完成, 名副其实).
//  - 图像/视频两项本地默认恒勾, 呈现为"已就绪·本地默认"而非像待办的"选一个 provider".
//  - 去掉 LLM key / provider / mock / API 等技术黑话(铁律 #9 toC 兜底).
const ITEMS: ChecklistItemDef[] = [
  {
    id: "llm-key",
    label: "配好一个文字模型密钥",
    hint: "配好密钥，AI 才能帮你把灵感扩写成剧本、拆分镜",
  },
  {
    id: "image-provider",
    label: "图像模型",
    hint: "已就绪 · 默认用本地免费 Stable Diffusion，可随时切换云端",
  },
  {
    id: "video-provider",
    label: "视频模型",
    hint: "已就绪 · 默认生成本地演示视频，满意后可接入真实视频模型",
  },
  {
    id: "example-project",
    label: "建第一个系列",
    hint: "进入工作台，从灵感开始做你的第一部短剧",
  },
];

/**
 * Wave 4E · 首次使用 checklist
 *
 * 首次打开时左侧滑出"完成以下 4 步开始创作"面板。
 * 每项点击跳转对应设置页,完成后打勾。
 * 4 项全绿后自动收起,并持久化到 localStorage 不再弹出。
 */
export function FirstRunChecklist({ enabled = true }: { enabled?: boolean }) {
  const navigate = useNavigate();
  const providers = useSessionStore((s) => s.providers);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  const [open, setOpen] = useState(false);
  const [llmKeyPresent, setLlmKeyPresent] = useState(false);
  const [ranExample, setRanExample] = useState(false);
  const [allDonePersisted, setAllDonePersisted] = useState(false);
  const didInit = useRef(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  // ── determine checked state for each item ──
  const imageProviderSet = !!providers.image; // default "local_sdxl_openclaw"
  const videoProviderSet = !!providers.video; // default "local_mock_video"

  // ── initialise ──
  useEffect(() => {
    if (!enabled) {
      setOpen(false);
      return;
    }
    if (didInit.current) return;
    didInit.current = true;

    // already fully done previously?
    if (readLsCompat(LS_ALL_DONE, LS_ALL_DONE_LEGACY) === "1") {
      setAllDonePersisted(true);
      return; // never show
    }

    // check ran-example flag
    if (readLsCompat(LS_RAN_EXAMPLE, LS_RAN_EXAMPLE_LEGACY) === "1") {
      setRanExample(true);
    }

    // also check via API (non-blocking)
    listSeries()
      .then((data) => {
        if (data.series && data.series.length > 0) {
          setRanExample(true);
          writeLsCompat(LS_RAN_EXAMPLE, LS_RAN_EXAMPLE_LEGACY, "1");
        }
      })
      .catch(() => {});

    // poll provider health to check if any LLM key is configured
    // P0-1 fix: use getProviderHealth() which covers ALL providers, not just ikuncode/mimo
    getProviderHealth()
      .then((h) => setLlmKeyPresent(hasAnyLLMKey(h)))
      .catch(() => {});

    setOpen(true);
  }, [enabled]);

  // ── periodic secret check while drawer is open ──
  useEffect(() => {
    if (!open) {
      if (pollTimer.current) clearInterval(pollTimer.current);
      return;
    }

    pollTimer.current = setInterval(() => {
      getProviderHealth()
        .then((h) => setLlmKeyPresent(hasAnyLLMKey(h)))
        .catch(() => {});
    }, 10000);

    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [open]);

  // ── re-check ran example on page focus ──
  useEffect(() => {
    const onFocus = () => {
      if (ranExample) return;
      const flag = readLsCompat(LS_RAN_EXAMPLE, LS_RAN_EXAMPLE_LEGACY);
      if (flag === "1") {
        setRanExample(true);
        return;
      }
      // fallback API check
      listSeries()
        .then((data) => {
          if (data.series && data.series.length > 0) {
            setRanExample(true);
            writeLsCompat(LS_RAN_EXAMPLE, LS_RAN_EXAMPLE_LEGACY, "1");
          }
        })
        .catch(() => {});
    };

    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [ranExample]);

  // ── compute done count & auto-collapse when all 4 green ──
  const checkedMap = {
    "llm-key": llmKeyPresent,
    "image-provider": imageProviderSet,
    "video-provider": videoProviderSet,
    "example-project": ranExample,
  };

  const count = Object.values(checkedMap).filter(Boolean).length;

  useEffect(() => {
    if (count === 4 && open) {
      // persist completion
      writeLsCompat(LS_ALL_DONE, LS_ALL_DONE_LEGACY, "1");
      // auto-collapse after a brief celebration delay
      const t = setTimeout(() => {
        setOpen(false);
        setAllDonePersisted(true);
      }, 1800);
      return () => clearTimeout(t);
    }
  }, [count, open]);

  // ── never show if already completed in a previous session ──
  if (!enabled) return null;
  if (allDonePersisted && !open) return null;
  if (!open) return null;

  // ── click handlers ──
  // 2026-05-27 audit P0-11: setSettingsOpen flag 没人读, 改 navigate("/settings") 真跳转
  function handleClick(itemId: string) {
    switch (itemId) {
      case "llm-key":
      case "image-provider":
      case "video-provider":
        navigate("/settings");
        break;
      case "example-project":
        navigate("/studio");
        break;
    }
    void setSettingsOpen; // 保留 import 备未来全局抽屉真实现
  }

  return (
    <Drawer
      open={open}
      onClose={() => setOpen(false)}
      side="left"
      title={
        <span className="flex items-center gap-2">
          快速开始
          {count === 4 && <PartyPopper className="h-4 w-4 text-[var(--warn)]" />}
        </span>
      }
      width="380px"
    >
      <div className="space-y-1">
        <p className="text-[var(--fs-sm)] text-[var(--ink-500)] mb-4">
          完成以下 4 步开始创作
        </p>

        {/* ── progress bar ── */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[var(--fs-xs)] text-[var(--ink-400)]">
              {count} / 4 已完成
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-[var(--ink-100)] overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500 ease-out"
              style={{
                width: `${(count / 4) * 100}%`,
                backgroundColor: count === 4 ? "var(--ok)" : "var(--brand-500)",
              }}
            />
          </div>
        </div>

        {/* ── item list ── */}
        <div className="space-y-1.5">
          {ITEMS.map((item) => {
            const checked = checkedMap[item.id as keyof typeof checkedMap];
            return (
              // 保留原因: 双色 checked 选择卡 (规则 5) — checked 时 ok-bg/ok 边框, 未 checked 时 canvas/ink-100 边框,含 check circle 子层 + 双行文本 + 右箭头复杂布局
              <button
                key={item.id}
                type="button"
                onClick={() => handleClick(item.id)}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-3 rounded-[var(--r-md)] text-left transition-all group",
                  checked
                    ? "bg-[var(--ok-bg)] border border-[var(--ok)]"
                    : "bg-[var(--surface-canvas)] border border-[var(--ink-100)] hover:border-[var(--ink-200)] hover:bg-[var(--ink-25)]",
                )}
              >
                {/* ── check circle ── */}
                <span
                  className={cn(
                    "flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center border-2 transition-colors",
                    checked
                      ? "bg-[var(--ok)] border-[var(--ok)] text-white"
                      : "border-[var(--ink-300)] text-transparent group-hover:border-[var(--ink-400)]",
                  )}
                >
                  {checked ? (
                    <Check className="h-3 w-3" strokeWidth={3} />
                  ) : (
                    <span className="w-1.5 h-1.5 rounded-full bg-transparent" />
                  )}
                </span>

                {/* ── label + hint ── */}
                <div className="flex-1 min-w-0">
                  <div
                    className={cn(
                      "text-[var(--fs-sm)] font-medium",
                      checked ? "text-[var(--ok)]" : "text-[var(--ink-700)]",
                    )}
                  >
                    {item.label}
                  </div>
                  <div className="text-[11px] text-[var(--ink-400)] truncate leading-tight mt-0.5">
                    {item.hint}
                  </div>
                </div>

                <ChevronRight
                  className={cn(
                    "h-4 w-4 flex-shrink-0 transition-colors",
                    checked
                      ? "text-[var(--ok)]"
                      : "text-[var(--ink-300)] group-hover:text-[var(--ink-500)]",
                  )}
                />
              </button>
            );
          })}
        </div>

        {/* ── all-done banner + FRC-6 CTA 按钮 ── */}
        {count === 4 && (
          <div className="mt-4 p-3 rounded-[var(--r-lg)] bg-[var(--ok-bg)] border border-[var(--ok)] text-center animate-in fade-in">
            <p className="text-[var(--fs-sm)] font-semibold text-[var(--ok)]">
              全部完成，开始创作吧！
            </p>
            <p className="text-[11px] text-[var(--ink-500)] mt-0.5 mb-3">
              面板将在片刻后自动收起
            </p>
            {/* FRC-6: 给用户一个明确的"下一步"出口 */}
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setAllDonePersisted(true);
                navigate("/studio");
              }}
              className="mk-btn mk-btn--primary mk-btn--sm"
              style={{ fontSize: 12, padding: "6px 16px" }}
            >
              进入工作台
            </button>
          </div>
        )}

        {/* ── skip hint ── */}
        {count < 4 && (
          <div className="mt-4 pt-3 border-t border-[var(--ink-100)]">
            <p className="text-[11px] text-[var(--ink-400)] text-center">
              可随时关闭，下次打开继续
            </p>
          </div>
        )}
      </div>
    </Drawer>
  );
}

/**
 * P0-1 fix: 检查所有 LLM provider 中是否有任一配置了 key.
 * 旧逻辑只查 ikuncode 和 mimo 两家, 漏了 openai / anthropic / deepseek / custom 等.
 * 改用 getProviderHealth() 返回的全量 provider 列表, 按 kind=llm + key_present 判断.
 */
function hasAnyLLMKey(h: ProviderHealthResponse): boolean {
  return h.providers.some((p) => p.kind === "llm" && p.key_present);
}
