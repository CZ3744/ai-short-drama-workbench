// ChatgptOauthCard
//
// 2026-05-14 重写: 去掉 3s 轮询 (PM 反馈: 存在感太强, 浪费资源).
// 现在的状态更新走两个信号源:
//   1. 浏览器回调页的 window.opener.postMessage({type:"chatgpt_oauth_success"})
//   2. SWR revalidateOnFocus: 用户切回这个 tab 时自动拉一次
// 主要前提是用户登录成功后会回到这个 tab, 那时刷新一次就够了。
//
// 切换账号: 直接发起新的 force_login=true 流程 (logout + prompt=login), 一键完成。

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Icon } from "../shared/Icon";
import { Textarea } from "../ui/textarea";
import { formatBeijingTime } from "../../lib/format";
import {
  getChatgptOauthStatus,
  startChatgptOauth,
  cancelChatgptOauth,
  logoutChatgptOauth,
  refreshChatgptOauth,
  testChatgptOauth,
  testGenerateChatgptImage,
  type ChatgptOauthStatusResponse,
} from "../../lib/api";
import { showErrorToast } from "../../lib/errorTranslate";
import { useConfirm } from "../ui/ConfirmModal";
import { invalidateProviders } from "../../lib/swrInvalidate";
import { Button } from "../ui/button";

const SWR_KEY = "settings:chatgpt-oauth-status";

const CHATGPT_IMAGE_TEST_PRESETS = [
  {
    label: "中文卡片",
    prompt:
      'A sharp product photo of a white card on a clean desk. The card has readable black Chinese text "OAuth 测试通过". Natural daylight, realistic shadows, 1024 square composition.',
  },
  {
    label: "分镜首帧",
    prompt:
      "A cinematic still frame for a short film: a young creator sits beside a glowing laptop in a small studio at dusk, warm practical lights, detailed props, realistic 35mm photography.",
  },
  {
    label: "封面海报",
    prompt:
      "A polished editorial poster for an AI video production tool, clean typography area, layered paper textures, teal and coral accents, premium software campaign style.",
  },
];

