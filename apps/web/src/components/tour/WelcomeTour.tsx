import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Button } from "../ui/button";
import { Icon } from "../shared/Icon";
import { useBodyScrollLock } from "../ui/BaseDialog";
import { createSeries } from "../../lib/api";
import { safeStorage } from "../../lib/safeStorage";

// 2026-05-28 audit P2: 统一 localStorage 命名前缀 video-generate.* (跟 tasksStore 一致).
// 读时兼容老 key 防丢用户偏好.
const STORAGE_KEY = "video-generate.onboarding.completed.v3";
const STORAGE_KEY_LEGACY = "onboarded_v3";
const STORAGE_VALUE = "demo_completed";

export function resetOnboarding() {
  safeStorage.removeItem(STORAGE_KEY);
  safeStorage.removeItem(STORAGE_KEY_LEGACY);
}

export function isOnboarded(): boolean {
  const v = safeStorage.getItem(STORAGE_KEY) ?? safeStorage.getItem(STORAGE_KEY_LEGACY);
  return v === STORAGE_VALUE;
}

export interface WelcomeTourProps {
  active: boolean;
  onClose: () => void;
}

/** T1: 首次启动 3 步引导 — 欢迎 / 配置 Key / 创建示例系列 */
export function WelcomeTour({ active, onClose }: WelcomeTourProps) {
  const [step, setStep] = useState(0);
  const [visible, setVisible] = useState(false);
  const navigate = useNavigate();

  // --- Step 2: 创建示例系列 ---
  const [creating, setCreating] = useState(false);
  const [createDone, setCreateDone] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createdSlug, setCreatedSlug] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const dialogRef = useRef<HTMLDivElement>(null);
  const creatingRef = useRef(false);
  useBodyScrollLock(active);

  // fade-in on activate
  useEffect(() => {
    if (active) {
      const t = setTimeout(() => setVisible(true), 80);
      return () => clearTimeout(t);
    }
    setVisible(false);
  }, [active]);

  // reset all state when tour opens
  useEffect(() => {
    if (active) {
      setStep(0);
      setCreating(false);
      setCreateDone(false);
      setCreateError("");
      setCreatedSlug(null);
    }
  }, [active]);

  // track mounted state to prevent updates after unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const markDone = useCallback(() => {
    safeStorage.setItem(STORAGE_KEY, STORAGE_VALUE);
    // 2026-05-28 audit P2: 兼容老 v1 埋点 (历史代码可能还在读). 同时清除 legacy 老 key, 避免双写.
    safeStorage.setItem("video-generate.onboarding.completed.v1", "1");
    safeStorage.removeItem(STORAGE_KEY_LEGACY);
    safeStorage.removeItem("onboarded_v1");
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!active || !visible) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const getFocusable = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]')).filter((element) => element.getClientRects().length > 0);
    const focusInside = () => (getFocusable()[0] ?? dialog).focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!creatingRef.current) markDone();
      } else if (event.key === "Tab") {
        const focusable = getFocusable();
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first) { event.preventDefault(); dialog.focus(); }
        else if (event.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement as HTMLElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      }
    };
    const onFocus = (event: FocusEvent) => { if (!dialog.contains(event.target as Node)) focusInside(); };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocus);
    const frame = requestAnimationFrame(focusInside);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocus);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [active, visible, markDone]);

  useEffect(() => {
    if (!active || !visible) return;
    const frame = requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>("h1, h2")?.focus());
    return () => cancelAnimationFrame(frame);
  }, [step, active, visible]);

  // --- Step 2 handlers ---

  const handleCreateDemo = useCallback(async () => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setCreateError("");
    try {
      const { series } = await createSeries({
        title: "我的第一个 AI 短剧",
        synopsis: "一段关于 AI 时代普通人的故事",
        defaults: { content_type: "short", aspect_ratio: "9:16" },
      });
      if (!mountedRef.current) return;
      setCreatedSlug(series.slug);
      setCreateDone(true);
    } catch {
      if (mountedRef.current) {
        setCreateError("创建示例系列失败，请稍后在工作台手动新建");
      }
    } finally {
      creatingRef.current = false;
      if (mountedRef.current) setCreating(false);
    }
  }, []);

  const handleGoToInbox = useCallback(() => {
    if (createdSlug) {
      markDone();
      navigate(`/studio/${createdSlug}/inbox`);
    }
  }, [createdSlug, markDone, navigate]);

  if (!active || !visible) return null;

  const stageNames = ["欢迎", "配置", "开始"];

  return createPortal(
    <div
      className="v24-onboarding-overlay"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        backgroundColor: "rgba(0, 0, 0, 0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backdropFilter: "blur(6px)",
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="studio-welcome-heading"
        tabIndex={-1}
        className="v24-onboarding-card"
        style={{
          background: "var(--surface-card, #fff)",
          borderRadius: "var(--r-xl)",
          boxShadow: "var(--shadow-xl)",
          width: 520,
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "calc(100vh - 64px)",
          overflow: "auto",
          padding: "var(--sp-6)",
        }}
      >
        {/* Header: step counter + skip */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "var(--sp-4)",
          }}
        >
          <span
            style={{
              fontSize: "var(--fs-xs)",
              color: "var(--ink-400)",
              fontWeight: 500,
            }}
          >
            {step + 1} / 3
          </span>
          <button
            onClick={markDone}
            disabled={creating}
            style={{
              fontSize: "var(--fs-xs)",
              color: "var(--ink-400)",
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 0,
            }}
            onMouseOver={(e) => {
              (e.currentTarget as HTMLElement).style.color = "var(--ink-600)";
            }}
            onMouseOut={(e) => {
              (e.currentTarget as HTMLElement).style.color = "var(--ink-400)";
            }}
          >
            <Icon name="close" size={12} style={{ display: "inline", marginRight: 4 }} />
            跳过引导
          </button>
        </div>

        {/* Step indicator */}
        <div
          className="v24-onboarding-steps"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--sp-2)",
            marginBottom: "var(--sp-5)",
          }}
        >
          {stageNames.map((name, i) => (
            <div
              key={name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--sp-2)",
                flex: i < 2 ? 1 : undefined,
              }}
            >
              {/* circle */}
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  display: "flex",
                  flexShrink: 0,
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "var(--fs-xs)",
                  fontWeight: 600,
                  transition: "all var(--dur-fast) var(--ease-out)",
                  background:
                    i < step
                      ? "var(--ok)"
                      : i === step
                        ? "var(--brand-500)"
                        : "var(--ink-200)",
                  color: i <= step ? "#fff" : "var(--ink-400)",
                }}
              >
                {i < step ? <Icon name="check" size={12} /> : i + 1}
              </div>
              {/* label */}
              <span
                style={{
                  fontSize: "var(--fs-xs)",
                  fontWeight: i === step ? 600 : 400,
                  color: i <= step ? "var(--ink-700)" : "var(--ink-400)",
                  whiteSpace: "nowrap",
                }}
              >
                {name}
              </span>
              {/* connector line */}
              {i < 2 && (
                <div
                  style={{
                    flex: 1,
                    height: 2,
                    marginLeft: "var(--sp-1)",
                    background: i < step ? "var(--ok)" : "var(--ink-200)",
                    minWidth: 20,
                    transition: "background var(--dur-fast) var(--ease-out)",
                    borderRadius: 1,
                  }}
                />
              )}
            </div>
          ))}
        </div>

        {/* STEP 0: 欢迎 */}
        {step === 0 && (
          <div className="v24-onboarding-welcome">
            <h1
              id="studio-welcome-heading"
              tabIndex={-1}
              style={{
                fontSize: "var(--fs-2xl)",
                fontWeight: 700,
                color: "var(--ink-900)",
                margin: "0 0 var(--sp-3) 0",
                lineHeight: 1.3,
                fontFamily: "'Noto Serif SC', serif",
              }}
            >
              AI 短剧生成工作台
            </h1>
            <p
              style={{
                fontSize: "var(--fs-md)",
                color: "var(--ink-500)",
                lineHeight: "var(--lh-relaxed)",
                margin: "0 0 var(--sp-4) 0",
              }}
            >
              灵感 → 剧本 → 分镜 → 生图 → 生视频 → 合成带字幕配音的 1080p MP4。
              作品与配置保存在本机，生成时使用你选择的模型服务。
            </p>

            {/* feature highlights */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "var(--sp-3)",
                marginBottom: "var(--sp-4)",
              }}
            >
              {/* 2026-07-09 audit: 欢迎步不再把架构黑话(dry-run / 真实 API / 三层管理 / 帧锚点)
                  当卖点砸给零上下文新手, 改成创作者听得懂的价值话. */}
              {[
                {
                  label: "让角色与场景更一致",
                  desc: "集中管理角色和参考图，帮助镜头保持连贯；生成效果取决于所选模型与素材",
                },
                {
                  label: "保留候选，比较再决定",
                  desc: "回看不同版本，挑选更适合故事的画面；移除素材前可以确认，并查看回收站",
                },
                {
                  label: "先审核内容，再开始生成",
                  desc: "查看提示词与参考素材后再发送，费用按你选择的模型服务计算",
                },
                {
                  label: "每一步都能重来",
                  desc: "自己写、导入内容或让 AI 协助；随时修改剧本、调整镜头和重新生成",
                },
              ].map((f, idx) => (
                <div
                  key={f.label}
                  style={{ display: "flex", gap: "var(--sp-3)", alignItems: "flex-start" }}
                >
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: "var(--r-md)",
                      flexShrink: 0,
                      background: "var(--brand-50, #eff6ff)",
                      color: "var(--brand-500)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "var(--fs-sm)",
                      fontWeight: 600,
                    }}
                  >
                    {idx + 1}
                  </div>
                  <div>
                    <div
                      style={{
                        fontSize: "var(--fs-sm)",
                        fontWeight: 600,
                        color: "var(--ink-800)",
                      }}
                    >
                      {f.label}
                    </div>
                    <div
                      style={{
                        fontSize: "var(--fs-xs)",
                        color: "var(--ink-400)",
                        marginTop: 2,
                      }}
                    >
                      {f.desc}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* next button */}
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <Button variant="primary" iconRight="arrowRight" onClick={() => setStep(1)}>下一步</Button>
            </div>
          </div>
        )}

        {/* STEP 1: 配置 API Key */}
        {step === 1 && (
          <div className="v24-onboarding-apikey">
            <h2
              id="studio-welcome-heading"
              tabIndex={-1}
              style={{
                fontSize: "var(--fs-xl)",
                fontWeight: 600,
                color: "var(--ink-900)",
                margin: "0 0 var(--sp-2) 0",
              }}
            >
              配置模型
            </h2>
            <p
              style={{
                fontSize: "var(--fs-sm)",
                color: "var(--ink-500)",
                lineHeight: "var(--lh-relaxed)",
                margin: "0 0 var(--sp-4) 0",
              }}
            >
              你可以先自己写或导入内容，需要 AI 时再连接模型。
              调用模型时，必要的提示词、参考素材和鉴权信息会发送给你选择的服务。
            </p>

            {/* 配置建议 */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "var(--sp-2)",
                marginBottom: "var(--sp-4)",
              }}
            >
              {[
                {
                  tag: "可选",
                  tagColor: "var(--brand-600)",
                  tagBg: "var(--brand-50)",
                  title: "文字模型",
                  desc: "用于扩写剧本、润色对白。按设置页提示连接自己的服务，并测试是否可用",
                },
                {
                  tag: "可选",
                  tagColor: "var(--ink-500)",
                  tagBg: "var(--ink-50)",
                  title: "图像模型",
                  desc: "为每个分镜生成首帧画面。支持 FLUX / Stable Diffusion / ChatGPT 图像等",
                },
                {
                  tag: "可选",
                  tagColor: "var(--ink-500)",
                  tagBg: "var(--ink-50)",
                  title: "视频模型",
                  desc: "把画面转成动态镜头。连接视频服务后使用，也可以导入已有视频",
                },
                {
                  tag: "可选",
                  tagColor: "var(--ok)",
                  tagBg: "var(--ok-bg, #e8f5e9)",
                  title: "语音合成",
                  desc: "连接语音服务或安装并配置本地扩展后使用；也可保留视频原声，只添加字幕",
                },
              ].map((item) => (
                <div
                  key={item.title}
                  style={{
                    display: "flex",
                    gap: "var(--sp-3)",
                    alignItems: "flex-start",
                    padding: "var(--sp-2) var(--sp-3)",
                    borderRadius: "var(--r-md)",
                    background: "var(--ink-25, #f8f8f7)",
                  }}
                >
                  <span
                    style={{
                      fontSize: "var(--fs-xs)",
                      fontWeight: 700,
                      color: item.tagColor,
                      background: item.tagBg,
                      padding: "2px 8px",
                      borderRadius: 999,
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                      marginTop: 1,
                    }}
                  >
                    {item.tag}
                  </span>
                  <div>
                    <div style={{ fontSize: "var(--fs-sm)", fontWeight: 600, color: "var(--ink-800)" }}>
                      {item.title}
                    </div>
                    <div style={{ fontSize: "var(--fs-xs)", color: "var(--ink-400)", marginTop: 1 }}>
                      {item.desc}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* action buttons */}
            <div
              style={{
                display: "flex",
                gap: "var(--sp-3)",
                justifyContent: "flex-end",
              }}
            >
              <Button variant="ghost" iconRight="arrowRight" onClick={() => setStep(2)}>
                跳过，稍后配置
              </Button>
              <Button
                variant="primary"
                iconLeft="settings"
                onClick={() => {
                  markDone();
                  navigate("/settings");
                }}
              >
                打开设置
              </Button>
            </div>
            <p
              style={{
                fontSize: "var(--fs-xs)",
                color: "var(--ink-400)",
                marginTop: "var(--sp-3)",
                textAlign: "right",
              }}
            >
              或点击"跳过"继续引导，之后随时可在设置页配置
            </p>
          </div>
        )}

        {/* STEP 2: 创建示例系列 */}
        {step === 2 && (
          <div className="v24-onboarding-demo">
            <h2
              id="studio-welcome-heading"
              tabIndex={-1}
              style={{
                fontSize: "var(--fs-xl)",
                fontWeight: 600,
                color: "var(--ink-900)",
                margin: "0 0 var(--sp-2) 0",
              }}
            >
              创建第一个系列
            </h2>
            <p
              style={{
                fontSize: "var(--fs-sm)",
                color: "var(--ink-500)",
                lineHeight: "var(--lh-relaxed)",
                margin: "0 0 var(--sp-4) 0",
              }}
            >
              创建一个示例系列，写下第一个想法。创建本身不会调用模型；之后可以自己写剧本，或选择模型协助扩写。
            </p>

            {/* 主链路说明 */}
            <div
              style={{
                background: "var(--surface-canvas, #f5f4f2)",
                borderRadius: "var(--r-lg)",
                padding: "var(--sp-4)",
                marginBottom: "var(--sp-4)",
                border: "1px solid var(--ink-100)",
              }}
            >
              <div
                style={{
                  fontSize: "var(--fs-xs)",
                  fontWeight: 700,
                  color: "var(--ink-500)",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  marginBottom: "var(--sp-2)",
                }}
              >
                完整流程
              </div>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--sp-1)",
                  fontSize: "var(--fs-xs)",
                  color: "var(--ink-600)",
                }}
              >
                {/* 2026-07-09 audit: 去掉 auto 模式 / mock / 真实 API / ffmpeg / ASS 等架构黑话,
                    改讲创作者看得懂的每步做什么; "mock" 统一说成"本地演示视频". */}
                {[
                  "灵感收件箱 — 输入你的创作想法",
                  "创作剧本 — 自己写、导入，或让已连接的模型扩写",
                  "规划分镜 — 把故事整理成可以调整的镜头列表",
                  "准备画面 — 导入素材，或选择图像模型生成首帧",
                  "制作视频 — 导入已有片段，或选择视频模型生成",
                  "合成作品 — 按需添加字幕、配音和音乐，再导出成片",
                ].map((s, i) => (
                  <div key={i} style={{ display: "flex", gap: "var(--sp-2)", alignItems: "center" }}>
                    <span
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: "50%",
                        background: "var(--brand-100)",
                        color: "var(--brand-700)",
                        display: "grid",
                        placeItems: "center",
                        fontSize: 10,
                        fontWeight: 700,
                        flexShrink: 0,
                      }}
                    >
                      {i + 1}
                    </span>
                    <span>{s}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* 状态显示 */}
            {(createDone || createError) && (
              <div
                style={{
                  marginBottom: "var(--sp-4)",
                  padding: "var(--sp-3)",
                  borderRadius: "var(--r-md)",
                  background: createDone
                    ? "var(--ok-bg, #e8f5e9)"
                    : "var(--err-bg, #fdecea)",
                  border: `1px solid ${createDone ? "var(--ok)" : "var(--err)"}`,
                }}
              >
                {createDone && (
                  <div>
                    <span style={{ fontSize: "var(--fs-sm)", color: "var(--ok)", fontWeight: 600 }}>
                      示例系列已创建
                    </span>
                    <span style={{ fontSize: "var(--fs-xs)", color: "var(--ink-500)", marginLeft: "var(--sp-2)" }}>
                      点击"进入灵感箱"开始输入你的第一个想法
                    </span>
                  </div>
                )}
                {createError && (
                  <div>
                    <span style={{ fontSize: "var(--fs-sm)", color: "var(--err)" }}>{createError}</span>
                  </div>
                )}
              </div>
            )}

            {/* action buttons */}
            <div
              style={{ display: "flex", gap: "var(--sp-3)", justifyContent: "flex-end" }}
            >
              <Button variant="ghost" iconLeft="close" onClick={markDone} disabled={creating}>
                稍后再说
              </Button>
              {!createDone && (
                <Button variant="primary" iconLeft="plus" onClick={handleCreateDemo} loading={creating} disabled={creating}>
                  {creating ? "创建中…" : "创建示例系列"}
                </Button>
              )}
              {createDone && (
                <Button variant="primary" onClick={handleGoToInbox}>
                  进入灵感箱 <Icon name="arrowRight" size={13} />
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
