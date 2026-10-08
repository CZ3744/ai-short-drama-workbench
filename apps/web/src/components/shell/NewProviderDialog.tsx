import { useState, useEffect } from "react";
import { BaseDialog } from "../ui/BaseDialog";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { Select } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { cn } from "../../lib/cn";
import type { ProviderKind, ApiType, CreateProviderInput, ProviderConfig } from "../../lib/api";
import {
  Eye, EyeOff, ChevronDown, ChevronUp,
} from "../shared/LucideIcon";

interface NewProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: CreateProviderInput) => Promise<ProviderConfig>;
  saving: boolean;
}

const KIND_OPTIONS = [
  { value: "llm", label: "大语言模型" },
  { value: "image", label: "图像" },
  // P180 A8: video removed — no generic video adapter available for custom providers
  { value: "tts", label: "语音合成" },
];

const API_TYPE_OPTIONS = [
  { value: "openai_compat", label: "OpenAI 兼容" },
  { value: "anthropic", label: "Anthropic" },
  { value: "custom", label: "自定义" },
];

function autoId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_一-鿿]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_|_$/g, "")
    .replace(/[一-鿿]/g, "")
    .replace(/_{2,}/g, "_")
    .replace(/^_|_$/g, "") || "custom_provider";
}

export function NewProviderDialog({ open, onOpenChange, onCreate, saving }: NewProviderDialogProps) {
  // Form state
  const [providerId, setProviderId] = useState("");
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<ProviderKind>("llm");
  const [apiType, setApiType] = useState<ApiType>("openai_compat");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [modelId, setModelId] = useState("");

  // Advanced options
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [timeoutMs, setTimeoutMs] = useState(30000);
  const [maxRetries, setMaxRetries] = useState(2);
  const [costIn, setCostIn] = useState(0);
  const [costOut, setCostOut] = useState(0);

  // Validation errors
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Auto-generate ID from label
  useEffect(() => {
    if (label.trim()) {
      setProviderId(autoId(label));
    }
  }, [label]);

  function reset() {
    setProviderId("");
    setLabel("");
    setKind("llm");
    setApiType("openai_compat");
    setBaseUrl("");
    setApiKey("");
    setShowApiKey(false);
    setModelId("");
    setAdvancedOpen(false);
    setTimeoutMs(30000);
    setMaxRetries(2);
    setCostIn(0);
    setCostOut(0);
    setErrors({});
  }

  function validate(): boolean {
    const errs: Record<string, string> = {};

    // ID validation (per CreateProviderSchema)
    if (!providerId.trim()) {
      errs.id = "ID 不能为空";
    } else if (!/^[a-z0-9_]+$/.test(providerId.trim())) {
      errs.id = "ID 只能包含小写字母、数字和下划线";
    } else if (providerId.trim().length > 64) {
      errs.id = "ID 不能超过 64 个字符";
    }

    // Label
    if (!label.trim()) {
      errs.label = "显示名称为必填";
    } else if (label.trim().length > 100) {
      errs.label = "显示名称不能超过 100 个字符";
    }

    // Base URL
    if (!baseUrl.trim()) {
      errs.base_url = "基础地址为必填";
    } else if (!/^https?:\/\/.+/.test(baseUrl.trim())) {
      errs.base_url = "基础地址必须是有效的 http(s):// URL";
    }

    // API 密钥
    if (!apiKey.trim()) {
      errs.api_key = "API 密钥为必填";
    }

    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit() {
    if (!validate()) return;

    const input: CreateProviderInput = {
      id: providerId.trim(),
      label_zh: label.trim(),
      kind,
      api_type: apiType,
      base_url: baseUrl.trim(),
      api_key: apiKey.trim(),
      model_id: modelId.trim() || undefined,
      anthropic_version: apiType === "anthropic" ? "2023-06-01" : "",
      timeout_ms: timeoutMs,
      max_retries: maxRetries,
      cost_per_1k_tokens_in: costIn,
      cost_per_1k_tokens_out: costOut,
    };

    await onCreate(input);
    reset();
    onOpenChange(false);
  }

  function handleClose(open: boolean) {
    if (!open) reset();
    onOpenChange(open);
  }

  const currentModelPlaceholder = {
    llm: "gpt-4 / claude-3",
    image: "dall-e-3 / sdxl",
    video: "wan2.2-t2v-plus",
    tts: "tts-1 / edge_tts",
  }[kind];

  return (
    // 2026-05-21 迁 BaseDialog 统一架构 — 用户原话"我不是要求组件复用吗?"
    <BaseDialog
      open={open}
      onClose={() => handleClose(false)}
      title="新建 Provider"
      subtitle="填写连接信息以添加自定义 Provider"
      iconName="plus"
      maxWidth={720}
      busy={saving}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={() => handleClose(false)} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" size="lg" onClick={handleSubmit} disabled={saving}>
            {saving ? <Spinner className="h-3.5 w-3.5 mr-1" /> : null}
            创建
          </Button>
        </>
      }
    >
        {/* ── 主表单 2 列网格 ── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-[var(--sp-4)] mt-2">
          {/* ── 左列：标识 / 显示名称 / 类型 / 协议 ── */}
          <div className="space-y-[var(--sp-4)]">
            {/* 标识 */}
            <div>
              <label className="text-[var(--fs-sm)] font-medium text-[var(--ink-700)]">
                标识
              </label>
              <div className="text-[var(--fs-xs)] text-[var(--ink-400)] mb-1">
                根据显示名称自动生成，可手动修改（仅小写字母、数字、下划线）
              </div>
              <Input
                placeholder="例如: my_deepseek_v3"
                value={providerId}
                onChange={(e) => setProviderId(e.target.value.replace(/[^a-z0-9_]/g, "").slice(0, 64))}
                error={!!errors.id}
                className="mt-1 font-mono text-[var(--fs-sm)]"
              />
              {errors.id && (
                <div className="text-[var(--fs-xs)] text-[var(--err)] mt-0.5">{errors.id}</div>
              )}
            </div>

            {/* 显示名称 */}
            <div>
              <label className="text-[var(--fs-sm)] font-medium text-[var(--ink-700)]">
                显示名称 <span className="text-[var(--err)]">*</span>
              </label>
              <div className="text-[var(--fs-xs)] text-[var(--ink-400)] mb-1">
                用户可见的友好名称，用于列表和标签展示
              </div>
              <Input
                placeholder="例如：我的 DeepSeek V3"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                error={!!errors.label}
                className="mt-1"
              />
              {errors.label && (
                <div className="text-[var(--fs-xs)] text-[var(--err)] mt-0.5">{errors.label}</div>
              )}
            </div>

            {/* 类型 */}
            <div>
              <label className="text-[var(--fs-sm)] font-medium text-[var(--ink-700)]">类型</label>
              <div className="text-[var(--fs-xs)] text-[var(--ink-400)] mb-1">
                选择此 Provider 提供的 AI 能力类型
              </div>
              <Select
                value={kind}
                onValueChange={(v) => setKind(v as ProviderKind)}
                options={KIND_OPTIONS.map((k) => ({ value: k.value, label: k.label }))}
                className="mt-1"
              />
            </div>

            {/* 协议 */}
            <div>
              <label className="text-[var(--fs-sm)] font-medium text-[var(--ink-700)]">协议</label>
              <div className="text-[var(--fs-xs)] text-[var(--ink-400)] mb-1">
                API 通信协议，决定请求和响应格式
              </div>
              <Select
                value={apiType}
                onValueChange={(v) => setApiType(v as ApiType)}
                options={API_TYPE_OPTIONS}
                className="mt-1"
              />
            </div>
          </div>

          {/* ── 右列：基础地址 / API 密钥 / 模型标识 ── */}
          <div className="space-y-[var(--sp-4)]">
            {/* 基础地址 */}
            <div>
              <label className="text-[var(--fs-sm)] font-medium text-[var(--ink-700)]">
                基础地址 <span className="text-[var(--err)]">*</span>
              </label>
              <div className="text-[var(--fs-xs)] text-[var(--ink-400)] mb-1">
                API 服务的基础 URL，需以 http(s):// 开头
              </div>
              <Input
                placeholder="https://api.example.com/v1"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                error={!!errors.base_url}
                className="mt-1"
              />
              {errors.base_url && (
                <div className="text-[var(--fs-xs)] text-[var(--err)] mt-0.5">{errors.base_url}</div>
              )}
            </div>

            {/* API 密钥 */}
            <div>
              <label className="text-[var(--fs-sm)] font-medium text-[var(--ink-700)]">
                API 密钥 <span className="text-[var(--err)]">*</span>
              </label>
              <div className="text-[var(--fs-xs)] text-[var(--ink-400)] mb-1">
                用于身份验证的密钥，将加密存储
              </div>
              <div className="flex gap-1 mt-1">
                <Input
                  type={showApiKey ? "text" : "password"}
                  placeholder="sk-..."
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  error={!!errors.api_key}
                  className="flex-1"
                />
                {/* 2026-05-19 铁律 #11: 眼睛切换按钮 — input 旁空间小,用 aria-label + title 即可 */}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  aria-label={showApiKey ? "隐藏 API 密钥" : "显示 API 密钥"}
                  title={showApiKey ? "隐藏 API 密钥" : "显示 API 密钥"}
                >
                  {showApiKey ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                </Button>
              </div>
              {errors.api_key && (
                <div className="text-[var(--fs-xs)] text-[var(--err)] mt-0.5">{errors.api_key}</div>
              )}
            </div>

            {/* 模型标识 */}
            <div>
              <label className="text-[var(--fs-sm)] font-medium text-[var(--ink-700)]">
                模型标识 <span className="text-[var(--ink-400)] font-normal">(可选)</span>
              </label>
              <div className="text-[var(--fs-xs)] text-[var(--ink-400)] mb-1">
                默认调用的模型 ID，留空使用 Provider 默认模型
              </div>
              <Input
                placeholder={currentModelPlaceholder}
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                className="mt-1"
              />
            </div>
          </div>
        </div>

        {/* ── 高级选项（全宽） ── */}
        <div className="mt-[var(--sp-4)]">
          <button
            type="button"
            onClick={() => setAdvancedOpen(!advancedOpen)}
            className="flex items-center gap-1 text-[var(--fs-xs)] font-medium text-[var(--ink-500)] hover:text-[var(--ink-700)]"
          >
            {advancedOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            高级选项
          </button>
          {advancedOpen && (
            <div className="mt-2 space-y-3 p-3 border border-[var(--ink-100)] rounded-[var(--r-lg)]">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[var(--fs-xs)] font-medium text-[var(--ink-500)]">超时 (ms)</label>
                  <div className="text-[var(--fs-xs)] text-[var(--ink-400)] mb-1">单次请求最大等待时间</div>
                  <Input
                    type="number"
                    value={timeoutMs}
                    onChange={(e) => setTimeoutMs(Number(e.target.value))}
                    min={1000}
                    max={300000}
                    className="mt-1"
                  />
                </div>
                <div>
                  <label className="text-[var(--fs-xs)] font-medium text-[var(--ink-500)]">最大重试</label>
                  <div className="text-[var(--fs-xs)] text-[var(--ink-400)] mb-1">失败后自动重试次数</div>
                  <Input
                    type="number"
                    value={maxRetries}
                    onChange={(e) => setMaxRetries(Number(e.target.value))}
                    min={0}
                    max={10}
                    className="mt-1"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[var(--fs-xs)] font-medium text-[var(--ink-500)]">输入 $/1K tokens</label>
                  <div className="text-[var(--fs-xs)] text-[var(--ink-400)] mb-1">输入 token 单价</div>
                  <Input
                    type="number"
                    value={costIn}
                    onChange={(e) => setCostIn(Number(e.target.value))}
                    min={0}
                    step={0.001}
                    className="mt-1"
                  />
                </div>
                <div>
                  <label className="text-[var(--fs-xs)] font-medium text-[var(--ink-500)]">输出 $/1K tokens</label>
                  <div className="text-[var(--fs-xs)] text-[var(--ink-400)] mb-1">输出 token 单价</div>
                  <Input
                    type="number"
                    value={costOut}
                    onChange={(e) => setCostOut(Number(e.target.value))}
                    min={0}
                    step={0.001}
                    className="mt-1"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Actions 已迁到 BaseDialog footer slot (顶部 props) */}
    </BaseDialog>
  );
}
