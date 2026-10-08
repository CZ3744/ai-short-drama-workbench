// ModelPicker — 通用模型选择器 (cc-switch 风格, 解耦设计).
//
// 设计原则:
//   1. 无状态、0 业务知识. 不知道选择存给谁 (Shot / Episode / Generation), 父调用方决定.
//   2. value 格式: "<instance_id>:<model>" 或纯 instance_id.
//      null = 未选, 显示 placeholder.
//   3. 限定 modality (kind), 决定下拉列哪个桶的 provider.
//   4. 禁用 instance 不出现; 没有任何可用 provider 时显示"去设置"引导.
//   5. 沿用 v24 视觉 (chip 风格), 不引新设计.
//
// 数据源: GET /api/v2/providers (builtin + custom 合并), 由 useUserProviders hook 拉.
//
// 历史: 2026-05-13 v4 13-kind ProviderInstance schema 实验已搬走 (.trash/v4-experiment).
//       2026-05-15 W3-B T3: 加 tts kind, 让 ComposePage 也走 ModelPicker (替换 deprecated ModelProviderSelect).
//       2026-05-19 #15: 全项目下拉改用 ui/select 统一 (Radix 内核), 不再写 native <select>.
//                       同时修了用户反馈 #7 "左半边空 / 右半边挤" — 现在是单行 chip 一整条.
//
// 红线 (CLAUDE.md):
//   - 不在 ModelPicker 内部写"业务默认"逻辑, 不知道 Shot/Episode 等概念
//   - 不引新 npm 依赖, 仅靠现有 useSWR / sonner / Icon
//   - 用户未配 provider → "去设置", 不塞 mock 数据
//   - onChange 主动调 rememberLastUsed 记忆用户偏好 (lastUsedModel.ts)

import { useNavigate } from "react-router-dom";
import { Icon } from "../shared/Icon";
import { Select, type SelectOption } from "../ui/select";
import { useUserProviders, type UserProvider } from "../../hooks/useUserProviders";
import { rememberLastUsed } from "../../lib/lastUsedModel";

// ─── model_ref 解析 helpers ─────────────────────────────────────────
// 本地工具函数. value 格式 "<instance_id>:<model>" — 拆出 instance_id (用于查 provider 配置)
// 和 model (可覆盖 provider 自带 model). 4 行 helper 避开 vite alias 配置.

function parseModelRef(ref: string | null | undefined): { instance_id: string; model: string } | null {
  if (!ref) return null;
  const idx = ref.indexOf(":");
  if (idx < 0) return { instance_id: ref, model: "" };
  return { instance_id: ref.slice(0, idx), model: ref.slice(idx + 1) };
}

function buildModelRef(instance_id: string, model: string): string {
  return `${instance_id}:${model}`;
}

export interface ModelPickerProps {
  /** 限定 modality, 决定下拉里只列哪个桶的 provider. */
  kind: "text" | "image" | "video" | "tts";
  /** 当前选中. 格式: "<instance_id>:<model>". null = 未选. */
  value: string | null;
  /** 用户选了, 由调用方决定存哪. value=null 表示用户清空 (目前 ModelPicker 不主动发 null, 留作未来). */
  onChange: (value: string | null) => void;
  /** placeholder. 默认 "选择模型...". */
  placeholder?: string;
  /** 禁用. 父业务实体已锁定时传 true. */
  disabled?: boolean;
  /** 紧凑模式. 分镜卡上塞小尺寸用 "sm", 一般表单用 "md". */
  size?: "sm" | "md";
  /** 父调用方自定义 className. */
  className?: string;
}

const KIND_LABEL: Record<"text" | "image" | "video" | "tts", string> = {
  text: "LLM",
  image: "图像",
  video: "视频",
  tts: "TTS",
};

/**
 * 把 instance 转成下拉选项 label.
 *   "MiMo Pro · mimo-v2.5-pro"
 *   未配 Key: "MiMo Pro · mimo-v2.5-pro · 未配 Key"
 */
function formatOptionLabel(p: UserProvider): string {
  const base = p.model ? `${p.label} · ${p.model}` : p.label;
  return p.key_present ? base : `${base} · 未配 Key`;
}

