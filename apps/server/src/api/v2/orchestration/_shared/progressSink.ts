/**
 * Progress sink abstraction for application use cases.
 *
 * Keeps use cases independent from Express responses while preserving the
 * legacy res-based SSE behavior underneath.
 */

import { sseProgress } from "./sse";

export interface ProgressSink {
  progress(stage: string, data?: Record<string, unknown>): void;
}

export function makeResProgressSink(res: any): ProgressSink {
  return {
    progress(stage, data = {}) {
      sseProgress(res, stage, data);
    },
  };
}
