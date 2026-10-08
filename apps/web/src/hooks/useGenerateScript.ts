import { useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { apiPost } from "../lib/api";
import { ROUTES } from "../lib/routes";
import { showErrorToast } from "../lib/errorTranslate";
import { useInboxStore, type CreationSettings } from "./useSeriesDefaults";
import { useTasksStore } from "../stores/tasksStore";

interface ExpandScriptBody {
  raw_inspiration: string;
  overrides: Record<string, unknown>;
  title?: string;
  file_texts?: string[];
}

interface ExpandScriptResult {
  ok: boolean;
  episode_id?: string;
  script_id?: string;
  script: unknown;
  message?: string;
}

export function useGenerateScript(slug: string) {
  const navigate = useNavigate();
  const setGenerating = useInboxStore((s) => s.setGenerating);
  const upsertEvent = useTasksStore((s) => s.upsertEvent);
  const abortRef = useRef<AbortController | null>(null);

  // 2026-05-18: unmount cleanup — 用户在扩写进行中切走页面, AbortController 必须被 abort,
  // 否则 fetch 继续跑, 响应回来后在已 unmount 组件 / 已销毁 store 子树上 setState (React 警告 + 脏写 store).
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const trigger = useCallback(
    async (params: {
      raw_inspiration: string;
      overrides: Partial<CreationSettings>;
      title?: string;
      file_texts?: string[];
    }) => {
      setGenerating(true);
      abortRef.current = new AbortController();

      try {
        const body: ExpandScriptBody = {
          raw_inspiration: params.raw_inspiration,
          overrides: params.overrides as Record<string, unknown>,
        };
        if (params.title) body.title = params.title;
        if (params.file_texts?.length) body.file_texts = params.file_texts;

        upsertEvent({
          jobId: `inbox-${slug}`,
          stage: "expand_script",
          progress: 0,
          status: "running",
          message: "AI 正在理解你的灵感...",
          timestamp: Date.now(),
        });

        const result = await apiPost<ExpandScriptResult>(
          `/api/v2/series/${slug}/expand-script`,
          body
        );

        upsertEvent({
          jobId: `inbox-${slug}`,
          stage: "expand_script",
          progress: 100,
          status: "completed",
          message: "剧本生成完成",
          timestamp: Date.now(),
        });

        toast.success("剧本已就绪", {
          description: "可在剧本 Canvas 查看或编辑",
          action: {
            label: "立即查看",
            onClick: () => navigate(ROUTES.script(slug)),
          },
          duration: 8000,
        });

        return result;
      } catch (err: any) {
        upsertEvent({
          jobId: `inbox-${slug}`,
          stage: "expand_script",
          progress: 0,
          status: "failed",
          message: err.message || "生成失败",
          timestamp: Date.now(),
        });
        showErrorToast(err, "剧本生成失败");
        throw err;
      } finally {
        setGenerating(false);
        abortRef.current = null;
      }
    },
    [slug, navigate, setGenerating, upsertEvent]
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setGenerating(false);
  }, [setGenerating]);

  return { trigger, cancel };
}
