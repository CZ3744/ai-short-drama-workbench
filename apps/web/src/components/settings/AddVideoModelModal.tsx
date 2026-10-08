// AddVideoModelModal — 自定义视频模型实例 (2 级架构: 渠道 + 模型) Modal.
//
// 用户截图设计: 顶部"接口地址 / 协议类型 / API Key / 模型名称 / [取消][确定]".
// 此处协议替换为"渠道"(写死 5 选 1: Kling / Vidu / 即梦 / MiniMax / 阿里万相),
// 协议绑死渠道, 不让用户选, 防止填错.
//
// 模型名搜索下拉: fuzzy match 渠道的 suggested_models, 但用户输入任意字符串都允许
// (用户可填官方最新没列入 list 的 model id).
//
// API Key + Secret Key (双 key 渠道才显示) 密码输入 + 眼睛切换可见.
//
// 红线 (CLAUDE.md):
//   - 不强制选 3.0; 用户填什么就发什么
//   - 错误 inline 显示, 不 silent fallback
//   - icon + 文字标签, 不允许 icon-only

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../shared/Icon";
import { Button } from "../ui/button";
import { Select } from "../ui/select";
import { BaseDialog } from "../ui/BaseDialog";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import {
  type VideoChannelDef,
  type VideoChannelId,
  type VideoModelInstance,
  createVideoModelInstance,
  patchVideoModelInstance,
} from "../../lib/videoModelInstancesApi";

interface Props {
  channels: VideoChannelDef[];
  /** create 模式 (无 instance) 或 edit 模式 (有 instance) */
  instance?: VideoModelInstance | null;
  /** 预选 channel (create 模式) */
  initialChannel?: VideoChannelId;
  onClose: () => void;
  onSaved: () => void;
}

