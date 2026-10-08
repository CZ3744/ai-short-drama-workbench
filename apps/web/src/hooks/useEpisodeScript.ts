import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { apiGet, apiPatch, apiPost } from "../lib/api";
import { createScriptSaveQueue } from "../lib/scriptSaveQueue";
import { showErrorToast, translateError } from "../lib/errorTranslate";

export interface EpisodeVersion {
  version: number;
  created_at: string;
  source: "ai_init" | "user_edit" | "ai_revise" | "revert";
  summary?: string;
  script_md: string;
}

export interface EpisodeData {
  id: string;
  series_slug: string;
  title: string;
  script_md?: string;
  version?: number;
  versions?: EpisodeVersion[];
  overrides?: Record<string, string>;
  status: string;
  target_duration_sec?: number;
  target_shot_count?: number;
}

interface UseEpisodeScriptResult {
  episode: EpisodeData | null;
  loading: boolean;
  error: string | null;
  localContent: string;
  setLocalContent: (content: string) => void;
  dirty: boolean;
  /** Resolves only once all current edits are persisted; rejects on failure. */
  save: () => Promise<void>;
  saving: boolean;
  saveError: string | null;
  recoveryContent: string | null;
  restoreRecovery: () => void;
  discardRecovery: () => void;
  reload: () => Promise<void>;
}

interface SeriesScriptPayload {
  script: {
    series_slug: string;
    title: string;
    script_md?: string;
    version?: number;
    versions?: EpisodeVersion[];
    updated_at?: string;
  };
}

type ScriptPayload = SeriesScriptPayload | { episode: EpisodeData };
const AUTOSAVE_INTERVAL_MS = 5000;

function episodeFromPayload(payload: ScriptPayload): EpisodeData {
  if ("episode" in payload) return payload.episode;
  return {
    ...payload.script,
    id: "series",
    title: payload.script.title || "系列剧本",
    script_md: payload.script.script_md || "",
    status: payload.script.script_md ? "scripting" : "draft",
  };
}

/** Shared persistence for series and episode editors, scoped to the exact document. */
function useScriptDocument(slug: string, epId?: string): UseEpisodeScriptResult {
  const [episode, setEpisode] = useState<EpisodeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recoveryContent, setRecoveryContent] = useState<string | null>(null);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const activeSession = useRef<object | null>(null);
  const path = `/api/v2/series/${encodeURIComponent(slug)}${epId ? `/episodes/${encodeURIComponent(epId)}` : "/script"}`;

  const session = useMemo(() => {
    const owner = { loaded: false, request: 0 };
    const draftKey = `video-generate.script-draft:${path}`;
    const queue = createScriptSaveQueue({
      persist: (content) => apiPatch<ScriptPayload>(path, { script_md: content }),
      onChange: () => {
        // This tab retains failed/in-flight edits even if the creator changes pages.
        // Never automatically overwrite a server script with a recovered draft.
        if (owner.loaded) {
          try {
            if (queue.dirty) sessionStorage.setItem(draftKey, JSON.stringify({ content: queue.content }));
            else if (!queue.saving) sessionStorage.removeItem(draftKey);
          } catch { /* A full/disabled browser store must not stop server saving. */ }
        }
        if (activeSession.current === owner) redraw();
      },
      onSaved: (result, content, previous) => {
        if (activeSession.current === owner) setEpisode(episodeFromPayload(result));
        if (previous && previous !== content) {
          void apiPost(`/api/v2/series/${encodeURIComponent(slug)}/script-edit`, {
            old_content: previous,
            new_content: content,
            episode_id: epId || "series",
          }).catch((cause) => console.warn("[script] 编辑偏好记录失败", cause));
        }
      },
    });
    return { owner, queue, draftKey };
  }, [path, slug, epId]);
  activeSession.current = session.owner;

  const reload = useCallback(async () => {
    const request = ++session.owner.request;
    const isCurrent = () => activeSession.current === session.owner && request === session.owner.request;
    setLoading(true);
    setError(null);
    try {
      if (!slug) {
        session.queue.load("");
        setEpisode(null);
        return;
      }
      const data = await apiGet<ScriptPayload>(path);
      if (!isCurrent()) return;
      const next = episodeFromPayload(data);
      let recovered: string | null = null;
      try {
        const stored = JSON.parse(sessionStorage.getItem(session.draftKey) || "null");
        if (stored && typeof stored.content === "string" && stored.content !== (next.script_md || "")) recovered = stored.content;
        else sessionStorage.removeItem(session.draftKey);
      } catch { /* Malformed recovery data cannot replace the server content. */ }
      session.owner.loaded = false;
      session.queue.load(next.script_md || "");
      setRecoveryContent(recovered);
      setEpisode(next);
    } catch (cause) {
      if (!isCurrent()) return;
      // A missing document is different from an empty script; keep a retryable error.
      setError(translateError(cause));
    } finally {
      if (isCurrent()) {
        session.owner.loaded = true;
        setLoading(false);
      }
    }
  }, [path, slug, session]);

  useEffect(() => {
    activeSession.current = session.owner;
    void reload();
    return () => {
      ++session.owner.request;
      if (activeSession.current === session.owner) activeSession.current = null;
      // Join an in-flight save instead of issuing a second, potentially out-of-order PATCH.
      void session.queue.save().catch((cause) => {
        showErrorToast(cause, "剧本保存未完成，请返回剧本页检查内容");
      });
    };
  }, [reload, session]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (!document.hidden) void session.queue.save().catch(() => { /* Persistent inline error + retry. */ });
    }, AUTOSAVE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [session]);

  const setLocalContent = useCallback((content: string) => session.queue.edit(content), [session]);
  const save = useCallback(() => session.queue.save(), [session]);
  const discardRecovery = useCallback(() => {
    try { sessionStorage.removeItem(session.draftKey); } catch { /* Browser storage may be disabled. */ }
    setRecoveryContent(null);
  }, [session]);
  const restoreRecovery = useCallback(() => {
    if (recoveryContent !== null) session.queue.edit(recoveryContent);
    setRecoveryContent(null);
  }, [recoveryContent, session]);
  return {
    episode,
    loading: loading || !session.owner.loaded,
    error,
    localContent: session.queue.content,
    setLocalContent,
    dirty: session.queue.dirty,
    save,
    saving: session.queue.saving,
    saveError: session.queue.error ? translateError(session.queue.error) : null,
    recoveryContent,
    restoreRecovery,
    discardRecovery,
    reload,
  };
}

export function useEpisodeScript(slug: string, epId: string): UseEpisodeScriptResult {
  return useScriptDocument(slug, epId);
}

export function useSeriesScript(slug: string): UseEpisodeScriptResult {
  return useScriptDocument(slug);
}
