import { buildProviderUpdate, type ProviderFormState } from "../lib/providerForm";
import "./SettingsPage.css";
// SettingsPage · cc-switch 风格 (重写 2026-05-13)
// 左 TOC 5 tab: text / image / video / realvideo / about
// 每个 modality tab 列出对应 provider 卡片 (内置 + 自定义合并, 来自 GET /api/v2/providers/presets)
// 新增/编辑用模态弹窗, kind 决定字段, 测延迟仅 text tab 可用, 一键拉模型走 fetch-models endpoint
// 视觉沿用 v24 (mk-card / mk-btn / mk-pill / Icon), 无新依赖
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import useSWR from "swr";
import { toast } from "sonner";
import { Icon } from "../components/shared/Icon";
import type { IconName } from "../components/shared/Icon";
import { PageTransition } from "../components/studio/PageTransition";
import { formatBeijingTime } from "../lib/format";
// 2026-07-09 audit C28: 真实视频锁持有者行 + 消耗榜过 labelOfSource/labelEpisodeId 翻人话 (铁律 #9 toC 兜底).
import { labelOfSource, labelEpisodeId } from "../lib/sourceLabels";
import {
  listUserProviders,
  createUserProvider,
  updateUserProvider,
  deleteUserProvider,
  getKnownModels,
  testProviderLatency,
  testUserProviderConnection,
  getRealVideoLockStatus,
  apiPost,
  getBudgetStatus,
  patchV2Settings,
  getUsageStatus,
  type UserProvider,
  type UserProvidersGrouped,
  type CreateProviderInput,
  type PatchV2SettingsInput,
  type ProviderKind,
  type ApiType,
  type BudgetStatus,
  type UsageStatus,
} from "../lib/api";
import {
  getProviderChain,
  updateProviderChain as updateProviderChainApi,
  resetProviderChain,
  getProviderHealth,
  tryProviderLlm,
  type ProviderChainResponse,
  type ProviderHealthResponse,
  type LlmTryResult,
} from "../lib/providerApi";
import { testTtsVoice } from "../lib/settingsApi";
import { showErrorToast } from "../lib/errorTranslate";
import { ChatgptOauthCard } from "../components/settings/ChatgptOauthCard";
import { VideoInstancesSection } from "../components/settings/VideoInstancesSection";
import { VideoProviderPriceTable } from "../components/settings/VideoProviderPriceTable";
import { useConfirm } from "../components/ui/ConfirmModal";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { invalidateProviders } from "../lib/swrInvalidate";
import { Button } from "../components/ui/button";
// 2026-05-28 P1-1: 把这三个 import 从文件中部 line 1119-1121 移到顶部, 跟其他 import 一起.
// 中部 import 一旦项目走 ESM strict 或 Vite tree-shaking 升级会出问题, 也不便审阅.
import { createBackupArchive, restoreBackupArchive, importProjectArchive } from "../lib/storageApi";
import { useRef, useState as useStateForDataMgmt } from "react";
import { PromptDialog } from "../components/ui/prompt-dialog";


type TabKey = "text" | "image" | "video" | "tts" | "realvideo" | "chain" | "budget" | "usage" | "about";

const TABS: Array<{ id: TabKey; label: string; icon: IconName }> = [
  { id: "text",      label: "文字模型",        icon: "type" },
  { id: "image",     label: "图像模型",        icon: "image" },
  { id: "video",     label: "视频模型",        icon: "video" },
  { id: "tts",       label: "语音模型",        icon: "bolt" },
  { id: "realvideo", label: "真实视频锁",      icon: "lock" },
  { id: "chain",     label: "链路",            icon: "link" },
  { id: "budget",    label: "预算",            icon: "coin" },
  { id: "usage",     label: "用量",            icon: "chart" },
  { id: "about",     label: "关于",            icon: "help" },
];

const KIND_LABEL: Record<ProviderKind, string> = {
  llm: "文字",
  image: "图像",
  video: "视频",
  tts: "TTS",
};

const API_TYPE_LABEL: Record<ApiType, string> = {
  openai_compat: "OpenAI 兼容",
  anthropic: "Anthropic",
  custom: "自定义",
};

const API_TYPES_BY_KIND: Record<ProviderKind, ApiType[]> = {
  llm: ["openai_compat", "anthropic", "custom"],
  image: ["openai_compat", "custom"],
  video: ["openai_compat", "custom"],
  tts: ["openai_compat", "custom"],
};

interface EditorState {
  mode: "create" | "edit";
  kind: ProviderKind; // text / image / video — UI 上 text 对应 backend kind=llm
  /** 仅 edit 模式: 当前正在编辑的 provider id */
  editingId?: string;
  /** 仅 edit 模式: 当前 provider 是否是内置 (内置只允许 enable 切换, 不许改 base_url / 删除) */
  isBuiltin?: boolean;
}

type FormState = ProviderFormState;

function emptyForm(api_type: ApiType): FormState {
  return {
    id: "",
    label_zh: "",
    api_type,
    base_url: "",
    api_key: "",
    model_id: "",
    custom_headers: {},
    anthropic_version: api_type === "anthropic" ? "2023-06-01" : "",
    notes: "",
    enabled: true,
  };
}

interface BuiltinExtraField {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
  hint?: string;
}

const BUILTIN_EXTRA_FIELDS: Record<string, BuiltinExtraField[]> = {
  jimeng_video_3pro: [
    { key: "access_key", label: "访问密钥 ID", secret: true, placeholder: "(保持不变)", hint: "火山引擎 Access Key ID" },
    { key: "secret_key", label: "访问密钥 Secret", secret: true, placeholder: "(保持不变)", hint: "留空则保留当前值" },
  ],
  jimeng_video_3_720p: [
    { key: "access_key", label: "访问密钥 ID", secret: true, placeholder: "(保持不变)", hint: "火山引擎 Access Key ID" },
    { key: "secret_key", label: "访问密钥 Secret", secret: true, placeholder: "(保持不变)", hint: "留空则保留当前值" },
  ],
  kling_3: [
    { key: "access_key", label: "访问密钥 ID", secret: true, placeholder: "(保持不变)" },
    { key: "secret_key", label: "访问密钥 Secret", secret: true, placeholder: "(保持不变)", hint: "可灵签名密钥,留空保留当前值" },
  ],
  tencent_hunyuan_video: [
    { key: "secret_key", label: "访问密钥 Secret", secret: true, placeholder: "(保持不变)", hint: "腾讯云访问密钥 Secret,留空保留当前值" },
    { key: "region", label: "服务地域", placeholder: "ap-guangzhou", hint: "通常保持默认即可" },
  ],
};

/**
 * 2026-05-18 用户原话: "一定要选 3.0 吗? 能不能只保留接入渠道, 我自己添加模型?"
 *
 * `form.model_id` 早就是所有 provider 通用的"默认模型"输入 (SettingsPage line 856 "默认模型"
 * Field), 后端 fromPreset 时按 PROVIDER_META 写到对应 env (KLING_MODEL / VIDU_MODEL /
 * ALIYUN_WAN_MODEL / MINIMAX_VIDEO_MODEL / ZHIPU_VIDEO_MODEL / BAIDU_QIANFAN_VIDEO_MODEL /
 * TENCENT_HUNYUAN_VIDEO_MODEL / jimeng_* provider_meta.model). 但默认 placeholder 是
 * "gpt-4o / claude-opus-4.7 / ..." 让用户误以为只 LLM 用. 这里按 provider id 派生 hint/placeholder,
 * 让用户清楚"Kling 模型 id 这里填,留空走默认".
 *
 * 留空 = fallback 默认 (kling-v2-master / wan2.2-t2v-plus / 各家当时官方推荐版本);
 * 填了 = 用你填的 (随各家官方更新随时切, 不依赖项目升级).
 */
function modelFieldHintsFor(providerId: string | undefined): { placeholder: string; hint: string } {
  switch (providerId) {
    case "kling_3":
      return {
        placeholder: "kling-v3-i2v · 留空走默认 kling-v2-master",
        hint: "可填: kling-v1-6 / kling-v2-master / kling-v2-1-master / kling-v3-i2v / kling-v3-i2v-pro · 官方有新版直接换",
      };
    case "vidu_q3_ref":
      return { placeholder: "viduq3 / vidu-q3 · 留空走默认", hint: "Vidu 官方模型名" };
    case "aliyun_wan_t2v":
      return { placeholder: "wan2.2-t2v-plus · 留空走默认", hint: "阿里万相 DashScope 模型名" };
    case "minimax_hailuo":
      return { placeholder: "MiniMax-Hailuo-2.3 · 留空走默认", hint: "MiniMax 海螺视频模型名" };
    case "zhipu_cogvideox":
      return { placeholder: "cogvideox-2 · 留空走默认", hint: "智谱 CogVideoX 模型名" };
    case "baidu_qianfan_video":
      return { placeholder: "百度千帆视频模型名 · 留空走默认", hint: "千帆控制台部署的视频模型名" };
    case "tencent_hunyuan_video":
      return { placeholder: "hunyuan-video · 留空走默认", hint: "腾讯混元视频模型名" };
    case "jimeng_video_3pro":
    case "jimeng_video_3_720p":
      return { placeholder: "doubao-seedance-1.0-pro · 留空走默认", hint: "火山引擎控制台模型 API 名" };
    default:
      return { placeholder: "gpt-4o / claude-opus-4.7 / ...", hint: "" };
  }
}

function apiKeyLabelFor(providerId?: string): string {
  if (providerId === "tencent_hunyuan_video") return "访问密钥 ID";
  if (providerId === "jimeng_video_3pro" || providerId === "jimeng_video_3_720p" || providerId === "kling_3") return "API Key (可选)";
  return "API Key";
}

function uiKindToBackend(k: "text" | "image" | "video" | "tts"): ProviderKind {
  return k === "text" ? "llm" : k;
}

function slugify(s: string): string {
  return s.trim().toLowerCase()
    .replace(/[^a-z0-9_一-龥]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32) || `provider_${Date.now()}`;
}