function formatTtl(seconds?: number | null): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "未知";
  if (seconds <= 0) return "已到期";
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} 秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时`;
  return `${Math.round(seconds / 86400)} 天`;
}

function formatExpiry(status: ChatgptOauthStatusResponse["status"]): string {
  if (!status?.expires_at_ms) return "未知";
  const ttl = formatTtl(status.expires_in_seconds);
  const at = formatBeijingTime(status.expires_at_ms, { mode: "datetime" });
  return `${ttl}后 (${at})`;
}

export function ChatgptOauthCard() {
  const confirm = useConfirm();
  const [flowInProgress, setFlowInProgress] = useState(false);
  const [actionBusy, setActionBusy] = useState<"login" | "switch" | "logout" | "refresh" | "test" | "gen" | null>(null);
  const [lastTest, setLastTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [genResult, setGenResult] = useState<{ ok: boolean; dataUrl?: string; elapsedMs?: number; saved?: string; error?: string } | null>(null);
  const [testPrompt, setTestPrompt] = useState(CHATGPT_IMAGE_TEST_PRESETS[0].prompt);
  const popupRef = useRef<Window | null>(null);

  const { data, mutate } = useSWR<ChatgptOauthStatusResponse>(
    SWR_KEY,
    () => getChatgptOauthStatus(),
    {
      // 这是关键改动:
      //   - revalidateOnFocus: 用户从登录浏览器 tab 切回 app tab 时自动重拉
      //   - 不主动轮询 (refreshInterval 不设)
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      onError: (err) => showErrorToast(err),
    },
  );

  // 监听回调页 postMessage —— 主路径, 几乎瞬时
  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      // 2026-05-28 P0-22 安全洞修: 严格校验 ev.origin === window.location.origin.
      // OAuth 回调页通过 window.opener.postMessage 发, 浏览器把 opener origin 给 ev.origin.
      // 我们的回调页跟主 app 同源 (5173 / 同一 SPA), 任何跨域页面的 postMessage 一律忽略,
      // 防恶意网页伪造 "OAuth 登录成功" 状态.
      if (ev.origin !== window.location.origin) return;
      const data = ev.data as { type?: string; at?: number } | null;
      if (!data || typeof data !== "object" || data.type !== "chatgpt_oauth_success") return;
      // 来到这里说明 OAuth 流程成功 —— 立刻拉状态
      setFlowInProgress(false);
      void mutate();
      // P2 (2026-05-20): 用 invalidateProviders helper, 避免散落的 key 字符串
      void invalidateProviders();
      // 关闭还开着的 popup (如果它没自动关)
      try { popupRef.current?.close(); } catch { /* ignore */ }
      popupRef.current = null;
      toast.success("ChatGPT 登录成功");
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [mutate]);

  const status = data?.status ?? null;
  const loggedIn = !!status?.logged_in;

  async function openOauth(forceLogin: boolean) {
    setActionBusy(forceLogin ? "switch" : "login");
    setFlowInProgress(true);
    try {
      const res = await startChatgptOauth({ force_login: forceLogin });
      const win = window.open(res.authorize_url, "chatgpt-oauth", "noopener=no,width=560,height=720");
      if (!win) {
        await navigator.clipboard.writeText(res.authorize_url).catch(() => undefined);
        toast.message("浏览器似乎拦截了弹窗,授权链接已复制到剪贴板,请在浏览器粘贴打开");
      } else {
        popupRef.current = win;
        toast.message(forceLogin ? "已退出当前账号,请在浏览器选择 / 登录新账号" : "已打开 OpenAI 授权页面,完成登录后会自动返回");
      }
    } catch (err: any) {
      setFlowInProgress(false);
      // A3: 端口冲突的专门提示
      if (err?.code === "OAUTH_PORT_IN_USE" || /OAUTH_PORT_IN_USE|1455.*占用|EADDRINUSE/i.test(err?.message ?? "")) {
        toast.error("本机 1455 端口被占用 — 通常是 Codex CLI / OpenClaw 也在做 OAuth, 关掉它们后再试");
      } else {
        showErrorToast(err);
      }
    } finally {
      setActionBusy(null);
    }
  }

  async function handleLogin() {
    await openOauth(false);
  }

  async function handleSwitchAccount() {
    const ok = await confirm({
      title: "切换 ChatGPT 账号?",
      description: "切换账号会清掉当前登录, 然后让你选择新的 ChatGPT 账号。",
      variant: "warning",
      confirmLabel: "切换账号",
    });
    if (!ok) return;
    // 先 logout, 再带 prompt=login 启动新流程
    try {
      await logoutChatgptOauth();
      await mutate();
    } catch (err) {
      showErrorToast(err);
      return;
    }
    await openOauth(true);
  }

  async function handleCancel() {
    try {
      await cancelChatgptOauth();
      setFlowInProgress(false);
      toast.message("已取消登录流程");
    } catch (err) {
      showErrorToast(err);
    }
  }

  async function handleLogout() {
    setActionBusy("logout");
    try {
      await logoutChatgptOauth();
      toast.success("已退出 ChatGPT 登录");
      await mutate();
      await invalidateProviders();
    } catch (err: any) {
      // A2: 后端检测到还有在跑的 codex 生图任务,提示用户决定是否强制登出
      const status = err?.status ?? err?.response?.status;
      const code = err?.code ?? err?.body?.error?.code;
      if (status === 409 || code === "INFLIGHT_TASKS") {
        const detail = err?.body?.error?.message ?? "还有 ChatGPT 生图任务在跑";
        const ok = await confirm({
          title: "还有任务在跑, 仍要登出吗?",
          description: `${detail}\n\n这些任务可能会半路 401 失败。`,
          variant: "destructive",
          confirmLabel: "强制登出",
        });
        if (ok) {
          try {
            await logoutChatgptOauth({ force: true });
            toast.success("已强制登出");
            await mutate();
          } catch (e) { showErrorToast(e); }
        }
      } else {
        showErrorToast(err);
      }
    } finally {
      setActionBusy(null);
    }
  }

  async function handleRefresh() {
    setActionBusy("refresh");
    try {
      const res = await refreshChatgptOauth();
      const ttl = formatTtl(res.expires_in_seconds);
      if (res.expires_in_seconds !== undefined && res.expires_in_seconds !== null && res.expires_in_seconds <= 60) {
        toast.warning(`令牌已刷新,但服务端返回有效期很短 (${ttl}); 后续调用会按需自动再刷新`);
      } else {
        toast.success(`令牌已刷新,有效期约 ${ttl}`);
      }
      await mutate();
    } catch (err) {
      showErrorToast(err);
    } finally {
      setActionBusy(null);
    }
  }

  async function handleTest() {
    setActionBusy("test");
    try {
      const res = await testChatgptOauth();
      setLastTest({ ok: res.ok, message: res.message });
      if (res.ok) toast.success(`登录检查通过: ${res.message}`);
      else toast.error(`登录检查失败: ${res.message}`);
    } catch (err) {
      showErrorToast(err);
    } finally {
      setActionBusy(null);
    }
  }

  // 2026-05-14: 一键生成测试图,验证 OAuth → Codex → gpt-image-2 全链路打通
  async function handleTestGenerate() {
    const promptText = testPrompt.trim();
    if (!promptText) {
      const msg = "测试提示词不能为空";
      setGenResult({ ok: false, error: msg });
      toast.error(msg);
      return;
    }

    setActionBusy("gen");
    setGenResult(null);
    try {
      const res = await testGenerateChatgptImage(promptText, { width: 1024, height: 1024 });
      if (res.ok && res.images?.length) {
        setGenResult({
          ok: true,
          dataUrl: res.images[0].data_url,
          elapsedMs: res.elapsed_ms,
          saved: res.meta_path,
        });
        toast.success(`生图成功 (${(res.elapsed_ms / 1000).toFixed(1)}s),已存档到 ${res.saved_dir}`);
      } else {
        const msg = res.error?.message ?? "未返回图像";
        setGenResult({ ok: false, error: msg, elapsedMs: res.elapsed_ms });
        toast.error(`生图失败: ${msg}`);
      }
    } catch (err: unknown) {
      // 2026-05-28 audit P2: 走 showErrorToast 统一错误翻译 + 收掉 as any
      const e = err as { body?: { error?: { message?: string } }; message?: string };
      const msg = e?.body?.error?.message ?? e?.message ?? String(err);
      setGenResult({ ok: false, error: msg });
      showErrorToast(err, `生图失败: ${msg.slice(0, 200)}`);
    } finally {
      setActionBusy(null);
    }
  }

  return (
    <div className="mk-card" style={{ padding: 18, marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 14 }}>
        <div style={{
          width: 40, height: 40, borderRadius: 10,
          background: loggedIn
            ? "linear-gradient(135deg, #10a37f, #064e3b)"
            : "linear-gradient(135deg, #94a3b8, #475569)",
          color: "#fff", display: "grid", placeItems: "center", fontWeight: 700, fontSize: 17
        }}>
          GPT
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: "var(--ink-900)" }}>
              OAuth · gpt-image-2
            </span>
            {loggedIn ? (
              <span className="mk-pill mk-pill--ok" style={{ fontSize: 10 }}>
                <Icon name="check" size={11} /> 已登录
              </span>
            ) : (
              <span className="mk-pill" style={{ fontSize: 10, background: "var(--ink-100)", color: "var(--ink-600)" }}>
                未登录
              </span>
            )}
            {flowInProgress && !loggedIn && (
              <span className="mk-pill" style={{ fontSize: 10, background: "var(--brand-50)", color: "var(--brand-700)" }}>
                浏览器中…
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: "var(--ink-600)", marginTop: 4, lineHeight: 1.6 }}>
            用你的 ChatGPT Plus/Pro/Team 账号登录, 生图走 ChatGPT 订阅配额 (走 Codex /backend-api/codex/responses + image_generation 工具),
            不消耗 OpenAI API Key 余额。和 Codex CLI / OpenClaw v2026.4.23+ 使用同一套 OAuth 流程。
          </div>
          {loggedIn && status && (
            <div style={{ fontSize: 11.5, color: "var(--ink-500)", marginTop: 6 }}>
              账号: <strong style={{ color: "var(--ink-700)" }}>{status.account_email ?? "(未知)"}</strong>
              {" · "}
              令牌有效期: {formatExpiry(status)}
              {status.needs_refresh && (
                <span style={{ color: "var(--warn-700)", marginLeft: 6 }}>(即将到期, 会按需自动刷新)</span>
              )}
              <br />
              本机配额计数 ({status.quota_period}): <strong style={{ color: "var(--ink-700)" }}>{status.quota_used} 张</strong>
              <span style={{ fontSize: 10.5, opacity: 0.7, marginLeft: 4 }}>(仅本机累加,ChatGPT 不公开真实剩余)</span>
            </div>
          )}
        </div>
      </div>

      {loggedIn && (
        <div style={{ marginBottom: 12, paddingTop: 2 }}>
          <Textarea
            rows={4}
            value={testPrompt}
            onChange={(e) => setTestPrompt(e.target.value)}
            disabled={actionBusy !== null}
            placeholder="输入测试图提示词"
            className="min-h-[96px]"
          />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
            {CHATGPT_IMAGE_TEST_PRESETS.map((preset) => (
              <Button
                key={preset.label}
                variant="secondary"
                size="xs"
                disabled={actionBusy !== null}
                onClick={() => {
                  setTestPrompt(preset.prompt);
                  setGenResult(null);
                }}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {!loggedIn && !flowInProgress && (
          <Button
            variant="primary"
            size="sm"
            iconLeft="link"
            disabled={actionBusy !== null}
            loading={actionBusy === "login"}
            onClick={handleLogin}
          >
            {actionBusy === "login" ? "正在打开浏览器…" : "用 ChatGPT 账号登录"}
          </Button>
        )}
        {flowInProgress && !loggedIn && (
          <Button variant="secondary" size="sm" iconLeft="close" onClick={handleCancel}>
            取消登录
          </Button>
        )}
        {loggedIn && (
          <>
            <Button
              variant="primary"
              size="sm"
              iconLeft="sparkles"
              onClick={handleTestGenerate}
              disabled={actionBusy !== null}
              loading={actionBusy === "gen"}
              title="发一次真实生图请求测试链路打通,会消耗一张 ChatGPT 订阅额度"
            >
              {actionBusy === "gen" ? "生图中…" : "生成测试图"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              iconLeft="zap"
              onClick={handleTest}
              disabled={actionBusy !== null}
              loading={actionBusy === "test"}
            >
              {actionBusy === "test" ? "检查中…" : "检查登录状态"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              iconLeft="refresh"
              onClick={handleRefresh}
              disabled={actionBusy !== null}
              loading={actionBusy === "refresh"}
            >
              {actionBusy === "refresh" ? "刷新中…" : "刷新令牌"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              iconLeft="refresh-cw"
              onClick={handleSwitchAccount}
              disabled={actionBusy !== null}
              loading={actionBusy === "switch"}
            >
              {actionBusy === "switch" ? "切换中…" : "切换账号"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              iconLeft="logout"
              onClick={handleLogout}
              disabled={actionBusy !== null}
              loading={actionBusy === "logout"}
            >
              {actionBusy === "logout" ? "退出中…" : "退出登录"}
            </Button>
          </>
        )}
      </div>

      {lastTest && (
        <div style={{ marginTop: 10, fontSize: 12, color: lastTest.ok ? "var(--ok-700)" : "var(--err-700)" }}>
          {lastTest.ok ? "✓ " : "✗ "}{lastTest.message}
        </div>
      )}

      {genResult && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--ink-100)" }}>
          {genResult.ok && genResult.dataUrl ? (
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
              <img
                src={genResult.dataUrl}
                alt="ChatGPT OAuth 测试图"
                style={{
                  width: 220,
                  maxWidth: "100%",
                  aspectRatio: "1 / 1",
                  objectFit: "contain",
                  borderRadius: 8,
                  border: "1px solid var(--ink-200)",
                  background: "var(--ink-50)",
                }}
              />
              <div style={{ flex: 1, minWidth: 220, fontSize: 12, lineHeight: 1.7, color: "var(--ink-600)" }}>
                <div style={{ color: "var(--ok)", fontWeight: 700 }}>生成成功</div>
                {genResult.elapsedMs !== undefined && <div>耗时: {(genResult.elapsedMs / 1000).toFixed(1)}s</div>}
                {genResult.saved && <div style={{ wordBreak: "break-all" }}>记录: {genResult.saved}</div>}
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "var(--err)", lineHeight: 1.7 }}>
              {genResult.error ?? "生成失败"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
