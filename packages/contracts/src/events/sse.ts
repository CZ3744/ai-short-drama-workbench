export type SseEventType =
  | "task.queued"
  | "task.running"
  | "task.done"
  | "task.failed"
  | "compose.stage"            // P170 1B: compose 阶段推进
  | "compose.progress"         // P170 1B: compose 百分比进度
  | "compose.done"             // P170 1B: compose 完成
  | "compose.error"            // P170 1B: compose 失败
  // 2026-05-29 E-03: compose 子阶段 (compose.shot / compose.start / compose.rough.done /
  // compose.concat / compose.quick_preview.done / compose.audio_track / compose.audio_mix /
  // compose.burning / compose.burned 等) — 消除 _shared/sse.ts as 强转
  | `compose.${string}`
  | "shot.updated"
  | "provider.fallback"  // P5B: provider fallback event
  | "shot.quality_warning"     // B3: CLIP quality warning
  | "shot.continuity_warning"  // B3: visual continuity warning
  | "pending_job.progress"     // v24-batch-all: 单镜生成/视频等 attempt 进度
  | "pending_job.done"         // v24-batch-all: attempt 完成
  | "pending_job.failed"       // v24-batch-all: attempt 失败或取消
  | "image.partial"            // 2026-05-16 渐进式落盘: 抽 N 张时每张完成立即推
  | "references.missing"       // 2026-05-20 P1: 参考图解析失败列表 (取代旧 silent skip)
  | "entities.upsert.partial"  // 2026-05-20: 占位 entity 自动创建部分失败时上报名单
  // 2026-05-29 E-03: export 子阶段 (export.trim / export.format_progress / export.done /
  // export.packaging 等) — 消除 _shared/sse.ts as 强转
  | `export.${string}`
  // 2026-05-29 E-03: realign 子阶段 (realign.shot / realign.burn / realign.done)
  | `realign.${string}`
  // 2026-05-29 E-03: extract-entities 子阶段 (extract-entities.calling /
  // extract-entities.local_fallback / extract-entities.done)
  | `extract-entities.${string}`
  // 2026-05-29 E-03: expand-script 子阶段 (expand-script.calling / expand-script.failed /
  // expand-script.done)
  | `expand-script.${string}`
  // 2026-05-18 一键自动管线 — 整集首帧 → 视频 → 合成串行 chain
  | "pipeline.stage.started"   // chain 某 stage 开跑
  | "pipeline.stage.progress"  // chain 某 stage 子任务进度 (completed/total)
  | "pipeline.stage.done"      // chain 某 stage 全部完成
  | "pipeline.done"            // chain 整条管线完成
  | "pipeline.failed"          // chain 某 stage 失败 (allowed retry-stage)
  | "pipeline.aborted"         // chain 被用户中断
  | `plan-storyboard.${string}` // Wave 3: plan-storyboard SSE progress events
  | "batch-series.done"         // 2026-05-28 audit P1: 批量导入系列完成 (seriesController.ts)
  | "batch-series-multi.done"   // 2026-05-28 audit P1: 多系列批量导入完成 (batchSeries.ts)
  | "elements.extracted"        // 2026-05-28 audit P1: 从剧本一键抽取素材完成 (extractElementsFromScript.ts)
  | "import-storyboard.done"    // 2026-05-28 audit P1: 导入分镜完成 (importStoryboard.ts)
  | "import-storyboard.skipped" // 2026-05-28 audit P1: 导入分镜部分集被跳过
  | "task.warning";             // V-39: shotPromptCompiler catch SSE 警告

/**
 * 宽松内部事件形状 — ring buffer 存储 / _send 序列化 / broadcast 构造 用。
 * emit() 的入参用更严格的 TypedSseEvent (它是 SseEvent 的子类型)。
 */
export interface SseEvent {
  type: SseEventType;
  job_id: string;
  task_id?: string;
  data: Record<string, unknown>;
  at: string;
}

// ─── Step 4: 强类型固定事件 (emit 入参) ──────────────────────────────

export interface SseEventBase {
  job_id: string;
  task_id?: string;
  at: string;
}

/**
 * emit() 入参的 discriminated union。每个固定 type 对应明确 payload。
 *
 * 多形状的 type (task.running / task.failed / compose.stage / compose.done) 保留
 * `[k: string]: unknown` index signature, 容纳现有不一致的 emit 点 (Step 4 调研发现
 * orchestrator / index.ts 有"整 record 展开"式 emit) — 强类型化目标是零行为变更,
 * 不强行修不一致。值类型不确定处用 unknown。
 *
 * 动态/广播事件 (provider.fallback, plan-storyboard.* / compose.* / export.* 等经
 * _shared/sse.ts 的动态 stage) 走 broadcast(), 不进此 union。
 */