export default function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const active: TabKey = TABS.some((tab) => tab.id === requestedTab) ? requestedTab as TabKey : "text";
  const setActive = (tab: TabKey) => setSearchParams((previous) => {
    const next = new URLSearchParams(previous);
    next.set("tab", tab);
    return next;
  });

  const { data: providers, mutate: refreshProviders, isLoading, error: providersError } = useSWR<UserProvidersGrouped>(
    "settings:providers-grouped",
    () => listUserProviders(),
    { revalidateOnFocus: false },
  );

  // SettingsPage 保存任意 provider 后调用这个: 触发本页 + 所有业务页 SWR 立即重新拉
  // P2 (2026-05-20): 用 invalidateProviders helper, 避免散落的 key 字符串
  async function refreshAllProviderViews() {
    await Promise.all([
      refreshProviders(),       // SettingsPage 本身 (key: "settings:providers-grouped")
      invalidateProviders(),    // 各业务页的 ModelPicker / Compose TTS 等
      refreshHealth(),
    ]);
  }

  const { data: lockData } = useSWR(
    active === "realvideo" ? "settings:real-video-lock" : null,
    () => getRealVideoLockStatus(),
    { refreshInterval: 5000, onError: () => { /* 静默 */ } },
  );

  // P1-10 (2026-05-31): 拉 provider health 数据用于 tab badge 计数
  const { data: healthData, mutate: refreshHealth } = useSWR<ProviderHealthResponse>(
    "settings:provider-health-all",
    () => getProviderHealth(),
    { revalidateOnFocus: false, onError: () => { /* 静默 */ } },
  );

  // 计算每个 tab 的 healthy/fail 数量 (P1-10 dot badge)
  const tabBadges = useMemo(() => {
    const badges: Record<string, { healthy: number; fail: number }> = {};
    if (!healthData?.providers) return badges;
    for (const p of healthData.providers) {
      const kind = p.kind ?? "llm";
      const tabKey = kind === "llm" ? "text" : kind;
      if (!badges[tabKey]) badges[tabKey] = { healthy: 0, fail: 0 };
      if (p.enabled === false) continue; // 跳过禁用的
      if (p.tested && p.healthy) badges[tabKey].healthy++;
      else if (p.tested && p.healthy === false) badges[tabKey].fail++;
    }
    return badges;
  }, [healthData]);

  const [editor, setEditor] = useState<EditorState | null>(null);

  return (
    <PageTransition>
      <div className="v24-settings-page" style={{ width: "100%", height: "100%", display: "flex", background: "var(--surface-canvas)" }}>
        {/* 左 sticky TOC */}
        <aside className="settings-navigation" style={{ width: 220, flexShrink: 0, background: "var(--surface-card)", borderRight: "1px solid var(--ink-100)", padding: "20px 12px", overflowY: "auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 10px 12px" }}>
            <Icon name="settings" size={14} style={{ color: "var(--brand-700)" }} />
            <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", color: "var(--ink-700)", textTransform: "uppercase" }}>设置</div>
          </div>
          {TABS.map((t) => {
            const on = active === t.id;
            const badge = tabBadges[t.id];
            return (
              <button type="button"
                aria-current={on ? "page" : undefined}
                key={t.id}
                onClick={() => setActive(t.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "8px 10px", borderRadius: 8, marginBottom: 2,
                  fontSize: 12.5, fontWeight: on ? 600 : 500,
                  color: on ? "var(--brand-700)" : "var(--ink-700)",
                  background: on ? "var(--brand-50)" : "transparent", cursor: "pointer",
                  border: "none", width: "100%", textAlign: "left", minHeight: 36,
                }}
              >
                <Icon name={t.icon} size={13} style={{ opacity: on ? 1 : 0.65 }} />
                <span style={{ flex: 1 }}>{t.label}</span>
                {/* P1-10: dot badge 显示 healthy/fail 数量 */}
                {badge && (badge.healthy > 0 || badge.fail > 0) && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, lineHeight: 1 }}>
                    {badge.healthy > 0 && (
                      <span style={{ color: "var(--ok)", fontWeight: 600 }} title={`${badge.healthy} 个健康`}>●{badge.healthy}</span>
                    )}
                    {badge.fail > 0 && (
                      <span style={{ color: "var(--err)", fontWeight: 600 }} title={`${badge.fail} 个失败`}>✕{badge.fail}</span>
                    )}
                  </span>
                )}
              </button>
            );
          })}

          <div style={{ marginTop: 24, padding: 12, borderRadius: 10, background: "var(--ok-bg)", border: "1px solid rgba(47,158,90,0.18)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
              <Icon name="lock" size={12} style={{ color: "var(--ok)" }} />
              <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--ok)", letterSpacing: "0.06em", textTransform: "uppercase" }}>仅本地</span>
            </div>
            <div style={{ fontSize: 11, color: "var(--ink-700)", lineHeight: 1.55 }}>
              所有 Key 存于 <code style={{ background: "rgba(0,0,0,0.05)", padding: "1px 4px", borderRadius: 3, fontSize: 10 }}>config/local-settings.json</code>
            </div>
          </div>
        </aside>

        {/* 主区 */}
        <div className="mk-scroll" style={{ flex: 1, overflow: "auto", padding: "28px 36px" }}>
          {providersError && (
            <div role="alert" className="mk-card" style={{ marginBottom: 20, padding: 18, borderColor: "var(--warn)", background: "var(--warn-bg)" }}>
              <div style={{ fontWeight: 600, color: "var(--ink-900)", marginBottom: 6 }}>暂时无法读取模型配置</div>
              <p style={{ fontSize: 12, color: "var(--ink-600)", margin: "0 0 12px", lineHeight: 1.6 }}>请确认本地服务已启动，再重新读取。现有配置仍会保留。</p>
              <Button variant="secondary" size="sm" iconLeft="refresh" onClick={() => void refreshAllProviderViews().catch((cause) => showErrorToast(cause))}>重新读取</Button>
            </div>
          )}
          {(active === "text" || active === "image" || active === "video" || active === "tts") && (
            <ProviderListSection
              key={active}
              uiKind={active}
              providers={providers ? providers[active] : []}
              loading={isLoading || (!!providersError && !providers)}
              onCreate={() => setEditor({ mode: "create", kind: uiKindToBackend(active) })}
              onEdit={(p) => setEditor({ mode: "edit", kind: uiKindToBackend(active), editingId: p.id, isBuiltin: !!p.is_builtin })}
              onRefresh={() => refreshAllProviderViews()}
            />
          )}
          {active === "realvideo" && <RealVideoLockSection lockData={lockData} />}
          {active === "chain" && <ChainSection providers={providers?.text ?? []} health={healthData} />}
          {active === "budget" && <BudgetSection />}
          {active === "usage" && <UsageSection />}
          {active === "about" && <AboutSection />}
        </div>

        {editor && (
          <ProviderEditorModal
            editor={editor}
            currentProvider={editor.mode === "edit" && providers
              ? findProvider(providers, editor.editingId!)
              : null}
            onClose={() => setEditor(null)}
            onSaved={async () => {
              setEditor(null);
              // 同时刷新本页 + 业务页面 SWR (解耦 SWR key 之间的耦合通知)
              await refreshAllProviderViews();
            }}
          />
        )}
      </div>
    </PageTransition>
  );
}

function findProvider(g: UserProvidersGrouped, id: string): UserProvider | null {
  for (const k of ["text", "image", "video", "tts"] as const) {
    const hit = g[k].find((p) => p.id === id);
    if (hit) return hit;
  }
  return null;
}

// ─── Provider 列表 section ─────────────────────────────────────────

