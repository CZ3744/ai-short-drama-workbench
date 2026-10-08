import { sseBroker } from "../../api/v2/sseBroker";
import { updateTaskRecord } from "../../api/v2/seriesStore";
import { ProviderError } from "../../../../../packages/providers/src/core/index";
import type { ProgressSink } from "../../api/v2/orchestration/_shared/progressSink";

import { prepareCompose } from "./prepare";
import type { ComposeContext } from "./prepare";
import { runTtsPhase } from "./tts";
import { runConcatPhase } from "./ffmpegBuilder";
import { runRenderPhase } from "./render";

export type ComposeEpisodeResult =
  | { kind: "validation"; status: number; errors: Array<{ path: string; message: string }> }
  | { kind: "error"; status: number; body: Record<string, unknown> }
  | { kind: "json"; body: Record<string, unknown> };

export interface ComposeEpisodeInput {
  slug: string;
  episodeId: string;
  body: unknown;
}

export interface RequestLog {
  info: (obj: Record<string, unknown>, message: string) => void;
}

export interface ComposeEpisodeDeps {
  progress: ProgressSink;
  requestLog?: RequestLog;
  /** Optional AbortSignal — for compose task/user abort. */
  signal?: AbortSignal;
  /** R1: when compose is queued by POST /compose, reuse the pre-created task ids. */
  taskContext?: {
    job_id: string;
    task_id: string;
  };
}

/**
 * Compose episode: 4-stage pipeline —
 *   prepare → tts → concat/build → render
 */
export async function composeEpisode(
  input: ComposeEpisodeInput,
  deps: ComposeEpisodeDeps,
): Promise<ComposeEpisodeResult> {
  let ctx: ComposeContext | null = null;
  try {
    const prepared = await prepareCompose(input, deps);
    // Early return for validation error / empty shots / quick local preview
    if (prepared.kind !== "context") return prepared;
    ctx = prepared.ctx;

    await runTtsPhase(ctx, deps);
    await runConcatPhase(ctx, deps);
    return await runRenderPhase(ctx, deps);
  } catch (err: unknown) {
    sseBroker.emit({
      type: "compose.error",
      job_id: ctx?.job_id || `compose_err_${Date.now().toString(36)}`,
      data: { error: err instanceof Error ? err.message : String(err) },
      at: new Date().toISOString(),
    });
    if (ctx?.taskId) {
      updateTaskRecord(ctx.taskId, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    throw err;
  }
}

export function isComposeRateLimitError(err: unknown): err is ProviderError {
  return err instanceof ProviderError && err.code === "rate_limit";
}
