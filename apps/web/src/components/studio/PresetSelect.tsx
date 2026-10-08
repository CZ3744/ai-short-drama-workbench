import { useState, useEffect } from "react";
import { Select } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { cn } from "../../lib/cn";
import { apiGet } from "../../lib/api";

export interface PresetSelectProps {
  dictId: string;
  /** 附加查询参数，如 "provider=edge_tts"，拼接到请求 URL */
  query?: string;
  value?: string;
  /** Label for a valid saved value absent from the current dictionary. */
  currentValueLabel?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  error?: boolean;
  className?: string;
}

/**
 * 自动从 /api/v2/presets/<dictId> 加载 options 的下拉。
 * 支持中文长选项。
 */
export function PresetSelect({
  dictId,
  query,
  value,
  currentValueLabel,
  onValueChange,
  placeholder = "请选择...",
  disabled,
  error,
  className,
}: PresetSelectProps) {
  const [options, setOptions] = useState<{ value: string; label: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    const url = query ? `/api/v2/presets/${dictId}?${query}` : `/api/v2/presets/${dictId}`;
    // B19: 使用 apiGet 统一超时(DEFAULT_TIMEOUT_MS=15s)+错误格式化
    apiGet<any>(url)
      .then((data) => {
        if (cancelled) return;
        // 后端返回 {dict_id, options:[{id, label_zh, label_en, enabled, ...}]}
        const items = Array.isArray(data) ? data : (data.options ?? data.items ?? []);
        setOptions(
          items
            .filter((it: any) => it.enabled !== false)
            .map((it: any) => ({
              value: String(it.id ?? it.value),
              label: it.label_zh ?? it.name ?? it.label ?? String(it.id),
            }))
        );
      })
      .catch((e: any) => {
        if (!cancelled) setLoadError(e.message ?? "加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [dictId, query]);

  if (loading) return <Spinner size="sm" label="加载中..." className={className} />;
  if (loadError) return <span className={cn("text-[var(--fs-sm)] text-[var(--err)]", className)}>加载失败: {loadError}</span>;

  return (
    <Select
      value={value}
      onValueChange={onValueChange}
      placeholder={placeholder}
      disabled={disabled || loading}
      error={error}
      options={value && currentValueLabel && !options.some((option) => option.value === value)
        ? [{ value, label: currentValueLabel }, ...options]
        : options}
      className={className}
    />
  );
}
