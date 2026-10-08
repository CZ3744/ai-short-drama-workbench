/**
 * v2 SSE Broker — Push task status changes and ledger records to clients
 *
 * Event types: task.queued, task.running, task.done, task.failed, shot.updated 等
 * Heartbeat: 10s
 * C2: Ring buffer (100 events) + global seq for Last-Event-ID replay
 * D1: Single channel — global subscribers use job_id="__global__", client-side filtering
 * B7: Per-job ring buffer (Map<jobId, RingEntry[]>, 1000 entries each)
 *     Reconnect ?lastEventId=N&job_id=X replays from job-specific buffer
 *
 * Step 4 (2026-05-14): SSE event 强类型化。
 *   - emit() 收紧到 TypedSseEvent discriminated union — 固定 type 对应精确 payload
 *   - broadcast() 保持宽松 (Record<string,unknown>) — 给 provider.fallback 和动态
 *     stage 事件 (plan-storyboard.* / compose.* / export.* 等, 经 _shared/sse.ts) 用
 *   - SseEvent 仍是宽松内部形状, ring buffer / _send / broadcast 用; TypedSseEvent ⊆ SseEvent
 *   - 删除死类型 ledger.record (从未实际 emit)
 */

import type { Response } from "express";
import { getTask } from "../../repositories/taskRepo";
import type {
  SseEventType,
  SseEvent,
  SseEventBase,
  TypedSseEvent,
} from "../../../../../packages/contracts/src";

export type { SseEventType, SseEvent, SseEventBase, TypedSseEvent };

interface SseClient {
  job_id: string;
  res: Response;
  heartbeat: ReturnType<typeof setInterval>;
}

/** Ring buffer entry: event + its global sequence number */
interface RingEntry {
  seq: number;
  event: SseEvent;
}

/** Max entries per job-specific ring buffer (B7: was 100 flat, now 1000 per job) */
const MAX_JOB_RING_SIZE = 1000;

/** S10: Max number of distinct jobId ring buffers before LRU eviction kicks in */
const MAX_JOB_RINGS = 100;

/** Bound bytes waiting for a slow subscriber; EventSource reconnects and replays. */
const MAX_PENDING_CLIENT_BYTES = 1024 * 1024;

/** Sentinel job_id for global subscribers */
const GLOBAL_JOB_ID = "__global__";

export class SseBroker {
  /** All connected clients (job-specific + global), keyed by job_id */
  private _clients = new Map<string, SseClient[]>();

  // ─── B7: per-job ring buffers ─────────────────────────────────

  /** Monotonically increasing global sequence counter */
  private _seq = 0;

  /** Per-job ring buffers: Map<jobId, RingEntry[]> — each job's buffer holds up to 1000 events */
  private _jobRings = new Map<string, RingEntry[]>();

  /** S10: Track last emit timestamp per jobId for LRU eviction */
  private _jobRingLastEmitAt = new Map<string, number>();

  private _nextSeq(): number {
    return ++this._seq;
  }

  /** S10: Evict least recently used ring buffers when over MAX_JOB_RINGS */
  private _evictLruRings(): void {
    if (this._jobRings.size <= MAX_JOB_RINGS) return;
    // Sort by lastEmitAt ascending, evict oldest
    const sorted = [...this._jobRingLastEmitAt.entries()]
      .sort((a, b) => a[1] - b[1]);
    const toEvict = sorted.slice(0, this._jobRings.size - MAX_JOB_RINGS);
    for (const [jobId] of toEvict) {
      this._jobRings.delete(jobId);
      this._jobRingLastEmitAt.delete(jobId);
    }
  }

  /** Push an entry into a job-specific ring buffer, evicting oldest if over limit */
  private _pushRing(jobId: string, entry: RingEntry): void {
    if (!this._jobRings.has(jobId)) {
      this._jobRings.set(jobId, []);
    }
    const ring = this._jobRings.get(jobId)!;
    ring.push(entry);
    if (ring.length > MAX_JOB_RING_SIZE) ring.shift();
    // S10: track last emit for LRU
    this._jobRingLastEmitAt.set(jobId, Date.now());
    this._evictLruRings();
  }