export function AddVideoModelModal({ channels, instance, initialChannel, onClose, onSaved }: Props) {
  const isEdit = !!instance;
  const [channel, setChannel] = useState<VideoChannelId>(
    instance?.channel ?? initialChannel ?? channels[0]?.id ?? "kling",
  );
  const [displayName, setDisplayName] = useState(instance?.display_name ?? "");
  const [modelId, setModelId] = useState(instance?.model_id ?? "");
  const [apiBaseUrl, setApiBaseUrl] = useState(instance?.api_base_url ?? "");
  const [apiKey, setApiKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [region, setRegion] = useState(instance?.region ?? "");
  const [showKey, setShowKey] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [modelSearch, setModelSearch] = useState(instance?.model_id ?? "");
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  // BUG-28 fix: useRef 存储 onBlur 的 setTimeout timer
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const channelDef = useMemo(() => channels.find((c) => c.id === channel), [channels, channel]);
  const filteredSuggestions = useMemo(() => {
    if (!channelDef) return [];
    const q = modelSearch.trim().toLowerCase();
    if (!q) return channelDef.suggested_models;
    return channelDef.suggested_models.filter((m) => m.toLowerCase().includes(q));
  }, [channelDef, modelSearch]);

  // 2026-05-20 Wave T S25 — region 用于阿里万相(可选) + 腾讯混元(必填)
  const channelNeedsRegion = (id: string) => id === "aliyun_wan" || id === "tencent_hunyuan";
  // 切渠道时只在不需要 region 的渠道清空
  useEffect(() => {
    if (!channelNeedsRegion(channel)) setRegion("");
  }, [channel]);

  // 用 useAsyncAction 接管 busy 与 try/catch — err 仍 inline 显示, 走 silent + onError
  const saveAction = useAsyncAction(
    async (payload: {
      trimmedName: string;
      trimmedModel: string;
      trimmedKey: string;
      trimmedSecret: string;
      trimmedBase: string;
      trimmedRegion: string;
      channelDefArg: VideoChannelDef;
    }) => {
      if (isEdit && instance) {
        await patchVideoModelInstance(instance.id, {
          display_name: payload.trimmedName,
          model_id: payload.trimmedModel,
          api_base_url: payload.trimmedBase || null,
          region: payload.trimmedRegion || null,
          // key 留空保留旧值
          api_key: payload.trimmedKey || undefined,
          secret_key: payload.trimmedSecret || undefined,
        });
      } else {
        await createVideoModelInstance({
          display_name: payload.trimmedName,
          channel: payload.channelDefArg.id,
          model_id: payload.trimmedModel,
          api_base_url: payload.trimmedBase || undefined,
          api_key: payload.trimmedKey,
          secret_key: payload.channelDefArg.needs_secret ? payload.trimmedSecret : undefined,
          region: payload.trimmedRegion || undefined,
        });
      }
    },
    {
      silent: true,
      onSuccess: () => {
        setErr(null);
        onSaved();
      },
      onError: (e: any) => setErr(e?.message ?? "保存失败"),
    },
  );
  const saving = saveAction.busy;

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    setErr(null);
    if (!channelDef) {
      setErr("渠道未选");
      return;
    }
    const trimmedName = displayName.trim();
    const trimmedModel = (modelId || modelSearch).trim();
    const trimmedKey = apiKey.trim();
    const trimmedSecret = secretKey.trim();
    const trimmedBase = apiBaseUrl.trim();
    const trimmedRegion = region.trim();
    if (!trimmedName) {
      setErr("显示名称不能空");
      return;
    }
    if (!trimmedModel) {
      setErr("模型 ID 不能空");
      return;
    }
    if (!isEdit && !trimmedKey) {
      setErr("API Key 不能空");
      return;
    }
    if (!isEdit && channelDef.needs_secret && !trimmedSecret) {
      setErr(`${channelDef.label} 需要 Secret Key`);
      return;
    }
    // 2026-05-20 Wave T hotfix — 腾讯混元 region 必填,跟 UI 标签 "必填" 一致(铁律 #5 真实状态)
    if (channel === "tencent_hunyuan" && !trimmedRegion) {
      setErr("腾讯混元必须填服务地域(如 ap-guangzhou)");
      return;
    }

    await saveAction.run({
      trimmedName,
      trimmedModel,
      trimmedKey,
      trimmedSecret,
      trimmedBase,
      trimmedRegion,
      channelDefArg: channelDef,
    });
  }

  return (
    <BaseDialog
      open={true}
      onClose={onClose}
      iconName={isEdit ? "edit" : "plus"}
      title={isEdit ? `编辑 ${channelDef?.label ?? ""} 模型实例` : "添加自定义视频模型"}
      ariaLabel={isEdit ? "编辑视频模型实例" : "添加自定义视频模型"}
      busy={saving}
      maxWidth={540}
      zIndex={1000}
      footer={
        <>
          <Button variant="secondary" iconLeft="close" onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            iconLeft={saving ? "refresh" : "check"}
            onClick={() => { void handleSubmit(); }}
            disabled={saving}
            loading={saving}
          >
            {saving ? "保存中..." : isEdit ? "保存" : "添加"}
          </Button>
        </>
      }
    >
      <form
        onSubmit={handleSubmit}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {/* 渠道选择 (edit 模式禁用) */}
        <Field label="渠道" hint={channelDef?.hint}>
          <Select
            value={channel}
            onChange={(v) => setChannel(v as VideoChannelId)}
            options={channels.map((c) => ({ value: c.id, label: c.label }))}
            disabled={isEdit}
            ariaLabel="视频渠道"
            className="w-full"
          />
        </Field>

        {/* 接口地址 */}
        <Field
          label="接口地址 (留空走默认)"
          hint={channelDef ? `默认 ${channelDef.default_base_url}` : ""}
        >
          <input
            type="text"
            value={apiBaseUrl}
            placeholder={channelDef?.default_base_url ?? ""}
            onChange={(e) => setApiBaseUrl(e.target.value)}
            style={inputStyle}
          />
        </Field>

        {/* 模型名称 — 显示名 */}
        <Field label="显示名称 (出现在 ModelPicker 下拉)">
          <input
            type="text"
            value={displayName}
            placeholder="例如: 可灵 v3 Pro / Hailuo 高清 / ..."
            onChange={(e) => setDisplayName(e.target.value)}
            style={inputStyle}
          />
        </Field>

        {/* 模型 ID 搜索下拉 */}
        <Field
          label="模型 ID (真实 API 字段)"
          hint="输入完整模型名,可从建议列表选,也可自填官方最新版本"
        >
          <div style={{ position: "relative" }}>
            <input
              type="text"
              value={modelSearch}
              placeholder={channelDef?.suggested_models[0] ?? ""}
              onChange={(e) => {
                setModelSearch(e.target.value);
                setModelId(e.target.value);
                setShowModelDropdown(true);
              }}
              onFocus={() => setShowModelDropdown(true)}
              onBlur={() => {
                if (blurTimerRef.current !== null) clearTimeout(blurTimerRef.current);
                blurTimerRef.current = setTimeout(() => {
                  setShowModelDropdown(false);
                  blurTimerRef.current = null;
                }, 150);
              }}
              style={inputStyle}
            />
            {showModelDropdown && filteredSuggestions.length > 0 && (
              <div
                style={{
                  position: "absolute",
                  top: "100%",
                  left: 0,
                  right: 0,
                  background: "#fff",
                  border: "1px solid var(--ink-200)",
                  borderRadius: 6,
                  marginTop: 2,
                  maxHeight: 200,
                  overflowY: "auto",
                  zIndex: 1001,
                  boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
                }}
              >
                {filteredSuggestions.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setModelId(m);
                      setModelSearch(m);
                      setShowModelDropdown(false);
                    }}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "8px 12px",
                      border: "none",
                      background: "transparent",
                      cursor: "pointer",
                      fontSize: 13,
                      borderBottom: "1px solid var(--ink-100)",
                    }}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
          </div>
        </Field>

        {/* API Key (双键渠道 label 仅显示) */}
        <Field
          label={channelDef?.needs_secret ? "Access Key (AK)" : "API Key"}
          hint={isEdit ? "留空 = 保留旧 key" : undefined}
        >
          <div style={{ position: "relative" }}>
            <input
              type={showKey ? "text" : "password"}
              value={apiKey}
              placeholder={isEdit ? "(保持不变)" : ""}
              onChange={(e) => setApiKey(e.target.value)}
              style={{ ...inputStyle, paddingRight: 64 }}
              autoComplete="off"
            />
            <button
              type="button"
              onClick={() => setShowKey((s) => !s)}
              style={eyeButtonStyle}
              aria-label={showKey ? "隐藏 Key" : "显示 Key"}
              title={showKey ? "隐藏" : "显示"}
            >
              <Icon name="eye" size={14} style={{ opacity: showKey ? 1 : 0.45 }} />
              <span>{showKey ? "隐藏" : "显示"}</span>
            </button>
          </div>
        </Field>

        {/* Secret Key — 仅双 Key 渠道 */}
        {channelDef?.needs_secret && (
          <Field
            label="Secret Key (SK)"
            hint={isEdit ? "留空 = 保留旧 key" : "可灵 / 即梦的签名密钥"}
          >
            <div style={{ position: "relative" }}>
              <input
                type={showSecret ? "text" : "password"}
                value={secretKey}
                placeholder={isEdit ? "(保持不变)" : ""}
                onChange={(e) => setSecretKey(e.target.value)}
                style={{ ...inputStyle, paddingRight: 64 }}
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setShowSecret((s) => !s)}
                style={eyeButtonStyle}
                aria-label={showSecret ? "隐藏 Secret" : "显示 Secret"}
                title={showSecret ? "隐藏" : "显示"}
              >
                <Icon name="eye" size={14} style={{ opacity: showSecret ? 1 : 0.45 }} />
                <span>{showSecret ? "隐藏" : "显示"}</span>
              </button>
            </div>
          </Field>
        )}

        {/* Region — 阿里万相(可选)+ 腾讯混元(必填) */}
        {channel === "aliyun_wan" && (
          <Field label="服务地域 (可选)" hint="例如: cn-beijing / cn-hangzhou">
            <input
              type="text"
              value={region}
              placeholder="cn-beijing"
              onChange={(e) => setRegion(e.target.value)}
              style={inputStyle}
            />
          </Field>
        )}
        {channel === "tencent_hunyuan" && (
          <Field label="服务地域 (必填)" hint="腾讯云区域,例如: ap-guangzhou / ap-singapore / ap-shanghai">
            <input
              type="text"
              value={region}
              placeholder="ap-guangzhou"
              onChange={(e) => setRegion(e.target.value)}
              style={inputStyle}
            />
          </Field>
        )}

        {/* 文档链接 */}
        {channelDef?.doc_url && (
          <div style={{ fontSize: 12, color: "var(--ink-500)" }}>
            官方文档:{" "}
            <a href={channelDef.doc_url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--brand-700)" }}>
              {channelDef.doc_url}
            </a>
          </div>
        )}

        {/* Error inline */}
        {err && (
          <div
            role="alert"
            style={{
              padding: "8px 12px",
              borderRadius: 6,
              background: "var(--danger-50, #fef2f2)",
              border: "1px solid var(--danger-200, #fecaca)",
              color: "var(--danger-700, #991b1b)",
              fontSize: 13,
              display: "flex",
              gap: 8,
              alignItems: "flex-start",
            }}
          >
            <Icon name="warning" size={14} style={{ flexShrink: 0, marginTop: 2 }} />
            <span>{err}</span>
          </div>
        )}

        {/* 隐藏 submit button — 允许键盘 Enter 触发表单提交(form onSubmit) */}
        <button type="submit" style={{ display: "none" }} aria-hidden disabled={saving} />
      </form>
    </BaseDialog>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-800)" }}>{label}</label>
      {children}
      {hint && <div style={{ fontSize: 11, color: "var(--ink-500)" }}>{hint}</div>}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  height: 34,
  padding: "0 10px",
  borderRadius: 6,
  border: "1px solid var(--ink-200)",
  fontSize: 13,
  outline: "none",
  background: "#fff",
};
const selectStyle: React.CSSProperties = { ...inputStyle, cursor: "pointer" };

// 2026-07-22 X4 铁律#11: 眼睛按钮从纯图标改成"图标 + 显示/隐藏"文字.
// 去掉固定 width:28 改自适应(padding + gap), 输入框 paddingRight 同步 36→64 防遮挡输入文字.
const eyeButtonStyle: React.CSSProperties = {
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
};

const cancelButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "0 14px",
  height: 32,
  borderRadius: 6,
  border: "1px solid var(--ink-200)",
  background: "#fff",
  fontSize: 13,
  cursor: "pointer",
  color: "var(--ink-800)",
};

const primaryButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "0 16px",
  height: 32,
  borderRadius: 6,
  border: "none",
  background: "var(--brand-700, #2563eb)",
  color: "#fff",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};