export type TypedSseEvent =
  | (SseEventBase & { type: "task.queued"; data: { shot_id: string; action: string } })
  | (SseEventBase & { type: "task.running"; data: { shot_id?: string; action?: string; [k: string]: unknown } })
  | (SseEventBase & { type: "task.done"; data: { shot_id: string; action?: string; generation: unknown } })
  | (SseEventBase & {
      type: "task.failed";
      data: { shot_id?: string; action?: string; error?: unknown; cancel_result?: unknown; failed_reason?: unknown; [k: string]: unknown };
    })
  | (SseEventBase & { type: "task.warning"; data: { message: string; detail?: string; [k: string]: unknown } })
  | (SseEventBase & { type: "shot.updated"; data: { shot_id: string; status: string } })
  | (SseEventBase & { type: "shot.quality_warning"; data: { shot_id: string; score: number } })
  | (SseEventBase & {
      type: "shot.continuity_warning";
      data: { shot_id: string; prev_shot_id: string; reason?: string };
    })
  | (SseEventBase & {
      type: "pending_job.progress";
      data: { attempt_id: string; status: string; progress: number; purpose?: string; target?: unknown; eta_s?: number; [k: string]: unknown };
    })
  | (SseEventBase & {
      type: "pending_job.done";
      data: { attempt_id: string; status: string; progress: number; result?: unknown; [k: string]: unknown };
    })
  | (SseEventBase & {
      type: "pending_job.failed";
      data: { attempt_id: string; status: string; error?: unknown; [k: string]: unknown };
    })
  | (SseEventBase & {
      type: "compose.stage";
      data: { stage: string; episode_id?: string; percent?: number; [k: string]: unknown };
    })
  | (SseEventBase & {
      type: "compose.progress";
      data: { percent: number; step: string; detail?: string; shot_id?: string; index?: number; total?: number; [k: string]: unknown };
    })
  | (SseEventBase & {
      type: "compose.done";
      data: {
        episode_id?: string;
        final_video_path?: string;
        percent?: number;
        // 2026-05-29 E-04: 显式声明 render.ts 实际 emit 的全部字段 (之前只有 3 字段 + index sig)
        burned?: boolean;
        srt_path?: string;
        shot_count?: number;
        total_duration_ms?: number;
        mode?: string;
        tts_status?: string;
        tts_reason?: string;
        tts_init_error?: string;
        tts_failures?: Array<{ shot_id: string; error: string }>;
        mock_shots?: Array<{ shot_id: string; reason: string }>;
        trim_failures?: Array<{ shot_id: string; error: string }>;
        failed_shots?: Array<{ shot_id: string; kind: string; code: string; reason_zh: string }>;
        failed_shots_reason?: string;
        replaced_shot_ids?: string[];
        shot_segments?: Array<{ shot_id: string; start_sec: number; end_sec: number }>;
        subtitle_align_method?: string;
        subtitle_align_reason_zh?: string;
        bgm_missing_reason?: string;
        bgm_missing_mood?: string;
        [k: string]: unknown;
      };
    })
  | (SseEventBase & { type: "compose.error"; data: { error: unknown; [k: string]: unknown } })
  /**
   * 2026-05-16 渐进式落盘 — 抽 N 张时每张完成立即推一次, 让前端图库的 skeleton 占位卡
   * 被真图替换. orchestrator 的 on_image_ready callback 写完 vault+asset+业务对象后 emit.
   *
   * 字段:
   *   - element_id / shot_id (二选一, 看 target.kind)
   *   - series_slug
   *   - image_id  (业务对象内稳定 id, ElementImage.image_id 等)
   *   - asset_id / vault_id (前端从其中拿 url 复用渲染)
   *   - url        (前端直接渲染缩略图用)
   *   - completed  (本张落盘后已完成 +1)
   *   - total      (本次 N)
   *   - target_kind ("element" / "shot_first_frame" / "shot_last_frame" / ...) — 前端按 kind 找到对应面板
   */
  | (SseEventBase & {
      type: "image.partial";
      data: {
        target_kind: string;
        series_slug: string;
        target_id?: string;
        element_id?: string;
        shot_id?: string;
        image_id: string;
        asset_id?: string;
        vault_id?: string;
        url?: string;
        completed: number;
        total: number;
        provider_id?: string;
        [k: string]: unknown;
      };
    })
  /**
   * 2026-05-20 P1 红线 #1 + 铁律 0 Entity-first:
   * 分镜生图准备阶段, buildReferenceSet 检测到角色 / 场景参考图 vault 找不到或文件不存在,
   * 取代旧 silent skip 行为, 显式 SSE 推这个 event. 前端 GlobalQueuePanel / ShotStagePage
   * 监听后 toast 提示 "X 张参考图未找到, 影响视觉一致性, 请检查角色/场景的素材是否被误删".
   * 不阻塞生成 (降级为 prompt-only), 但用户能看到为什么角色看起来变了.
   */
  | (SseEventBase & {
      type: "references.missing";
      data: {
        series_slug: string;
        episode_id?: string;
        shot_id: string;
        missing: Array<{
          source_type: "character" | "scene";
          source_id: string;
          source_label: string;
          vault_id: string;
          reason: "vault_not_found" | "file_missing" | "resolve_failed";
        }>;
      };
    })
  // ── 2026-05-18 一键自动管线 ──
  | (SseEventBase & {
      type: "pipeline.stage.started";
      data: { pipeline_id: string; stage: "firstframes" | "videos" | "compose"; series_slug?: string; episode_id?: string };
    })
  | (SseEventBase & {
      type: "pipeline.stage.progress";
      data: { pipeline_id: string; stage: "firstframes" | "videos" | "compose"; completed: number; total: number; eta_s?: number };
    })
  | (SseEventBase & {
      type: "pipeline.stage.done";
      data: { pipeline_id: string; stage: "firstframes" | "videos" | "compose"; succeeded: number; failed: number };
    })
  | (SseEventBase & {
      type: "pipeline.done";
      data: { pipeline_id: string; series_slug?: string; episode_id?: string; final_video_path?: string };
    })
  | (SseEventBase & {
      type: "pipeline.failed";
      data: { pipeline_id: string; stage: "firstframes" | "videos" | "compose"; error: string };
    })
  | (SseEventBase & {
      type: "pipeline.aborted";
      data: { pipeline_id: string; stage?: "firstframes" | "videos" | "compose" };
    });