  /**
   * B7: Replay events with seq > afterSeq from a specific job's ring buffer.
   * Used when a client reconnects with Last-Event-ID and job_id=X.
   *
   * 2026-05-27 — seq 回卷检测 (dev server tsx watch restart):
   *   server 重启后 _seq 重置为 0, 但客户端 lastEventId 还指向旧的高位.
   *   `entry.seq > afterSeq` 永远 false → 不 replay → task.done event 永远到
   *   不了前端 → UI 卡"生成中". 检测: 如果 afterSeq 大于 _seq, 说明 server
   *   重置了, replay ring 全部 + 推一条 session.reconnect-stale 告知客户端
   *   主动 fetch /api/v2/tasks 同步 store.
   */
  replayFromId(jobId: string, afterSeq: number, res: Response): void {
    const serverRestarted = afterSeq > this._seq;
    if (serverRestarted) {
      // 通知客户端服务端重启, client 收到后主动 fetch tasks 兜底
      this._send(res, {
        type: "task.queued",  // 复用 SSE 通道, data 标志 reset
        job_id: jobId,
        data: { server_restarted: true, prev_last_event_id: afterSeq, current_seq: this._seq },
        at: new Date().toISOString(),
      });
      // 重启后 ring buffer 也空, 没东西可 replay; 但 ring 里若已有新 emit, 推过去
      const ring = this._jobRings.get(jobId);
      if (ring) {
        for (const entry of ring) {
          if (!this._send(res, entry.event, entry.seq)) break;
        }
      }
      return;
    }
    const ring = this._jobRings.get(jobId);
    if (!ring) return;
    for (const entry of ring) {
      if (entry.seq > afterSeq) {
        if (!this._send(res, entry.event, entry.seq)) break;
      }
    }
  }

  // ─── subscribe ──────────────────────────────────────────────

  /**
   * Subscribe a client to events.
   * - job_id = specific id → only events for that job
   * - job_id = "__global__" or undefined → all events (client-side filtering)
   * B7: If lastEventId is provided, replays missed events from that job's ring buffer.
   * Returns an unsubscribe function.
   */
  subscribe(job_id: string, res: Response, lastEventId?: number): () => void {
    const effectiveJobId = job_id || GLOBAL_JOB_ID;

    // D-N4 (2026-05-12): 心跳从 15s → 10s. NAT / 代理常见 30-60s 空闲断, 10s 更安全.
    const heartbeat = setInterval(() => {
      this._writeFrame(res, `: heartbeat ${Date.now()}\n\n`);
    }, 10_000);
    heartbeat.unref();

    const client: SseClient = { job_id: effectiveJobId, res, heartbeat };

    if (!this._clients.has(effectiveJobId)) {
      this._clients.set(effectiveJobId, []);
    }
    this._clients.get(effectiveJobId)!.push(client);

    // Register before the first write: a replay/connection write can fail immediately.
    const cleanup = () => {
      clearInterval(heartbeat);
      res.off("close", cleanup);
      const clients = this._clients.get(effectiveJobId);
      if (clients) {
        const idx = clients.indexOf(client);
        if (idx !== -1) clients.splice(idx, 1);
        if (clients.length === 0) this._clients.delete(effectiveJobId);
      }
    };
    res.once("close", cleanup);

    if (res.destroyed || res.writableEnded) {
      cleanup();
    } else {
      try {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        if (lastEventId != null && lastEventId > 0) {
          this.replayFromId(effectiveJobId, lastEventId, res);
        }
        // No sequence: connection notice is not stored in the replay buffer.
        this._send(res, { type: "task.queued", job_id: effectiveJobId, data: { connected: true }, at: new Date().toISOString() });
      } catch {
        cleanup();
        try { res.destroy(); } catch { /* already closed */ }
      }
    }

    return () => {
      cleanup();
      try { res.end(); } catch { /* already closed */ }
    };
  }

  // ─── emit / broadcast ───────────────────────────────────────

