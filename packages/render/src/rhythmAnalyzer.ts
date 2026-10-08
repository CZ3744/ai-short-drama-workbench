// T09: Auto-editing rhythm analyzer — duration estimation, importance scoring, rhythm reports

export interface RhythmShot {
  scene_id: string;
  scene_title: string;
  narration_text: string;
  duration_sec: number;
  visual_type: string;
  has_dialog: boolean;
  keywords: string[];
}

export interface RhythmReport {
  total_duration_sec: number;
  shot_count: number;
  average_shot_duration: number;
  shots: Array<RhythmShot & {
    importance_score: number;
    rhythm_label: "too_short" | "ok" | "too_long";
    warnings: string[];
  }>;
  summary: {
    too_short_count: number;
    too_long_count: number;
    ok_count: number;
    dialog_shots: number;
    dialog_avg_duration: number;
  };
  recommendations: string[];
}

const MIN_SHOT_DURATION = 3;
const MAX_SHOT_DURATION = 60;
const DIALOG_MIN_DURATION = 4;

export function scoreImportance(shot: RhythmShot): number {
  let score = 5;
  score += shot.keywords.length * 0.5;
  if (shot.has_dialog) score += 2;
  if (shot.narration_text.length > 100) score += 1;
  if (shot.narration_text.length > 300) score += 1;
  if (shot.visual_type === "title_card") score += 3;
  if (shot.visual_type === "diagram") score += 1;
  return Math.min(10, score);
}

export function analyzeRhythm(shots: RhythmShot[]): RhythmReport {
  const analyzed = shots.map(shot => {
    const importance = scoreImportance(shot);
    const warnings: string[] = [];

    let rhythmLabel: "too_short" | "ok" | "too_long" = "ok";
    if (shot.duration_sec < MIN_SHOT_DURATION) {
      rhythmLabel = "too_short";
      warnings.push(`分镜只有 ${shot.duration_sec}s，建议至少 ${MIN_SHOT_DURATION}s`);
    } else if (shot.duration_sec > MAX_SHOT_DURATION) {
      rhythmLabel = "too_long";
      warnings.push(`分镜 ${shot.duration_sec}s 过长，建议拆分或缩短`);
    }

    if (shot.has_dialog && shot.duration_sec < DIALOG_MIN_DURATION) {
      warnings.push(`对白镜只有 ${shot.duration_sec}s 太赶，建议 ≥ ${DIALOG_MIN_DURATION}s`);
    }

    if (importance >= 7 && shot.duration_sec < 5) {
      warnings.push(`重要分镜（重要性 ${importance.toFixed(1)}）时长偏短，建议延长`);
    }

    return { ...shot, importance_score: importance, rhythm_label: rhythmLabel, warnings };
  });

  const totalDuration = analyzed.reduce((sum, s) => sum + s.duration_sec, 0);
  const tooShort = analyzed.filter(s => s.rhythm_label === "too_short").length;
  const tooLong = analyzed.filter(s => s.rhythm_label === "too_long").length;
  const ok = analyzed.filter(s => s.rhythm_label === "ok").length;
  const dialogShots = analyzed.filter(s => s.has_dialog);
  const dialogAvg = dialogShots.length > 0 ? dialogShots.reduce((sum, s) => sum + s.duration_sec, 0) / dialogShots.length : 0;

  const recommendations: string[] = [];
  if (tooShort > shots.length * 0.3) recommendations.push("超过 30% 的分镜时间偏短，建议合并相邻短镜");
  if (tooLong > 0) recommendations.push(`${tooLong} 个分镜时间过长，建议拆分`);
  if (dialogAvg < DIALOG_MIN_DURATION) recommendations.push(`对白镜平均 ${dialogAvg.toFixed(1)}s，偏短`);
  if (totalDuration > 600) recommendations.push(`总时长 ${totalDuration}s（${Math.floor(totalDuration / 60)} 分钟），注意平台时长限制`);

  return {
    total_duration_sec: totalDuration,
    shot_count: shots.length,
    average_shot_duration: shots.length > 0 ? totalDuration / shots.length : 0,
    shots: analyzed,
    summary: {
      too_short_count: tooShort,
      too_long_count: tooLong,
      ok_count: ok,
      dialog_shots: dialogShots.length,
      dialog_avg_duration: dialogAvg,
    },
    recommendations,
  };
}

/** Compress to target duration by removing lowest-importance shots */
export function compressToTarget(shots: RhythmShot[], targetSec: number): {
  kept: RhythmShot[];
  removed: RhythmShot[];
  final_duration: number;
  within_tolerance: boolean;
} {
  const scored = shots.map(s => ({ ...s, importance_score: scoreImportance(s) }));
  // Sort by importance ascending (least important first)
  const sorted = [...scored].sort((a, b) => a.importance_score - b.importance_score);

  let currentDuration = scored.reduce((sum, s) => sum + s.duration_sec, 0);
  const removed: RhythmShot[] = [];

  for (const shot of sorted) {
    if (currentDuration <= targetSec) break;
    if (removed.length >= scored.length - 2) break; // keep at least 2 shots
    currentDuration -= shot.duration_sec;
    removed.push(shot);
  }

  const keptIds = new Set(scored.filter(s => !removed.find(r => r.scene_id === s.scene_id)).map(s => s.scene_id));
  const kept = shots.filter(s => keptIds.has(s.scene_id));

  return {
    kept,
    removed,
    final_duration: currentDuration,
    within_tolerance: Math.abs(currentDuration - targetSec) <= 2,
  };
}

/** Align cuts to narration: cut after each narration segment */
export function alignCutsToNarration(shots: RhythmShot[]): Array<{
  shot: RhythmShot;
  cut_after_sec: number;
  narration_ends_at_word: number;
}> {
  return shots.map(shot => {
    const wordCount = shot.narration_text.length;
    const wordsPerSec = wordCount / Math.max(shot.duration_sec, 1);
    return {
      shot,
      cut_after_sec: shot.duration_sec,
      narration_ends_at_word: wordCount,
    };
  });
}