function ProviderListSection(props: {
  uiKind: "text" | "image" | "video" | "tts";
  providers: UserProvider[];
  loading: boolean;
  onCreate: () => void;
  onEdit: (p: UserProvider) => void;
  onRefresh: () => void;
}) {
  const { uiKind, providers, loading, onCreate, onEdit, onRefresh } = props;
  const supportsLatency = uiKind === "text"; // 仅文字 kind 真请求测延迟
  const supportsCustomCreate = uiKind !== "video" && uiKind !== "tts";

  // P1-4 (2026-05-31): 一键全部测试
  const [testAllState, setTestAllState] = useState<"idle" | "testing" | "done">("idle");
  const [testAllResults, setTestAllResults] = useState<Map<string, "ok" | "fail">>(new Map());
  async function handleTestAll() {
    setTestAllState("testing");
    const results = new Map<string, "ok" | "fail">();
    // 并发测试所有可见 provider
    await Promise.allSettled(
      visibleProviders.filter((p) => p.enabled !== false).map(async (p) => {
        try {
          const r = supportsLatency
            ? await testProviderLatency(p.id)
            : await testUserProviderConnection(p.id, p.kind);
          results.set(p.id, r.ok ? "ok" : "fail");
        } catch {
          results.set(p.id, "fail");
        }
      }),
    );
    setTestAllResults(results);
    setTestAllState("done");
    onRefresh();
    const okCount = [...results.values()].filter((v) => v === "ok").length;
    const failCount = [...results.values()].filter((v) => v === "fail").length;
    if (failCount === 0) {
      toast.success(`全部 ${okCount} 个模型测试通过`);
    } else {
      toast.warning(`${okCount} 个通过, ${failCount} 个失败`);
    }
  }

  // 2026-07-09 audit C-settings: 去掉英文 "Provider" 后缀(与下方"模型"重复), 铁律 #9.
  const titleMap: Record<typeof uiKind, string> = {
    text: "文字模型",
    image: "图像模型",
    video: "视频模型",
    tts: "语音模型",
  };

  // 2026-05-17: video / tts 类型加二级 tab "本地模型 / 在线模型"
  // 本地 = id 以 local_ 开头 + windows_sapi + edge_tts (浏览器内置, 算"本地"无需 Key)
  // 在线 = 其他云端 API (jimeng / kling / minimax / aliyun / vidu / zhipu / mimo_tts / huoshan_tts / minimax_tts ...)
  type LocalOnlineTab = "local" | "online";
  const [videoTab, setVideoTab] = useState<LocalOnlineTab>("local");
  const isLocalProvider = (id: string) => {
    if (id.startsWith("local_")) return true;
    if (uiKind === "tts") {
      // edge_tts 走免费 Azure 公开端点, 无需 Key, 体验等同本地;
      // windows_sapi 系统内置, 算本地
      return id === "edge_tts" || id === "windows_sapi";
    }
    return false;
  };
  const localProviders = providers.filter((p) => isLocalProvider(p.id));
  const onlineProviders = providers.filter((p) => !isLocalProvider(p.id));
  const supportsLocalOnlineTab = uiKind === "video" || uiKind === "tts";
  const visibleProviders = supportsLocalOnlineTab
    ? (videoTab === "local" ? localProviders : onlineProviders)
    : providers;
  const configuredCount = providers.filter((p) => p.enabled !== false && (p.provider_status?.configured ?? !!p.api_key)).length;
  const verifiedCount = providers.filter((p) => p.enabled !== false && p.provider_status?.tested && p.provider_status.healthy).length;
  const setupHint = {
    text: "先连接你自己的文字模型，用于灵感扩写、剧本讨论和拆分镜。也可以直接手写或粘贴剧本开始创作。",
    image: "选择适合画风的图像模型。角色和场景参考图会随生成请求一起审核，也可以直接导入已有图片。",
    video: "在线模型需要填写你自己的服务凭据。本地模型按实际安装环境运行；已有视频也可以直接导入分镜。",
    tts: "为作品选择配音服务和音色。无需配音时，可在合成页选择保留原声或只生成字幕。",
  }[uiKind];

  return (
    <section>
      <div style={{ marginBottom: 24, display: "flex", alignItems: "flex-end", flexWrap: "wrap", gap: 16 }}>
        <div style={{ flex: "1 1 320px", minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", color: "var(--brand-700)", textTransform: "uppercase", marginBottom: 4 }}>
            设置 · {titleMap[uiKind]}
          </div>
          <h2 style={{ margin: 0, fontFamily: "'Noto Serif SC', serif", fontSize: 24, fontWeight: 600, color: "var(--ink-900)" }}>{titleMap[uiKind]}</h2>
          <p style={{ fontSize: 12.5, color: "var(--ink-600)", marginTop: 4, maxWidth: 760, lineHeight: 1.6 }}>
            支持任意多个模型实例。每个生成步骤会用调用处选定的模型；未指定时回退到此处启用的实例。
          </p>
        </div>
        {/* 2026-05-17 UX 修: 视频 provider 不支持自定义新增, 不显示按钮(改用下方横幅说明) */}
        {/* P1-4 (2026-05-31): 一键全部测试按钮 */}
        <Button
          variant="secondary"
          size="sm"
          iconLeft="gauge"
          onClick={handleTestAll}
          disabled={testAllState === "testing" || !visibleProviders.some((p) => p.enabled !== false)}
          loading={testAllState === "testing"}
          title="测试当前分类中已启用的模型；文字模型测速会向服务发送少量请求"
        >
          {testAllState === "testing" ? "测试中…" : "测试已启用模型"}
        </Button>
        {supportsCustomCreate ? (
          <Button
            variant="primary"
            size="sm"
            iconLeft="plus"
            onClick={onCreate}
            title="新增自定义模型"
          >
            新增模型
          </Button>
        ) : (
          <div style={{
            fontSize: 11.5, color: "var(--ink-500)", lineHeight: 1.5,
            padding: "8px 12px", borderRadius: 8,
            background: "var(--ink-50)", border: "1px solid var(--ink-100)",
            maxWidth: 280,
          }}>
            <Icon name="info" size={11} style={{ marginRight: 4, color: "var(--ink-400)" }} />
            {uiKind === "tts"
              ? "选择下方语音服务，按需填写自己的凭据。本地模型需先完成对应运行环境安装。"
              : "视频模型用内置即可。下方列表里的模型直接填 Key 启用,无需手动添加。"}
          </div>
        )}
      </div>

      {!loading && (
        <div className="mk-card" style={{ marginBottom: 20, padding: "16px 18px", background: "var(--surface-card)", display: "flex", alignItems: "flex-start", gap: 12 }}>
          <Icon name="settings" size={18} style={{ color: "var(--brand-600)", marginTop: 2, flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-900)", marginBottom: 5 }}>{configuredCount > 0 ? `${configuredCount} 个模型已配置并启用` : `从连接${titleMap[uiKind]}开始`}</div>
            <div style={{ fontSize: 12, color: "var(--ink-600)", lineHeight: 1.7 }}>{setupHint}</div>
            <div style={{ fontSize: 11, color: "var(--ink-500)", marginTop: 6 }}>{verifiedCount > 0 ? `${verifiedCount} 个模型有测试通过的记录。` : "尚无测试通过的记录。"}配置完成后可按需测试；文字模型测速会向所选服务发送少量请求。</div>
          </div>
        </div>
      )}

      {uiKind === "image" && <ChatgptOauthCard />}

      {/* 2026-05-27 — 大陆视频 API 单价对照表, 用户原话"方便我以后对照".
          固定显示在视频 tab 顶部 (在线 + 本地都看得到), 折叠状态记 localStorage. */}
      {uiKind === "video" && <VideoProviderPriceTable />}

      {/* 2026-05-17: video / tts 二级 tab — 本地模型 vs 在线模型 */}
      {supportsLocalOnlineTab && (
        <div style={{
          display: "flex", gap: 4, marginBottom: 16,
          padding: 4, borderRadius: 10,
          background: "var(--ink-50)", border: "1px solid var(--ink-100)",
          width: "fit-content",
        }}>
          <button
            type="button"
            onClick={() => setVideoTab("local")}
            className="mk-btn mk-btn--sm"
            style={{
              padding: "6px 14px",
              borderRadius: 6,
              background: videoTab === "local" ? "var(--brand-50)" : "transparent",
              color: videoTab === "local" ? "var(--brand-700)" : "var(--ink-600)",
              border: videoTab === "local" ? "1px solid var(--brand-200)" : "1px solid transparent",
              fontWeight: videoTab === "local" ? 600 : 500,
              cursor: "pointer",
            }}
            title={uiKind === "tts"
              ? "本地 GPU TTS / Edge TTS / Windows SAPI (无需 Key)"
              : "本地 GPU / Mock 视频模型 (无需 Key, 占用本机资源)"}
          >
            <Icon name="cpu" size={11} style={{ marginRight: 6 }} />
            本地模型
            <span style={{
              marginLeft: 8, padding: "1px 6px", borderRadius: 8,
              background: "var(--ink-100)", color: "var(--ink-600)",
              fontSize: 10, fontWeight: 500,
            }}>{localProviders.length}</span>
          </button>
          <button
            type="button"
            onClick={() => setVideoTab("online")}
            className="mk-btn mk-btn--sm"
            style={{
              padding: "6px 14px",
              borderRadius: 6,
              background: videoTab === "online" ? "var(--brand-50)" : "transparent",
              color: videoTab === "online" ? "var(--brand-700)" : "var(--ink-600)",
              border: videoTab === "online" ? "1px solid var(--brand-200)" : "1px solid transparent",
              fontWeight: videoTab === "online" ? 600 : 500,
              cursor: "pointer",
            }}
            title={uiKind === "tts"
              ? "云端在线 TTS API (MiniMax / MiMo / 火山 / 讯飞等, 需配 Key)"
              : "云端在线视频 API (需配 Key + 按调用计费)"}
          >
            <Icon name="globe" size={11} style={{ marginRight: 6 }} />
            在线模型
            <span style={{
              marginLeft: 8, padding: "1px 6px", borderRadius: 8,
              background: "var(--ink-100)", color: "var(--ink-600)",
              fontSize: 10, fontWeight: 500,
            }}>{onlineProviders.length}</span>
          </button>
        </div>
      )}

      {loading && (
        <div className="mk-card" style={{ padding: 20, textAlign: "center", color: "var(--ink-400)" }}>加载中…</div>
      )}

      {/* 2026-05-18: 5 真实视频渠道二级架构 — 用户自填模型 (Kling/Vidu/Jimeng/MiniMax/Aliyun).
          2026-05-27 挪到 tab 切换条之后, 视觉顺序自然: 价格表 → tab 切换 → 内容区. */}
      {uiKind === "video" && videoTab === "online" && (
        <VideoInstancesSection onChanged={onRefresh} />
      )}

      {/* 2026-05-27 — 视频 tab 在线模式由 VideoInstancesSection 接管 (二级架构: 渠道+实例),
          这里跳过老的 ProviderCard 列表 + 空状态 (避免双份在线视频模型 UI).
          本地模式仍用 ProviderCard (因为本地 local_* provider 没有"多实例"概念). */}
      {!(uiKind === "video" && videoTab === "online") && (
        <>
          {!loading && visibleProviders.length === 0 && (
            <div className="mk-card" style={{ padding: 32, textAlign: "center", color: "var(--ink-500)", fontSize: 13 }}>
              <Icon name="bolt" size={28} style={{ color: "var(--ink-300)", marginBottom: 12 }} />
              <div>
                {supportsLocalOnlineTab
                  ? (videoTab === "local"
                      ? (uiKind === "tts" ? "暂无本地语音模型" : "暂无本地视频模型")
                      : (uiKind === "tts" ? "暂无在线语音模型" : "暂无在线视频模型"))
                  : `暂无 ${titleMap[uiKind]}`}
              </div>
              {supportsCustomCreate ? (
                <Button variant="secondary" size="sm" iconLeft="plus" style={{ marginTop: 12 }} onClick={onCreate}>
                  新增第一个
                </Button>
              ) : null}
            </div>
          )}

          {!loading && visibleProviders.map((p) => (
            <ProviderCard
              key={p.id}
              provider={p}
              supportsLatency={supportsLatency}
              onEdit={() => onEdit(p)}
              onDeleted={onRefresh}
              testAllResult={testAllResults.get(p.id)}
            />
          ))}
        </>
      )}
    </section>
  );
}

// ─── 单张 Provider 卡片 ────────────────────────────────────────────

function ProviderCard(props: {
  provider: UserProvider;
  supportsLatency: boolean;
  onEdit: () => void;
  onDeleted: () => void;
  /** P1-4: 一键全部测试结果 (可选) */
  testAllResult?: "ok" | "fail";
}) {
  const { provider: p, supportsLatency, onEdit, onDeleted, testAllResult } = props;
  const confirm = useConfirm();
  const [latencyState, setLatencyState] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [latencyErr, setLatencyErr] = useState<string | null>(null);

  // P1-3: "试一下" 状态
  const [tryState, setTryState] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [tryResult, setTryResult] = useState<string | null>(null);
  const [tryAudioUrl, setTryAudioUrl] = useState<string | null>(null);

  const keyPresent = p.provider_status?.configured ?? !!p.api_key;
  const status = p.provider_status;

  async function handleTestLatency() {
    setLatencyState("testing");
    setLatencyErr(null);
    try {
      const r = supportsLatency
        ? await testProviderLatency(p.id)
        : await testUserProviderConnection(p.id, p.kind);
      if (r.ok) {
        setLatencyMs(supportsLatency ? (r.latency_ms ?? null) : null);
        setLatencyState("ok");
        toast.success(supportsLatency ? `${p.label_zh} 测速完成: ${r.latency_ms}ms` : `${p.label_zh} 连接检查通过`);
      } else {
        setLatencyState("fail");
        setLatencyErr(r.error || "测试失败");
        showErrorToast(r.error || "测试失败", "测速失败");
      }
    } catch (err) {
      setLatencyState("fail");
      showErrorToast(err, "测速失败");
    }
  }

  const deleteAction = useAsyncAction(
    async () => {
      await deleteUserProvider(p.id);
    },
    {
      errorMessage: "删除失败",
      onSuccess: () => {
        toast.success(`已删除 ${p.label_zh}`);
        onDeleted();
      },
    },
  );
  const deleting = deleteAction.busy;

  async function handleDelete() {
    if (p.is_builtin) {
      toast.error("内置模型不可删除");
      return;
    }
    const ok = await confirm({
      title: `删除模型「${p.label_zh}」?`,
      description: "此操作不可撤销 — 该模型将从可用列表移除。",
      variant: "destructive",
      confirmLabel: "删除",
    });
    if (!ok) return;
    await deleteAction.run();
  }

  // P1-3: "试一下" — LLM 发一句固定提示词收回复 / TTS 试听 / Video mock 5s
  async function handleTry() {
    setTryState("testing");
    setTryResult(null);
    setTryAudioUrl(null);
    try {
      if (p.kind === "llm") {
        const r = await tryProviderLlm(p.id);
        if (!r.ok) throw new Error(r.error || "测试失败");
        setTryResult(r.reply || "(空回复)");
        setTryState("ok");
      } else if (p.kind === "tts") {
        // TTS 试听: 用默认文本合成一段音频播放
        const blob = await testTtsVoice({ voice_id: "default", text: "你好，这是语音试听样本。", provider_id: p.id });
        const url = URL.createObjectURL(blob);
        setTryAudioUrl(url);
        const audio = new Audio(url);
        audio.onended = () => { /* 播放完毕保持状态 */ };
        audio.play().catch(() => {});
        setTryState("ok");
      } else if (p.kind === "video") {
        // Video mock 5s: 琥珀色 + 二次确认
        const ok = await confirm({
          title: "试一下视频生成?",
          description: `将使用「${p.label_zh}」生成一个 5 秒测试视频。如果该模型按调用计费, 可能产生少量费用。`,
          variant: "warning",
          confirmLabel: "确认试一下",
        });
        if (!ok) { setTryState("idle"); return; }
        // 发一次 mock 5s 请求
        const r = await apiPost<{ ok: boolean; message?: string; error?: string }>(
          `/api/v2/providers/${p.id}/test`,
        );
        if (r.ok) {
          setTryResult(r.message || "连接检查通过");
          setTryState("ok");
        } else {
          throw new Error(r.error || r.message || "测试失败");
        }
      } else {
        // image / 其他: 走 ping
        const r = await testUserProviderConnection(p.id, p.kind);
        if (r.ok) {
          setTryResult("连接正常");
          setTryState("ok");
        } else {
          throw new Error(r.error || "测试失败");
        }
      }
    } catch (err) {
      setTryState("fail");
      setTryResult(err instanceof Error ? err.message : "测试失败");
      showErrorToast(err, "试一下失败");
    }
  }

  return (
    <div className="mk-card settings-provider-card" data-model-id={p.id} style={{ marginBottom: 12, padding: 18, minWidth: 0 }}>
      {/* 顶部: label + pill + builtin 标记 */}
      <div className="settings-provider-heading" style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 8 }}>
        <div className="settings-provider-title" style={{ fontSize: 15, fontWeight: 600, color: "var(--ink-900)", fontFamily: "'Noto Serif SC', serif", minWidth: 0, overflowWrap: "anywhere" }}>{p.label_zh}</div>
        <span className="mk-pill" style={{ background: "var(--ink-50)", color: "var(--ink-600)", height: 20, fontSize: 10.5 }}>
          {KIND_LABEL[p.kind]} · {API_TYPE_LABEL[p.api_type]}
        </span>
        {p.is_builtin && (
          <span className="mk-pill" style={{ background: "var(--brand-50)", color: "var(--brand-700)", height: 20, fontSize: 10.5 }}>内置</span>
        )}
        <span style={{ flex: 1 }} />
        {keyPresent ? (
          <span className="mk-pill mk-pill--picked" style={{ height: 20, fontSize: 10.5 }}>已配置</span>
        ) : (
          <span className="mk-pill mk-pill--draft" style={{ height: 20, fontSize: 10.5 }}>待配置</span>
        )}
        {p.enabled !== false ? (
          <span className="mk-pill mk-pill--ready" style={{ height: 20, fontSize: 10.5 }}>启用</span>
        ) : (
          <span className="mk-pill mk-pill--draft" style={{ height: 20, fontSize: 10.5 }}>禁用</span>
        )}
      </div>

      {/* 中部: base_url + masked api_key + model */}
      <div style={{ fontSize: 11.5, color: "var(--ink-500)", marginBottom: 2, fontFamily: "ui-monospace, Consolas, monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {p.base_url || <span style={{ color: "var(--ink-400)" }}>使用此模型内置的连接方式</span>}
      </div>
      {/* P1-1 (2026-05-31): 显示 masked api_key, 用户一眼知道当前用的是哪个 key */}
      {p.api_key && (
        <div style={{ fontSize: 11, color: "var(--ink-400)", marginBottom: 4, fontFamily: "ui-monospace, Consolas, monospace" }}>
          Key: <span style={{ color: "var(--ink-600)" }}>{p.api_key}</span>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        {p.model_id ? (
          <span className="mk-pill" style={{ background: "var(--ink-50)", color: "var(--ink-700)", height: 20, fontSize: 10.5 }}>
            <Icon name="cpu" size={10} />{p.model_id}
          </span>
        ) : (
          <span style={{ fontSize: 11, color: "var(--ink-400)" }}>未指定默认模型</span>
        )}
        {status?.reason && (
          <span style={{ fontSize: 11, color: "var(--ink-500)" }}>· {status.reason}</span>
        )}
      </div>

      {/* 底部按钮组 */}
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <Button variant="secondary" size="sm" iconLeft="edit" onClick={onEdit}>
          {p.is_builtin ? "查看 · 微调" : "编辑"}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          iconLeft="gauge"
          onClick={handleTestLatency}
          disabled={latencyState === "testing"}
          loading={latencyState === "testing"}
          title={supportsLatency ? "对 chat/completions 发 max_tokens=1 的请求测 p50 延迟" : "检查该模型的配置是否可用"}
        >
          {latencyState === "testing" ? "测试中…" : supportsLatency ? "测延迟" : "测试连接"}
        </Button>
        {latencyState === "ok" && latencyMs !== null && (
          <span className="mk-pill mk-pill--picked" style={{ height: 22, fontSize: 11 }}>{latencyMs} ms</span>
        )}
        {latencyState === "fail" && (
          <span className="mk-pill mk-pill--failed" style={{ height: 22, fontSize: 11 }} title={latencyErr || ""}>测试失败</span>
        )}
        {/* P1-4: 一键全部测试结果 indicator */}
        {testAllResult === "ok" && latencyState === "idle" && (
          <span className="mk-pill mk-pill--picked" style={{ height: 22, fontSize: 11 }}>测试通过</span>
        )}
        {testAllResult === "fail" && latencyState === "idle" && (
          <span className="mk-pill mk-pill--failed" style={{ height: 22, fontSize: 11 }}>测试失败</span>
        )}
        {/* P1-3: "试一下" 按钮 */}
        {keyPresent && (
          <Button
            variant="secondary"
            size="sm"
            iconLeft="play"
            onClick={handleTry}
            disabled={tryState === "testing"}
            loading={tryState === "testing"}
            title={
              p.kind === "llm"
                ? "发一句固定提示词, 看模型回复"
                : p.kind === "tts"
                  ? "试听一段语音合成"
                  : p.kind === "video"
                    ? "测试视频生成连接"
                    : "测试连接"
            }
          >
            {tryState === "testing" ? "测试中…" : "试一下"}
          </Button>
        )}
        <span style={{ flex: 1 }} />
        {/* W8-sweep (2026-05-16): icon-only → icon + 文字 (铁律 #11) */}
        {!p.is_builtin && (
          <Button
            variant="danger"
            size="sm"
            iconLeft="trash"
            onClick={handleDelete}
            disabled={deleting}
            loading={deleting}
            title="删除此模型"
          >
            删除
          </Button>
        )}
      </div>

      {/* P1-3: "试一下" 结果展示区 */}
      {tryState === "ok" && tryResult && p.kind === "llm" && (
        <div style={{
          marginTop: 10, padding: "10px 12px", borderRadius: 8,
          background: "var(--ok-bg)", border: "1px solid rgba(47,158,90,0.18)",
          fontSize: 12, color: "var(--ink-700)", lineHeight: 1.6,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4, fontSize: 10.5, fontWeight: 600, color: "var(--ok)" }}>
            <Icon name="check" size={11} /> 模型回复
          </div>
          <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{tryResult}</div>
        </div>
      )}
      {tryState === "ok" && p.kind === "tts" && tryAudioUrl && (
        <div style={{
          marginTop: 10, padding: "10px 12px", borderRadius: 8,
          background: "var(--ok-bg)", border: "1px solid rgba(47,158,90,0.18)",
          fontSize: 12, color: "var(--ok)", display: "flex", alignItems: "center", gap: 6,
        }}>
          <Icon name="check" size={11} /> 语音试听已播放
        </div>
      )}
      {tryState === "ok" && tryResult && p.kind !== "llm" && p.kind !== "tts" && (
        <div style={{
          marginTop: 10, padding: "10px 12px", borderRadius: 8,
          background: "var(--ok-bg)", border: "1px solid rgba(47,158,90,0.18)",
          fontSize: 12, color: "var(--ok)", display: "flex", alignItems: "center", gap: 6,
        }}>
          <Icon name="check" size={11} /> {tryResult}
        </div>
      )}
      {tryState === "fail" && tryResult && (
        <div style={{
          marginTop: 10, padding: "10px 12px", borderRadius: 8,
          background: "var(--err-bg, #fef2f2)", border: "1px solid rgba(220,38,38,0.15)",
          fontSize: 12, color: "var(--err)", display: "flex", alignItems: "flex-start", gap: 6,
        }}>
          <Icon name="x" size={11} style={{ marginTop: 2, flexShrink: 0 }} />
          <span style={{ wordBreak: "break-word" }}>{tryResult}</span>
        </div>
      )}
    </div>
  );
}

// ─── 新增/编辑 模态弹窗 ────────────────────────────────────────────

function ProviderEditorModal(props: {
  editor: EditorState;
  currentProvider: UserProvider | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { editor, currentProvider, onClose, onSaved } = props;
  const isEdit = editor.mode === "edit";
  const isBuiltin = !!editor.isBuiltin;

  // 初始化 form
  const allowedApiTypes = API_TYPES_BY_KIND[editor.kind];
  const [form, setForm] = useState<FormState>(() => {
    if (isEdit && currentProvider) {
      return {
        id: currentProvider.id,
        label_zh: currentProvider.label_zh,
        api_type: currentProvider.api_type,
        base_url: currentProvider.base_url || "",
        api_key: "", // 编辑时不回显, 留空 = 保留原 Key
        model_id: currentProvider.model_id || "",
        custom_headers: currentProvider.custom_headers || {},
        anthropic_version: currentProvider.anthropic_version || "",
        notes: currentProvider.notes || "",
        enabled: currentProvider.enabled !== false,
      };
    }
    return emptyForm(allowedApiTypes[0]);
  });

  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const extraFields = isEdit ? BUILTIN_EXTRA_FIELDS[editor.editingId ?? ""] ?? [] : [];
  // 2026-07-22 Y6 UP-12: Key 输入框旁"显示/隐藏"切换 (默认隐藏), 对齐 X4 波
  // AddVideoModelModal.tsx 的写法 (图标 + 文字, 铁律 #11). 只加显隐, 不改 Key 存储/安全模型 —
  // 列表页仍打码不变 (C-7).
  const [showApiKey, setShowApiKey] = useState(false);
  // extraFields 里可能有多个 secret 字段 (如 access_key + secret_key), 各自独立显隐 — 按 field.key 记.
  const [showExtraField, setShowExtraField] = useState<Record<string, boolean>>({});

  // P1-2 (2026-05-31): Modal 内 inline "测试" 按钮状态
  const [inlineTestState, setInlineTestState] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [inlineTestMsg, setInlineTestMsg] = useState<string | null>(null);
  const inlineTestAction = useAsyncAction(
    async () => {
      if (!isEdit || !editor.editingId) throw new Error("请先保存后再测试");
      const kind = editor.kind;
      const r = kind === "llm"
        ? await testProviderLatency(editor.editingId)
        : await testUserProviderConnection(editor.editingId, kind);
      if (!r.ok) throw new Error(r.error || "测试失败");
      return r;
    },
    {
      errorMessage: "连接测试失败",
      onSuccess: (r) => {
        setInlineTestState("ok");
        setInlineTestMsg(r.latency_ms ? `${r.latency_ms}ms` : "连接正常");
      },
      onError: (err) => {
        setInlineTestState("fail");
        setInlineTestMsg(err instanceof Error ? err.message : "测试失败");
      },
    },
  );
  async function handleInlineTest() {
    setInlineTestState("testing");
    setInlineTestMsg(null);
    await inlineTestAction.run();
  }

  // 当 label_zh 改变且是 create 模式: 自动建议 id
  useEffect(() => {
    if (!isEdit && form.label_zh) {
      setForm((f) => ({ ...f, id: slugify(f.label_zh) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.label_zh]);

  // useAsyncAction 接管 fetch-models busy + 错误 toast
  const fetchModelsAction = useAsyncAction(
    async () => getKnownModels(editor.editingId!),
    {
      errorMessage: "拉取模型失败",
      onSuccess: (r) => {
        setModelOptions(r.models);
        if (r.models.length === 0) toast.info("未拉到任何模型");
        else toast.success(`拉到 ${r.models.length} 个模型, 在下拉里选`);
      },
    },
  );
  const fetchingModels = fetchModelsAction.busy;
  async function handleFetchModels() {
    if (!isEdit) {
      toast.info("请先保存, 再来一键拉模型");
      return;
    }
    await fetchModelsAction.run();
  }

  // useAsyncAction 接管 save busy + 错误 toast
  const saveAction = useAsyncAction(
    async () => {
      if (isEdit) {
        // 内置 provider 也允许改 base_url / model_id / api_key / enabled / notes / label
        // 后端 buildBuiltinSettingsPatch 会把它们映射到对应 ENV (IKUNCODE_LLM_BASE_URL 等).
        // api_type 不能改 (内置 kind 锁死).
        const patch = buildProviderUpdate(form, Boolean(isBuiltin));
        await updateUserProvider(editor.editingId!, patch);
        return { mode: "edit" as const, label: form.label_zh };
      } else {
        const input: CreateProviderInput = {
          id: form.id,
          label_zh: form.label_zh,
          kind: editor.kind,
          api_type: form.api_type,
          base_url: form.base_url.trim(),
          api_key: form.api_key,
          model_id: form.model_id || undefined,
          custom_headers: form.custom_headers,
          anthropic_version: form.api_type === "anthropic" ? (form.anthropic_version || "2023-06-01") : undefined,
          notes: form.notes || undefined,
          enabled: form.enabled,
        };
        await createUserProvider(input);
        return { mode: "create" as const, label: form.label_zh };
      }
    },
    {
      errorMessage: "保存失败",
      onSuccess: (result) => {
        toast.success(result.mode === "edit" ? `已更新 ${result.label}` : `已新增 ${result.label}`);
        onSaved();
      },
    },
  );
  const saving = saveAction.busy;

  async function handleSave() {
    if (!form.label_zh.trim()) {
      toast.error("请填写 label (显示名)");
      return;
    }
    if (!isEdit && !form.id.trim()) {
      toast.error("请填写 id");
      return;
    }
    if (!isEdit && !form.base_url.trim()) {
      toast.error("base_url 不能为空");
      return;
    }
    await saveAction.run();
  }

  const headerTitle = isEdit
    ? (isBuiltin ? `查看 · 微调 · ${currentProvider?.label_zh ?? ""}` : `编辑 · ${currentProvider?.label_zh ?? ""}`)
    : `新增${KIND_LABEL[editor.kind]}模型`;

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", zIndex: 60,
        display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
      }}
      onClick={onClose}
    >
      <div
        className="mk-card"
        style={{ width: 560, maxHeight: "90vh", display: "flex", flexDirection: "column", padding: 0, background: "var(--surface-card)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--ink-100)", display: "flex", alignItems: "center", gap: 10 }}>
          <Icon name={isEdit ? "edit" : "plus"} size={16} style={{ color: "var(--brand-700)" }} />
          <div style={{ flex: 1, fontSize: 14, fontWeight: 600, color: "var(--ink-900)", fontFamily: "'Noto Serif SC', serif" }}>{headerTitle}</div>
          {/* W8-sweep (2026-05-16): icon-only → icon + 文字 (铁律 #11) */}
          <Button variant="ghost" size="sm" iconLeft="close" onClick={onClose} title="关闭编辑窗">
            关闭
          </Button>
        </div>

        {/* body */}
        <div className="mk-scroll" style={{ flex: 1, overflowY: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
          {isBuiltin && (
            <div style={{ padding: 10, borderRadius: 8, background: "var(--brand-50)", color: "var(--brand-700)", fontSize: 11.5, display: "flex", alignItems: "center", gap: 6 }}>
              <Icon name="info" size={12} />内置模型 · API 类型锁死 (按厂商协议固定); base_url / Key / 默认模型 / 备注 / 启用状态 均可改
            </div>
          )}

          {/* label_zh */}
          <Field label="显示名 (label)" required>
            <Input
              value={form.label_zh}
              maxLength={40}
              autoFocus={!isEdit}
              onChange={(e) => setForm((f) => ({ ...f, label_zh: e.target.value }))}
              placeholder="例如 我的 MiMo Pro"
            />
          </Field>

          {/* id (仅 create) */}
          {!isEdit && (
            <Field label="ID (slug)" required hint="后端用于持久化, 不可重复. 由 label 自动生成, 可手改.">
              <Input
                value={form.id}
                maxLength={32}
                onChange={(e) => setForm((f) => ({ ...f, id: slugify(e.target.value) }))}
                placeholder="my_mimo_pro"
                className="font-mono"
              />
            </Field>
          )}

          {/* api_type — 所有 LLM provider (含 builtin) 都可下拉切换.
              切换只改前端 form, 不调后端. base_url/model_id 从 api_type_variants 读对应那套填入.
              点击保存按钮时才一次性 PATCH 后端. */}
          <Field label="API 类型" required hint={editor.kind === "llm" && isBuiltin ? "切换后 base_url / 默认模型会显示该 API 类型已存的配置, 保存按钮点击后才统一写入" : undefined}>
            <Select
              value={form.api_type}
              onChange={(v) => {
                const newType = v as ApiType;
                // builtin LLM: 从 api_type_variants 读另一套字段填表 (前端纯切, 不调后端)
                const variants = currentProvider?.api_type_variants;
                const target = variants && (newType === "anthropic" ? variants.anthropic : newType === "openai_compat" ? variants.openai_compat : undefined);
                setForm((f) => ({
                  ...f,
                  api_type: newType,
                  base_url: target ? (target.base_url || "") : f.base_url,
                  model_id: target ? (target.model_id || "") : f.model_id,
                  api_key: "", // 切换时清空 (编辑模式 api_key 永不回显, 留空 = 保留原值)
                  anthropic_version: newType === "anthropic" && !f.anthropic_version ? "2023-06-01" : f.anthropic_version,
                }));
              }}
              options={allowedApiTypes.map((t) => ({ value: t, label: API_TYPE_LABEL[t] }))}
              ariaLabel="API 协议类型"
              className="w-full"
            />
          </Field>

          {/* base_url — 所有远端 provider 都可改; 本地/mock 可留空 */}
          <Field label="Base URL" required={!isEdit} hint={editor.kind === "llm" && isBuiltin ? "该 API 类型独立存储, 切回另一种类型时不会丢" : undefined}>
            <Input
              value={form.base_url}
              onChange={(e) => setForm((f) => ({ ...f, base_url: e.target.value }))}
              placeholder={form.api_type === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"}
              className="font-mono text-[12px]"
            />
          </Field>

          {/* api_key + P1-2 inline "测试" 按钮 */}
          <Field
            label={apiKeyLabelFor(editor.editingId)}
            hint={isEdit ? "留空 = 保留当前 Key. 填写新值会替换." : "粘贴该模型的 API Key. 仅本地保存."}
          >
            <div style={{ display: "flex", gap: 8 }}>
              {/* 2026-07-22 Y6 UP-12: "显示/隐藏"切换 — 图标 + 文字(铁律 #11 禁 icon-only), 默认隐藏.
                  对齐 AddVideoModelModal.tsx(X4 波) 的写法: position:relative 包一层 + 绝对定位按钮 +
                  输入框右侧留 padding 防遮挡. 只加显隐, 不改 Key 存储/安全模型 — 列表页仍打码不变. */}
              <div style={{ position: "relative", flex: 1 }}>
                <Input
                  type={showApiKey ? "text" : "password"}
                  value={form.api_key}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setForm((f) => ({ ...f, api_key: e.target.value }))}
                  placeholder={isEdit ? "(保持不变)" : "sk-..."}
                  className="w-full font-mono text-[12px] pr-16"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey((s) => !s)}
                  aria-label={showApiKey ? "隐藏 Key" : "显示 Key"}
                  title={showApiKey ? "隐藏" : "显示"}
                  style={{
                    position: "absolute",
                    right: 6,
                    top: 6,
                    height: 22,
                    padding: "0 6px",
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    color: "var(--ink-500)",
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    fontSize: 11,
                    whiteSpace: "nowrap",
                  }}
                >
                  <Icon name="eye" size={14} style={{ opacity: showApiKey ? 1 : 0.45 }} />
                  <span>{showApiKey ? "隐藏" : "显示"}</span>
                </button>
              </div>
              {isEdit && (
                <Button
                  variant="secondary"
                  size="sm"
                  iconLeft="gauge"
                  onClick={handleInlineTest}
                  disabled={inlineTestState === "testing" || inlineTestAction.busy}
                  loading={inlineTestState === "testing" || inlineTestAction.busy}
                  title={editor.kind === "llm" ? "用当前保存的 Key 测速 (chat/completions)" : "用当前保存的 Key 测试连接"}
                >
                  {inlineTestState === "testing" ? "测试中…" : "测试"}
                </Button>
              )}
            </div>
            {/* 测试结果反馈 */}
            {inlineTestState === "ok" && (
              <div style={{ marginTop: 6, fontSize: 11, color: "var(--ok)", display: "flex", alignItems: "center", gap: 4 }}>
                <Icon name="check" size={12} /> 连接正常{inlineTestMsg ? ` · ${inlineTestMsg}` : ""}
              </div>
            )}
            {inlineTestState === "fail" && (
              <div style={{ marginTop: 6, fontSize: 11, color: "var(--err)", display: "flex", alignItems: "center", gap: 4 }}>
                <Icon name="x" size={12} /> {inlineTestMsg || "测试失败"}
              </div>
            )}
            {!isEdit && (
              <div style={{ marginTop: 6, fontSize: 10.5, color: "var(--ink-400)" }}>
                新增模式下请先保存, 再从卡片上测试连接
              </div>
            )}
          </Field>

          {extraFields.map((field) => {
            // 2026-07-22 Y6 UP-12: 同 api_key — secret 字段(access_key/secret_key 等)也给"显示/隐藏".
            const revealed = !!showExtraField[field.key];
            return (
              <Field key={field.key} label={field.label} hint={field.hint ?? (field.secret ? "留空 = 保留当前值" : undefined)}>
                {field.secret ? (
                  <div style={{ position: "relative" }}>
                    <Input
                      type={revealed ? "text" : "password"}
                      value={form.custom_headers[field.key] || ""}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(e) => setForm((f) => ({
                        ...f,
                        custom_headers: { ...f.custom_headers, [field.key]: e.target.value },
                      }))}
                      placeholder={field.placeholder}
                      className="w-full font-mono text-[12px] pr-16"
                    />
                    <button
                      type="button"
                      onClick={() => setShowExtraField((s) => ({ ...s, [field.key]: !s[field.key] }))}
                      aria-label={revealed ? "隐藏" : "显示"}
                      title={revealed ? "隐藏" : "显示"}
                      style={{
                        position: "absolute",
                        right: 6,
                        top: 6,
                        height: 22,
                        padding: "0 6px",
                        border: "none",
                        background: "transparent",
                        cursor: "pointer",
                        color: "var(--ink-500)",
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                        fontSize: 11,
                        whiteSpace: "nowrap",
                      }}
                    >
                      <Icon name="eye" size={14} style={{ opacity: revealed ? 1 : 0.45 }} />
                      <span>{revealed ? "隐藏" : "显示"}</span>
                    </button>
                  </div>
                ) : (
                  <Input
                    type="text"
                    value={form.custom_headers[field.key] || ""}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => setForm((f) => ({
                      ...f,
                      custom_headers: { ...f.custom_headers, [field.key]: e.target.value },
                    }))}
                    placeholder={field.placeholder}
                    className="font-mono text-[12px]"
                  />
                )}
              </Field>
            );
          })}

          {/* model_id + 拉模型 — 2026-05-18 按 provider 动态 placeholder/hint */}
          {(() => {
            const mh = modelFieldHintsFor(editor.editingId);
            const composedHint = [mh.hint, "单击 [拉取] 获取该模型来源提供的模型列表 (仅 edit 模式)"]
              .filter(Boolean)
              .join(" · ");
            return (
          <Field label="默认模型" hint={composedHint || "单击 [拉取] 获取该模型来源提供的模型列表 (仅 edit 模式)"}>
            <div style={{ display: "flex", gap: 8 }}>
              <Input
                value={form.model_id}
                onChange={(e) => setForm((f) => ({ ...f, model_id: e.target.value }))}
                placeholder={mh.placeholder}
                className="flex-1 font-mono text-[12px]"
              />
              {/* 2026-07-09 audit C-settings: title 之前原样显示 "GET /api/v2/providers/:id/fetch-models"
                  这种后端路由给用户当 tooltip, 铁律 #9 改讲人话. */}
              <Button
                variant="secondary"
                size="sm"
                iconLeft="refresh"
                onClick={handleFetchModels}
                disabled={fetchingModels || !isEdit}
                loading={fetchingModels}
                title={isEdit ? "点击从该模型来源拉取可用模型列表" : "请先保存再拉模型"}
              >
                {fetchingModels ? "拉取中…" : "拉取"}
              </Button>
            </div>
            {modelOptions.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <Select
                  value="__picker__"
                  onChange={(v) => {
                    if (v && v !== "__picker__") setForm((f) => ({ ...f, model_id: v }));
                  }}
                  options={[
                    { value: "__picker__", label: `— 从拉到的 ${modelOptions.length} 个模型选一个 —` },
                    ...modelOptions.map((m) => ({ value: m, label: m })),
                  ]}
                  ariaLabel="从拉到的模型列表选一个"
                  className="w-full"
                />
              </div>
            )}
          </Field>
            );
          })()}

          {/* anthropic_version (仅当 api_type=anthropic) */}
          {form.api_type === "anthropic" && (
            <Field label="anthropic-version" hint="anthropic API 必填, 默认 2023-06-01">
              <Input
                value={form.anthropic_version}
                disabled={isBuiltin}
                onChange={(e) => setForm((f) => ({ ...f, anthropic_version: e.target.value }))}
                placeholder="2023-06-01"
                className="font-mono text-[12px]"
              />
            </Field>
          )}

          {/* notes */}
          <Field label="备注 (可选)">
            <Textarea
              value={form.notes}
              rows={2}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder="自留用途说明"
              className="min-h-[48px]"
            />
          </Field>

          {/* enabled */}
          {/* 2026-07-09 audit C-settings: "Provider"/"ModelPicker" 翻中文 (铁律 #9, ModelPicker 是组件名). */}
          <Field label="启用" hint="禁用的模型不会出现在生成时的模型选择下拉里">
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12.5, color: "var(--ink-700)" }}>
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
              />
              <span>启用此模型</span>
            </label>
          </Field>
        </div>

        {/* footer */}
        <div style={{ padding: "12px 20px", borderTop: "1px solid var(--ink-100)", display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>取消</Button>
          <Button variant="primary" size="sm" iconLeft="save" onClick={handleSave} disabled={saving} loading={saving}>
            {saving ? "保存中…" : isEdit ? "保存" : "新增"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field(props: { label: string; hint?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-700)", marginBottom: 4 }}>
        {props.label}
        {props.required && <span style={{ color: "var(--err)", marginLeft: 4 }}>*</span>}
      </div>
      {props.children}
      {props.hint && (
        <div style={{ fontSize: 10.5, color: "var(--ink-500)", marginTop: 4, lineHeight: 1.5 }}>{props.hint}</div>
      )}
    </div>
  );
}

// ─── 真实视频锁 section ────────────────────────────────────────────

function RealVideoLockSection(props: { lockData: any }) {
  const { lockData } = props;
  return (
    <section>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", color: "var(--brand-700)", textTransform: "uppercase", marginBottom: 4 }}>设置 · 真实视频 API · 锁</div>
        <h2 style={{ margin: 0, fontFamily: "'Noto Serif SC', serif", fontSize: 24, fontWeight: 600, color: "var(--ink-900)" }}>真实视频 API · 全局锁</h2>
      </div>
      <div className="mk-card" style={{ padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14 }}>
          <Icon name="lock" size={22} style={{ color: "var(--brand-600)" }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-900)" }}>真实视频锁机制</div>
            <div style={{ fontSize: 11.5, color: "var(--ink-600)", lineHeight: 1.55 }}>
              {/* 2026-07-09 audit C-settings: 去掉"返回 HTTP 409"这类状态码措辞, 只讲用户关心的后果 (铁律 #9). */}
              付费视频按顺序生成，其余请求排队等待，减少误触和并发请求。实际费用以服务商账单为准。
            </div>
          </div>
          {lockData?.locked ? (
            <span className="mk-pill mk-pill--failed" style={{ height: 22 }}>锁占用中</span>
          ) : (
            <span className="mk-pill mk-pill--picked" style={{ height: 22 }}>当前空闲</span>
          )}
        </div>
        {lockData?.holder ? (
          <div style={{ padding: 12, background: "var(--warn-bg)", borderRadius: 10, fontSize: 12 }}>
            {/* 2026-07-09 audit C28: 原样暴露 provider 技术 id / jobId(UUID) / sceneId(其实是 episode_id) /
                UTC ISO 时间. provider 过 labelOfSource, sceneId 过 labelEpisodeId (真是集号), jobId 对用户
                不可操作直接去掉, startedAt 锁北京时间 (formatBeijingTime). */}
            锁持有者: <b>{labelOfSource(lockData.holder.provider)}</b> · {labelEpisodeId(lockData.holder.sceneId)} · 自 {formatBeijingTime(lockData.holder.startedAt, { mode: "datetime" })}
          </div>
        ) : (
          <div style={{ padding: 12, background: "var(--ink-50)", borderRadius: 10, fontSize: 12, color: "var(--ink-600)" }}>
            当前没有真实视频任务在执行。每 5 秒自动刷新。
          </div>
        )}
      </div>
    </section>
  );
}

// ─── Fallback Chain section (P0-2) ─────────────────────────────────

function ChainSection({ providers, health }: { providers: UserProvider[]; health?: ProviderHealthResponse }) {
  const { data: chainData, mutate: refreshChain, isLoading } = useSWR<ProviderChainResponse>(
    "settings:provider-chain",
    () => getProviderChain(),
    { revalidateOnFocus: false, onError: () => { /* 静默 */ } },
  );

  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleReorder(fromIdx: number, toIdx: number) {
    if (!chainData?.chain) return;
    const chain = [...chainData.chain];
    const [moved] = chain.splice(fromIdx, 1);
    chain.splice(toIdx, 0, moved);
    setSaving(true);
    try {
      await updateProviderChainApi(chain);
      await refreshChain();
      toast.success("链路顺序已更新");
    } catch (err: any) {
      toast.error(err?.message || "更新失败");
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    setSaving(true);
    try {
      await resetProviderChain();
      await refreshChain();
      toast.success("已恢复默认链路顺序");
    } catch (err: any) {
      toast.error(err?.message || "重置失败");
    } finally {
      setSaving(false);
    }
  }

  const chain = chainData?.chain ?? [];
  const active = chainData?.chain_active ?? null;
  const overridden = chainData?.overridden ?? false;

  return (
    <section>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", color: "var(--brand-700)", textTransform: "uppercase", marginBottom: 4 }}>设置 · 链路</div>
        <h2 style={{ margin: 0, fontFamily: "'Noto Serif SC', serif", fontSize: 24, fontWeight: 600, color: "var(--ink-900)" }}>备用模型调用顺序</h2>
        <p style={{ fontSize: 12.5, color: "var(--ink-600)", marginTop: 4, maxWidth: 760, lineHeight: 1.6 }}>
          当首选模型不可用时, 系统按此顺序依次尝试下一个。拖拽调整优先级, 排在越前面越优先使用。
        </p>
      </div>

      {isLoading && (
        <div className="mk-card" style={{ padding: 20, textAlign: "center", color: "var(--ink-400)" }}>加载中…</div>
      )}

      {!isLoading && chain.length === 0 && (
        <div className="mk-card" style={{ padding: 32, textAlign: "center", color: "var(--ink-500)", fontSize: 13 }}>
          <Icon name="link" size={28} style={{ color: "var(--ink-300)", marginBottom: 12 }} />
          {/* 2026-07-09 audit C-settings: 英文 "Provider" 翻中文 (铁律 #9). */}
          <div>暂无可用的文字模型</div>
          <div style={{ fontSize: 11.5, color: "var(--ink-400)", marginTop: 6 }}>请先在「文字模型」中配置至少一个模型</div>
        </div>
      )}

      {!isLoading && chain.length > 0 && (
        <div className="mk-card" style={{ padding: 0, overflow: "hidden" }}>
          {/* 表头 */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", background: "var(--ink-50)", borderBottom: "1px solid var(--ink-100)", fontSize: 11, fontWeight: 600, color: "var(--ink-500)" }}>
            <span style={{ width: 24, textAlign: "center" }}>#</span>
            {/* 2026-07-09 audit C-settings: 英文 "Provider" 列头翻中文 (铁律 #9). */}
            <span style={{ flex: 1 }}>模型</span>
            <span style={{ width: 80, textAlign: "center" }}>状态</span>
          </div>

          {chain.map((id, idx) => {
            const isActive = id === active;
            const isFirst = idx === 0;
            const label = providers.find((provider) => provider.id === id)?.label_zh
              || health?.providers.find((provider) => provider.id === id)?.name
              || `文字模型 ${idx + 1}`;
            return (
              <div
                key={id}
                draggable
                onDragStart={() => setDragIdx(idx)}
                onDragOver={(e) => { e.preventDefault(); }}
                onDrop={() => { if (dragIdx !== null && dragIdx !== idx) handleReorder(dragIdx, idx); setDragIdx(null); }}
                onDragEnd={() => setDragIdx(null)}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "10px 16px",
                  borderBottom: idx < chain.length - 1 ? "1px solid var(--ink-100)" : "none",
                  background: dragIdx === idx ? "var(--brand-50)" : isActive ? "var(--ok-bg)" : "var(--surface-card)",
                  cursor: "grab",
                  transition: "background 0.15s",
                }}
              >
                <span style={{ width: 24, textAlign: "center", fontSize: 11, color: "var(--ink-400)", fontWeight: 500 }}>
                  {idx + 1}
                </span>
                <span style={{ flex: 1, fontSize: 12.5, fontWeight: isActive ? 600 : 500, color: isActive ? "var(--ok)" : "var(--ink-800)" }}>
                  {label}
                  {isFirst && <span style={{ marginLeft: 8, fontSize: 10, color: "var(--ink-400)" }}>(首选)</span>}
                </span>
                <span style={{ width: 80, textAlign: "center" }}>
                  {isActive ? (
                    <span className="mk-pill mk-pill--picked" style={{ height: 20, fontSize: 10 }}>首选顺序</span>
                  ) : (
                    <span className="mk-pill mk-pill--draft" style={{ height: 20, fontSize: 10 }}>备用</span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* 底部操作栏 */}
      {!isLoading && chain.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
          {overridden && (
            <Button variant="secondary" size="sm" iconLeft="refresh" onClick={handleReset} disabled={saving} loading={saving} title="恢复到系统默认的模型优先级顺序">
              恢复默认顺序
            </Button>
          )}
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: "var(--ink-400)" }}>
            拖拽行调整优先级 · {overridden ? "当前为自定义顺序" : "当前为默认顺序"}
          </span>
        </div>
      )}
    </section>
  );
}

// ─── Budget section (P0-3) ────────────────────────────────────────

function BudgetSection() {
  const { data: budgetData, mutate: refreshBudget, isLoading } = useSWR<BudgetStatus>(
    "settings:budget",
    () => getBudgetStatus(),
    { revalidateOnFocus: false, onError: () => { /* 静默 */ } },
  );

  const [dailyCap, setDailyCap] = useState("");
  const [jobCap, setJobCap] = useState("");
  const [providerCap, setProviderCap] = useState("");
  const [initialized, setInitialized] = useState(false);
  const saveAction = useAsyncAction(
    async () => {
      // 2026-06-01 收尾自查: 校验 ≥0 数字。负预算上限会让 preflight 把所有生成卡死(用户摸不着头脑),
      // NaN 会写进后端。非法直接拒绝, 不存垃圾。
      const parseCap = (s: string): number | null => {
        const n = Number(s);
        return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
      };
      const patch: PatchV2SettingsInput = {};
      let invalid = false;
      const apply = (s: string, set: (n: number) => void) => {
        if (!s.trim()) return;
        const n = parseCap(s);
        if (n === null) invalid = true;
        else set(n);
      };
      apply(dailyCap, (n) => { patch.budget_daily_cap_cny = n; });
      apply(jobCap, (n) => { patch.budget_single_job_cap_cny = n; });
      apply(providerCap, (n) => { patch.budget_per_provider_cap_cny = n; });
      if (invalid) {
        toast.error("预算上限要填 ≥ 0 的数字");
        return;
      }
      if (Object.keys(patch).length === 0) {
        toast.info("未修改任何值");
        return;
      }
      await patchV2Settings(patch);
    },
    {
      errorMessage: "保存失败",
      onSuccess: () => {
        toast.success("预算设置已保存");
        refreshBudget();
      },
    },
  );

  // 初始化表单 (从 API 数据回填)
  useEffect(() => {
    if (budgetData && !initialized) {
      setDailyCap(String(budgetData.daily_cap_cny));
      setJobCap(String(budgetData.single_job_cap_cny));
      setProviderCap(String(budgetData.per_provider_cap_cny));
      setInitialized(true);
    }
  }, [budgetData, initialized]);

  const dailyUsed = budgetData?.daily_used_cny ?? 0;
  const dailyLimit = budgetData?.daily_cap_cny ?? 50;
  const usagePercent = dailyLimit > 0 ? Math.min((dailyUsed / dailyLimit) * 100, 100) : 0;
  const isNearLimit = usagePercent >= 80;
  const isOverLimit = usagePercent >= 100;

  return (
    <section>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", color: "var(--brand-700)", textTransform: "uppercase", marginBottom: 4 }}>设置 · 预算</div>
        <h2 style={{ margin: 0, fontFamily: "'Noto Serif SC', serif", fontSize: 24, fontWeight: 600, color: "var(--ink-900)" }}>费用预算</h2>
        <p style={{ fontSize: 12.5, color: "var(--ink-600)", marginTop: 4, maxWidth: 760, lineHeight: 1.6 }}>
          防止意外超支。达到上限后系统自动停止扣费任务, 每日自动重置。
        </p>
      </div>

      {isLoading && (
        <div className="mk-card" style={{ padding: 20, textAlign: "center", color: "var(--ink-400)" }}>加载中…</div>
      )}

      {!isLoading && budgetData && (
        <>
          {/* 今日用量概览 */}
          <div className="mk-card" style={{ padding: 18, marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12 }}>
              <Icon name="coin" size={22} style={{ color: isOverLimit ? "var(--err)" : isNearLimit ? "var(--warn)" : "var(--brand-600)" }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-900)" }}>今日用量</div>
                <div style={{ fontSize: 11.5, color: "var(--ink-600)" }}>
                  已用 <b style={{ color: isOverLimit ? "var(--err)" : "var(--ink-900)" }}>¥{dailyUsed.toFixed(2)}</b> / 上限 ¥{dailyLimit.toFixed(2)}
                </div>
              </div>
              {budgetData.inflight_count > 0 && (
                <span className="mk-pill" style={{ background: "var(--brand-50)", color: "var(--brand-700)", height: 22, fontSize: 10.5 }}>
                  {budgetData.inflight_count} 个任务进行中
                </span>
              )}
            </div>
            {/* 进度条 */}
            <div style={{ height: 8, borderRadius: 4, background: "var(--ink-100)", overflow: "hidden" }}>
              <div style={{
                height: "100%", borderRadius: 4, transition: "width 0.4s ease",
                width: `${usagePercent}%`,
                background: isOverLimit ? "var(--err)" : isNearLimit ? "var(--warn)" : "var(--brand-500)",
              }} />
            </div>
            {isOverLimit && (
              <div style={{ marginTop: 8, padding: "6px 10px", borderRadius: 6, background: "var(--err-bg, #fef2f2)", fontSize: 11.5, color: "var(--err)" }}>
                已超出日预算上限, 新的扣费任务将被暂停。请调高上限或等待明日自动重置。
              </div>
            )}
            {isNearLimit && !isOverLimit && (
              <div style={{ marginTop: 8, padding: "6px 10px", borderRadius: 6, background: "var(--warn-bg)", fontSize: 11.5, color: "var(--warn)" }}>
                接近日预算上限, 请注意控制用量。
              </div>
            )}
          </div>

          {/* 预算设置表单 */}
          <div className="mk-card" style={{ padding: 18 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-800)", marginBottom: 14 }}>预算上限 (元)</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
              <Field label="日预算上限" hint="每天所有任务累计花费上限">
                <Input
                  type="number"
                  min={0}
                  step={10}
                  value={dailyCap}
                  onChange={(e) => setDailyCap(e.target.value)}
                  placeholder="50"
                  className="font-mono text-[12px]"
                />
              </Field>
              <Field label="单任务上限" hint="单个作业(一键全集)花费上限">
                <Input
                  type="number"
                  min={0}
                  step={5}
                  value={jobCap}
                  onChange={(e) => setJobCap(e.target.value)}
                  placeholder="20"
                  className="font-mono text-[12px]"
                />
              </Field>
              <Field label="单渠道上限" hint="单个模型渠道每天花费上限">
                <Input
                  type="number"
                  min={0}
                  step={10}
                  value={providerCap}
                  onChange={(e) => setProviderCap(e.target.value)}
                  placeholder="30"
                  className="font-mono text-[12px]"
                />
              </Field>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
              <Button variant="primary" size="sm" iconLeft="save" onClick={() => saveAction.run()} disabled={saveAction.busy} loading={saveAction.busy}>
                {saveAction.busy ? "保存中…" : "保存预算设置"}
              </Button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

// ─── Usage section (P1-7) ───────────────────────────────────────────

function UsageSection() {
  const [period, setPeriod] = useState<"day" | "week" | "month">("month");
  const { data: usageData, isLoading } = useSWR<UsageStatus>(
    `settings:usage:${period}`,
    () => getUsageStatus(period),
    { revalidateOnFocus: false, onError: () => { /* 静默 */ } },
  );

  const daily = usageData?.daily ?? [];
  const byProvider = usageData?.by_provider ?? [];
  const total = usageData?.total_cny ?? 0;
  const maxDaily = Math.max(...daily.map((d) => d.amount_cny), 1);

  return (
    <section>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", color: "var(--brand-700)", textTransform: "uppercase", marginBottom: 4 }}>设置 · 用量</div>
        <h2 style={{ margin: 0, fontFamily: "'Noto Serif SC', serif", fontSize: 24, fontWeight: 600, color: "var(--ink-900)" }}>用量统计</h2>
        <p style={{ fontSize: 12.5, color: "var(--ink-600)", marginTop: 4, maxWidth: 760, lineHeight: 1.6 }}>
          查看此设备记录的费用与调用情况，实际账单以服务商为准。
        </p>
      </div>

      {/* period 切换 */}
      <div style={{ display: "flex", gap: 4, marginBottom: 16, padding: 4, borderRadius: 10, background: "var(--ink-50)", border: "1px solid var(--ink-100)", width: "fit-content" }}>
        {([["day", "今日"], ["week", "近 7 天"], ["month", "本月"]] as const).map(([p, label]) => (
          <button
            key={p}
            type="button"
            onClick={() => setPeriod(p)}
            className="mk-btn mk-btn--sm"
            style={{
              padding: "6px 14px", borderRadius: 6, cursor: "pointer",
              background: period === p ? "var(--brand-50)" : "transparent",
              color: period === p ? "var(--brand-700)" : "var(--ink-600)",
              border: period === p ? "1px solid var(--brand-200)" : "1px solid transparent",
              fontWeight: period === p ? 600 : 500,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {isLoading && (
        <div className="mk-card" style={{ padding: 20, textAlign: "center", color: "var(--ink-400)" }}>加载中…</div>
      )}

      {!isLoading && (
        <>
          {/* 总计概览 */}
          <div className="mk-card" style={{ padding: 18, marginBottom: 12, display: "flex", alignItems: "center", gap: 14 }}>
            <Icon name="coin" size={22} style={{ color: "var(--brand-600)" }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-900)" }}>
                {period === "day" ? "今日" : period === "week" ? "近 7 天" : "本月"}总消耗
              </div>
              <div style={{ fontSize: 11.5, color: "var(--ink-500)" }}>
                {daily.length} 天有消耗记录 · {byProvider.length} 个渠道
              </div>
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color: "var(--ink-900)", fontFamily: "ui-monospace, Consolas, monospace" }}>
              ¥{total.toFixed(2)}
            </div>
          </div>

          {/* 按天柱状图 */}
          {daily.length > 0 && (
            <div className="mk-card" style={{ padding: 18, marginBottom: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-800)", marginBottom: 14 }}>按天消耗</div>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 120, padding: "0 4px" }}>
                {daily.map((d) => {
                  const heightPct = maxDaily > 0 ? (d.amount_cny / maxDaily) * 100 : 0;
                  return (
                    <div key={d.date} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                      <span style={{ fontSize: 9, color: "var(--ink-500)", fontFamily: "ui-monospace, Consolas, monospace" }}>
                        {d.amount_cny >= 1 ? `¥${d.amount_cny.toFixed(0)}` : d.amount_cny > 0 ? `¥${d.amount_cny.toFixed(2)}` : ""}
                      </span>
                      <div style={{ width: "100%", maxWidth: 32, height: `${Math.max(heightPct, 2)}%`, borderRadius: 4, background: "var(--brand-400)", minHeight: 2 }} />
                      <span style={{ fontSize: 9, color: "var(--ink-400)", whiteSpace: "nowrap" }}>
                        {d.date.slice(5)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 按 provider 分层 */}
          {byProvider.length > 0 && (
            <div className="mk-card" style={{ padding: 18 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-800)", marginBottom: 14 }}>按渠道消耗</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {byProvider.map((p) => {
                  const pct = total > 0 ? (p.amount_cny / total) * 100 : 0;
                  return (
                    <div key={p.provider}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                        <span style={{ fontSize: 12, fontWeight: 500, color: "var(--ink-800)", flex: 1 }}>{labelOfSource(p.provider)}</span>
                        <span style={{ fontSize: 11, color: "var(--ink-500)", fontFamily: "ui-monospace, Consolas, monospace" }}>¥{p.amount_cny.toFixed(2)}</span>
                        <span style={{ fontSize: 10, color: "var(--ink-400)" }}>{pct.toFixed(0)}%</span>
                      </div>
                      <div style={{ height: 6, borderRadius: 3, background: "var(--ink-100)", overflow: "hidden" }}>
                        <div style={{ height: "100%", borderRadius: 3, width: `${pct}%`, background: "var(--brand-400)" }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 空状态 */}
          {daily.length === 0 && (
            <div className="mk-card" style={{ padding: 32, textAlign: "center", color: "var(--ink-500)", fontSize: 13 }}>
              <Icon name="chart" size={28} style={{ color: "var(--ink-300)", marginBottom: 12 }} />
              <div>暂无消耗记录</div>
              <div style={{ fontSize: 11.5, color: "var(--ink-400)", marginTop: 6 }}>开始生成内容后, 费用会自动记录在这里</div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ─── About section ─────────────────────────────────────────────────

// T2: __PACKAGE_VERSION__ 由 vite.config.ts 在构建时从根 package.json 注入。
// /api/v2/health 返回的 version 字段值为固定字符串 "v2"，不是语义版本，故改走 vite define。
declare const __PACKAGE_VERSION__: string;

function AboutSection() {
  // T2: 从 GET /api/v2/health 确认服务存活，版本号从 vite.config.ts 注入的 __PACKAGE_VERSION__ 读取。
  const { data: healthData } = useSWR<{ ok?: boolean }>(
    "health:version",
    () => fetch("/api/v2/health").then((r) => r.json()),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
  // 服务可达时显示语义版本; 服务不可达时 fallback
  const version = healthData?.ok
    ? `v${__PACKAGE_VERSION__}`
    : healthData === undefined
      ? "加载中…"
      : "(无法获取版本)";

  return (
    <section>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", color: "var(--brand-700)", textTransform: "uppercase", marginBottom: 4 }}>设置 · 关于</div>
        <h2 style={{ margin: 0, fontFamily: "'Noto Serif SC', serif", fontSize: 24, fontWeight: 600, color: "var(--ink-900)" }}>关于 · 版本</h2>
      </div>
      <div className="mk-card" style={{ padding: 18, display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ width: 48, height: 48, borderRadius: 12, background: "linear-gradient(135deg, var(--brand-400), var(--brand-700))", color: "#fff", display: "grid", placeItems: "center", fontSize: 18, fontWeight: 700, fontFamily: "'Noto Serif SC', serif" }}>
          AI
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink-900)", marginBottom: 4, fontFamily: "'Noto Serif SC', serif" }}>
            AI 短剧生成工作台 {version}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--ink-600)", marginBottom: 4 }}>AI Short Drama Workbench</div>
          <div style={{ fontSize: 11.5, color: "var(--ink-500)" }}>AI 短剧、漫剧与剧情短片创作 · 单用户本机使用</div>
        </div>
      </div>

      {/* P2-2: 外观主题切换 */}


      <div className="mk-card" style={{ marginTop: 12, padding: 18 }}>
        {/* 2026-07-09 audit C-settings: 原文"主链路 (auto 模式)"暴露内部模式名, 后面几行把
            "image provider"/"video provider"(英文技术词)、"ffmpeg"/"ASS 字幕"(实现细节) 当卖点列给
            用户, 跟 WelcomeTour 那处是同一违规模式(铁律 #9), 这里同步改成人话. */}
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-700)", marginBottom: 8 }}>完整流程</div>
        <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--ink-600)", lineHeight: 1.7 }}>
          <li>灵感 → 剧本 (LLM 扩写)</li>
          <li>剧本 → 分镜 (LLM)</li>
          <li>分镜 → 首帧图 (AI 生图)</li>
          <li>首帧 → 视频 (AI 生成视频)</li>
          <li>视频 → 合成成片 (自动拼接 + 烧录字幕)</li>
        </ol>
      </div>

      {/* 2026-05-25 C5 — 数据管理: 备份 / 恢复 / 项目导出导入.
          后端 endpoint 早就接好 (apps/server/src/api/dataManagement.ts +
          routes.ts:209/216/228), 但前端 0 caller. 这里加 UI 入口让用户能真用. */}
      <DataManagementSection />
    </section>
  );
}

// ─── 2026-05-25 C5: 数据管理 — 备份 / 恢复 / 项目导出导入 ─────────────────────
// P1-1: imports 已上移到文件顶部.

function DataManagementSection() {
  const confirm = useConfirm();
  const backupAction = useAsyncAction(
    async () => {
      const r = await createBackupArchive();
      toast.success(`已创建备份: ${r.backup.filename}`, { duration: 6000, description: `路径: ${r.backup.path}` });
    },
    { errorMessage: "创建备份失败" },
  );
  const restoreAction = useAsyncAction(
    async (path: string) => {
      const r = await restoreBackupArchive(path);
      toast.success("恢复完成", { duration: 6000, description: `恢复时间: ${formatBeijingTime(r.restored_at, { mode: "datetime" })}` });
    },
    { errorMessage: "恢复失败" },
  );
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const importAction = useAsyncAction(
    async (file: File) => {
      const r = await importProjectArchive({ file });
      toast.success(`已导入项目: ${r.project.title}`, { duration: 6000, description: `slug: ${r.project.slug}` });
    },
    { errorMessage: "导入项目失败" },
  );

  // 2026-05-25: 恢复备份原本让用户手输 ZIP 绝对路径 (dev-flavor 偷工).
  // 改: 优先弹系统原生文件选择器 (modern IFileOpenDialog Win10/11 explorer 风格),
  // 失败 / 不支持时降级到 PromptDialog 手输.
  const [restorePathDialog, setRestorePathDialog] = useStateForDataMgmt<{ open: boolean }>({ open: false });
  async function handleRestore() {
    try {
      const r = await apiPost<{ ok: boolean; path?: string; canceled?: boolean }>(
        "/api/utils/pick-file",
        { fileFilter: "zip" },
      );
      if (r.ok && r.path) {
        await submitRestorePath(r.path);
        return;
      }
      if (r.ok && r.canceled) {
        // 用户取消, 静默
        return;
      }
      setRestorePathDialog({ open: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[pick-file] native picker 不可用, 降级到手输:", msg);
      setRestorePathDialog({ open: true });
    }
  }
  async function submitRestorePath(path: string) {
    const trimmed = path.trim();
    if (!trimmed) return;
    setRestorePathDialog({ open: false });
    const ok = await confirm({
      title: "确认恢复备份?",
      description: "恢复会覆盖当前 data/ 目录, 当前未提交改动会丢失. 建议先创建一份新备份.",
      variant: "warning",
      confirmLabel: "确认恢复",
    });
    if (!ok) return;
    await restoreAction.run(trimmed);
  }

  return (
    <div className="mk-card" style={{ marginTop: 12, padding: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <Icon name="folder" size={14} style={{ color: "var(--brand-600)" }} />
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink-800)" }}>数据管理</div>
      </div>
      <div style={{ fontSize: 11.5, color: "var(--ink-500)", marginBottom: 12, lineHeight: 1.55 }}>
        本地数据全部落在 <code style={{ background: "var(--ink-50)", padding: "1px 5px", borderRadius: 4, fontSize: 11 }}>data/</code> 目录. 备份 ZIP 默认存到 <code style={{ background: "var(--ink-50)", padding: "1px 5px", borderRadius: 4, fontSize: 11 }}>~/.video-generate-backups/</code>, 跨电脑迁移把 ZIP 拷过去再恢复即可.
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Button variant="primary" size="sm" iconLeft="download" loading={backupAction.busy} disabled={backupAction.busy} onClick={() => backupAction.run()} title="把整个 data/ + config/ 打包成 ZIP, 存到 ~/.video-generate-backups/">
          创建全量备份
        </Button>
        <Button variant="secondary" size="sm" iconLeft="upload" loading={restoreAction.busy} disabled={restoreAction.busy} onClick={handleRestore} title="从 ZIP 恢复 — 会覆盖当前 data/, 谨慎用">
          恢复备份
        </Button>
        <input
          ref={importInputRef}
          type="file"
          accept=".zip,application/zip,application/x-zip-compressed"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void importAction.run(file);
          }}
        />
        <Button variant="secondary" size="sm" iconLeft="image" loading={importAction.busy} disabled={importAction.busy} onClick={() => importInputRef.current?.click()} title="导入别人导出的单项目 ZIP, 创建新系列">
          导入单项目 ZIP
        </Button>
      </div>
      <div style={{ marginTop: 10, fontSize: 11, color: "var(--ink-400)" }}>
        {/* 2026-07-09 audit C-settings: 原文暴露组件名"StudioHome"+ 开发备注"待加 UI 入口", 还指向
            一个当前并不存在的"右键导出"操作(铁律 #9 + #5). 改成用户此刻真能照做的话. */}
        提示: 单项目导出功能开发中, 当前请用上方"创建全量备份".
      </div>

      {/* 2026-05-25 续修 — 恢复备份路径输入: 页面级 PromptDialog 取代 window.prompt */}
      <PromptDialog
        open={restorePathDialog.open}
        title="恢复备份"
        description="粘贴你创建备份时保存的 ZIP 文件完整路径。下一步会显示恢复确认，请核对所选备份。"
        label="备份 ZIP 路径"
        placeholder="粘贴备份 ZIP 文件的完整路径"
        confirmText="下一步"
        busy={restoreAction.busy}
        onClose={() => setRestorePathDialog({ open: false })}
        onSubmit={submitRestorePath}
      />
    </div>
  );
}