  /**
   * Emit a strongly-typed fixed event to job-specific subscribers AND global subscribers.
   * B7: Stores in the job-specific ring buffer with a monotonic seq.
   *
   * Step 4: 入参收紧到 TypedSseEvent discriminated union — 固定 type 对应精确 payload。
   * 动态 / 广播事件请用 broadcast()。
   */
  emit(event: TypedSseEvent): void {
    // Global subscribers can be viewing different series. Carry the originating
    // task's identity instead of making each tab guess from its current route.
    const task = event.task_id ? getTask(event.task_id) : null;
    if (task) event = Object.assign({}, event, { data: {
      ...event.data,
      series_slug: task.meta.series_slug,
      episode_id: task.meta.episode_id,
      action: ("action" in event.data ? event.data.action : undefined) ?? task.meta.action ?? task.kind,
    } });
    const seq = this._nextSeq();
    const entry: RingEntry = { seq, event };

    // B7: Push to both job-specific and global ring buffers
    // so that global subscribers can replay missed events after reconnect
    this._pushRing(event.job_id, entry);
    if (event.job_id !== GLOBAL_JOB_ID) {
      this._pushRing(GLOBAL_JOB_ID, entry);
    }

    for (const [jid, clients] of this._clients) {
      for (const client of [...clients]) {
        if (jid === event.job_id || jid === GLOBAL_JOB_ID) {
          this._send(client.res, event, seq);
        }
      }
    }
  }

  /**
   * Emit an event to ALL connected clients.
   * Used for provider.fallback events that aren't job-specific, and for the
   * dynamic stage events (plan-storyboard.* / compose.* / export.* 等) routed
   * through _shared/sse.ts. Payload stays loosely typed (Record<string,unknown>).
   * B7: Pushes to the __global__ ring buffer (and job-specific if job_id given).
   */
  broadcast(type: SseEventType, data: Record<string, unknown>, job_id?: string): void {
    const seq = this._nextSeq();
    const effectiveJobId = job_id ?? GLOBAL_JOB_ID;
    const event: SseEvent = {
      type,
      job_id: effectiveJobId,
      data,
      at: new Date().toISOString(),
    };
    const entry: RingEntry = { seq, event };

    // B7: Push to the appropriate ring buffers (always global, also job-specific if given)
    this._pushRing(GLOBAL_JOB_ID, entry);
    if (effectiveJobId !== GLOBAL_JOB_ID) {
      this._pushRing(effectiveJobId, entry);
    }

    for (const clients of this._clients.values()) {
      for (const client of [...clients]) {
        this._send(client.res, event, seq);
      }
    }
  }

  /**
   * Get the number of active subscribers for a job.
   */
  subscriberCount(job_id: string): number {
    return this._clients.get(job_id)?.length ?? 0;
  }

  /**
   * Get total active subscriber count across all jobs + global.
   */
  totalSubscribers(): number {
    let count = 0;
    for (const clients of this._clients.values()) {
      count += clients.length;
    }
    return count;
  }

  // ─── internals ──────────────────────────────────────────────

  // D-N2 (2026-05-12): _send 失败时主动 destroy socket. 之前 catch 吞掉, ring buffer
  // 仍持续 emit, 每个 event 都重写一次同一个已死 res — 资源浪费 + 误统计 subscriberCount.
  // 现在 write 抛 → 立即 res.destroy 触发 'close' 事件, 让 subscribe 注册的 close handler
  // 完成 client 清理. 这是 Node http 上"知道 socket 已断"的标准方式.
  private _send(res: Response, event: SseEvent, seq?: number): boolean {
    try {
      const payload = JSON.stringify(event);
      const idLine = seq != null ? `id: ${seq}\n` : "";
      return this._writeFrame(res, `${idLine}event: ${event.type}\ndata: ${payload}\n\n`);
    } catch {
      try { res.destroy(); } catch { /* already destroyed */ }
      return false;
    }
  }

  private _writeFrame(res: Response, frame: string): boolean {
    if (res.destroyed || res.writableEnded) return false;
    try {
      // A false write result is temporary backpressure, so normal short bursts are
      // retained. A stalled client must not accumulate an unbounded Node buffer.
      if ((res.writableLength ?? 0) + Buffer.byteLength(frame, "utf8") > MAX_PENDING_CLIENT_BYTES) {
        res.destroy();
        return false;
      }
      res.write(frame);
      return true;
    } catch {
      try { res.destroy(); } catch { /* already destroyed */ }
      return false;
    }
  }
}

// Singleton
export const sseBroker = new SseBroker();