/**
 * 视频桶的渠道顺序 — 用户自定义渠道 (可灵/Vidu/即梦/海螺/万相) 优先, 内置 / 本地 / Mock 在后.
 * 2026-05-19: 渠道顺序原本只用于视频桶 <optgroup>, 现在归到 buildOptions 内排序.
 */
const VIDEO_GROUP_ORDER = ["可灵 AI", "Vidu", "即梦 (火山)", "MiniMax 海螺", "阿里万相", "本地与 Mock", "其他云服务", "其他"];

/**
 * 把 UserProvider[] 转成 SelectOption[]. 视频桶按渠道排序, 其他扁平.
 * 视频桶: option.group = 渠道名, Select 组件自动按 group 渲染二级菜单.
 */
function buildOptions(list: UserProvider[], kind: ModelPickerProps["kind"]): SelectOption[] {
  if (kind !== "video") {
    return list.map((p) => ({
      value: p.id,
      label: formatOptionLabel(p),
    }));
  }
  // 视频: 按 group 字段分类 + 按 VIDEO_GROUP_ORDER 排序
  const groupIndex = (g: string) => {
    const idx = VIDEO_GROUP_ORDER.indexOf(g);
    return idx >= 0 ? idx : 999;
  };
  return list
    .slice()
    .sort((a, b) => {
      const ag = (a.group?.trim() || "其他");
      const bg = (b.group?.trim() || "其他");
      const ai = groupIndex(ag);
      const bi = groupIndex(bg);
      if (ai !== bi) return ai - bi;
      // 同组按 label 字母序稳定
      return a.label.localeCompare(b.label);
    })
    .map((p) => ({
      value: p.id,
      label: formatOptionLabel(p),
      group: p.group?.trim() || "其他",
    }));
}

export function ModelPicker(props: ModelPickerProps) {
  const { kind, value, onChange, placeholder = "选择模型...", disabled, size = "md", className } = props;
  const navigate = useNavigate();
  const { providers, isLoading } = useUserProviders();

  // 只列启用的实例.
  const list: UserProvider[] = providers[kind].filter((p) => p.enabled);

  // 解析当前 value → instance.
  const parsed = parseModelRef(value);
  const currentInstance = parsed ? list.find((p) => p.id === parsed.instance_id) : null;

  // 没有任何启用的 provider → 引导去设置.
  const empty = !isLoading && list.length === 0;

  function handleChange(rawId: string) {
    if (rawId === "__goto_settings__") {
      navigate("/settings");
      return;
    }
    const picked = list.find((p) => p.id === rawId);
    if (!picked) return;
    const model = picked.model || ""; // 没默认 model 也允许, 后端会用 instance.model
    const next = buildModelRef(picked.id, model);
    rememberLastUsed(kind, next);
    onChange(next);
  }

  // 构造 options: 没 provider 时给"去设置"占位; 否则按 kind buildOptions.
  const options: SelectOption[] = empty
    ? [{ value: "__goto_settings__", label: "尚未配置模型 · 去设置" }]
    : buildOptions(list, kind);

  // 收起态显示的 label — 让 Radix 自己根据 value 显示, 但当 value 不在 options 里
  // (例如 provider 被禁用了) 时,我们传 placeholder 让它显示占位文字.
  // value 必须是 options 中的某个 value 才会高亮选中.
  const triggerValue = currentInstance ? currentInstance.id : null;

  return (
    <Select
      value={triggerValue}
      onChange={handleChange}
      options={options}
      placeholder={placeholder}
      disabled={disabled || isLoading}
      size={size}
      prefix={KIND_LABEL[kind]}
      icon={<Icon name="bolt" size={size === "sm" ? 11 : 13} />}
      ariaLabel={`${KIND_LABEL[kind]} 模型选择`}
      maxWidth={size === "sm" ? 280 : 360}
      className={className}
    />
  );
}

// ─── 旧 ModelOption-based API (deprecated, 仅历史保留) ─────────────────
//
// 旧 ModelPicker 接 { value, options, onChange } 这套 ad-hoc 接口被 Settings 的内部
// 路由表 (RoutingTable) 等少数地方用过. 改造主链路时统一往 v4 schema 走. 这里
// 不再 export 旧接口, 若发现历史 import 报错, 把它们迁到新签名或直接用 Select.
//
// 历史 ModelOption / 旧 props 已彻底移除. 找到引用请改用新签名 (kind + value + onChange).
