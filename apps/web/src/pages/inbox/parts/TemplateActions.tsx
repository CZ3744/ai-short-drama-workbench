import { useState, useCallback } from "react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { BaseDialog } from "../../../components/ui/BaseDialog";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "../../../components/ui/popover";
import { useInboxStore, type CreationSettings } from "../../../hooks/useSeriesDefaults";
import { useAsyncAction } from "../../../hooks/useAsyncAction";
import { apiGet, apiPost } from "../../../lib/api";
import { toast } from "sonner";
import { cn } from "../../../lib/cn";
import { Bookmark, FolderOpen, Check } from "../../../components/shared/LucideIcon";
import useSWR from "swr";

interface Template {
  id: string;
  name: string;
  settings: Partial<CreationSettings>;
  created_at: string;
}

const BUILTIN_TEMPLATES = [
  {
    id: "sweet_drama_3ep",
    label: "3 分钟甜宠短剧",
    inspiration: "现代都市...女主是插画师...男主是程序员...因为一只猫相遇...",
    settings: { content_type: "anime_drama", platform: "douyin" },
  },
  {
    id: "knowledge_60s",
    label: "1 分钟知识科普",
    inspiration: "用通俗易懂的方式解释一个科学概念...",
    settings: { content_type: "knowledge", platform: "bilibili" },
  },
  {
    id: "product_30s",
    label: "30 秒产品展示",
    inspiration: "展示一款产品的核心卖点和使用场景...",
    settings: { content_type: "promo", platform: "douyin" },
  },
];

export function TemplateActions({ slug, className }: { slug: string; className?: string }) {
  // W8-sweep (2026-05-16): 单字段 selector — 避免 zustand 反模式 (CLAUDE.md 陷阱 §1)
  const settings = useInboxStore((s) => s.settings);
  const batchUpdateSettings = useInboxStore((s) => s.batchUpdateSettings);
  const currentTemplateName = useInboxStore((s) => s.currentTemplateName);
  const setCurrentTemplateName = useInboxStore((s) => s.setCurrentTemplateName);
  const setInspiration = useInboxStore((s) => s.setInspiration);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");

  // 加载模板列表
  const { data: templatesData, mutate: refreshTemplates } = useSWR(
    `/api/v2/templates`,
    (url) => apiGet<{ templates: Template[] }>(url),
    { revalidateOnFocus: false }
  );

  const templates = templatesData?.templates ?? [];

  // 套用模板
  const handleApplyTemplate = useCallback(
    (template: Template) => {
      batchUpdateSettings(template.settings);
      setCurrentTemplateName(template.name);
      toast.success(`已套用模板 "${template.name}"`);
    },
    [batchUpdateSettings, setCurrentTemplateName]
  );

  // 套用内置模板
  const applyTemplate = useCallback(
    (t: typeof BUILTIN_TEMPLATES[number]) => {
      setInspiration(t.inspiration);
      batchUpdateSettings(t.settings as Partial<CreationSettings>);
      setCurrentTemplateName(t.label);
      toast.success(`已套用内置模板 "${t.label}"`);
    },
    [setInspiration, batchUpdateSettings, setCurrentTemplateName]
  );

  // 保存为模板 (useAsyncAction 接管 busy/error,统一走 showErrorToast 链路)
  const saveTemplateAction = useAsyncAction(
    async () =>
      apiPost(`/api/v2/templates`, {
        name: templateName.trim(),
        source_series_slug: slug,
        settings: { ...settings },
      }),
    {
      errorMessage: "保存失败",
      onSuccess: () => {
        toast.success(`模板 "${templateName.trim()}" 已保存`);
        setCurrentTemplateName(templateName.trim());
        setSaveDialogOpen(false);
        setTemplateName("");
        refreshTemplates();
      },
    },
  );
  const saving = saveTemplateAction.busy;
  const handleSaveTemplate = useCallback(() => {
    if (!templateName.trim()) {
      toast.error("请输入模板名称");
      return;
    }
    void saveTemplateAction.run();
  }, [templateName, saveTemplateAction]);

  return (
    <div className={cn("space-y-[var(--sp-3)]", className)}>
      {/* 内置模板 */}
      <div className="space-y-1.5">
        <span className="text-[var(--fs-xs)] text-[var(--ink-400)]">内置模板</span>
        <div className="flex gap-2 flex-wrap">
          {BUILTIN_TEMPLATES.map((t) => (
            <button
              key={t.id}
              onClick={() => applyTemplate(t)}
              className={cn(
                "px-3 py-1.5 text-[var(--fs-sm)] rounded-full border border-[var(--ink-200)]",
                "hover:border-[var(--brand-300)] hover:bg-[var(--brand-50)] transition-colors",
                currentTemplateName === t.label && "bg-[var(--brand-50)] border-[var(--brand-300)] text-[var(--brand-600)]"
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* 套用历史模板 */}
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="w-full justify-start gap-2">
            <FolderOpen className="h-4 w-4" />
            套用历史模板
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 max-h-[300px] overflow-y-auto">
          {templates.length === 0 ? (
            <p className="text-[var(--fs-sm)] text-[var(--ink-400)] py-2">暂无模板</p>
          ) : (
            <div className="space-y-1">
              {templates.map((t) => (
                <button
                  key={t.id}
                  onClick={() => handleApplyTemplate(t)}
                  className={cn(
                    "w-full text-left px-3 py-2 rounded-[var(--r-md)] text-[var(--fs-sm)] transition-colors",
                    "hover:bg-[var(--surface-muted)] flex items-center gap-2",
                    currentTemplateName === t.name && "bg-[var(--brand-50)] text-[var(--brand-600)]"
                  )}
                >
                  {currentTemplateName === t.name && <Check className="h-3.5 w-3.5 shrink-0" />}
                  <span className="truncate">{t.name}</span>
                </button>
              ))}
            </div>
          )}
        </PopoverContent>
      </Popover>

      {/* 保存当前设置为模板 — 2026-05-21 迁 BaseDialog 统一架构 */}
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start gap-2"
        onClick={() => setSaveDialogOpen(true)}
      >
        <Bookmark className="h-4 w-4" />
        保存当前设置为模板
      </Button>
      <BaseDialog
        open={saveDialogOpen}
        onClose={() => setSaveDialogOpen(false)}
        title="保存为模板"
        subtitle="将当前创作设置保存为模板,方便下次快速套用。"
        iconName="bookmark"
        maxWidth={460}
        busy={saving}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setSaveDialogOpen(false)} disabled={saving}>
              取消
            </Button>
            <Button variant="primary" size="sm" onClick={handleSaveTemplate} loading={saving}>
              保存
            </Button>
          </>
        }
      >
        <Input
          placeholder="模板名称"
          value={templateName}
          onChange={(e) => setTemplateName(e.target.value)}
          autoFocus
        />
      </BaseDialog>

      {/* 当前模板 chip */}
      {currentTemplateName && (
        <div className="flex items-center gap-1.5 rounded-full bg-[var(--brand-50)] border border-[var(--brand-200)] px-3 py-1.5 text-[var(--fs-xs)] text-[var(--brand-600)]">
          <Check className="h-3 w-3" />
          <span>当前模板: {currentTemplateName}</span>
          <Button
            variant="ghost"
            size="xs"
            iconLeft="close"
            className="ml-1"
            aria-label="清除模板"
            onClick={() => setCurrentTemplateName(null)}
          >
            清除
          </Button>
        </div>
      )}
    </div>
  );
}
