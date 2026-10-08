import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { Response } from "express";
import { SseBroker } from "../api/v2/sseBroker";

class TestResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writableLength = 0;
  frames: string[] = [];
  failWrites = false;
  buffered = false;
  writeHead() { return this; }
  write(frame: string) {
    if (this.failWrites) throw new Error("socket closed");
    this.frames.push(frame);
    if (this.buffered) this.writableLength += Buffer.byteLength(frame);
    return !this.buffered;
  }
  destroy() {
    this.destroyed = true;
    this.emit("close");
    return this;
  }
  end() { this.writableEnded = true; this.emit("close"); return this; }
  response() { return this as unknown as Response; }
}

function emit(broker: SseBroker, text = "完成") {
  broker.emit({ type: "shot.updated", job_id: "episode", data: { text }, at: new Date().toISOString() });
}

describe("SSE stream resource limits", () => {
  it("cleans up an initial write failure and repeated unsubscribe is safe", () => {
    const broker = new SseBroker();
    const response = new TestResponse(); response.failWrites = true;
    const stop = broker.subscribe("episode", response.response());
    assert.equal(response.destroyed, true);
    assert.equal(broker.totalSubscribers(), 0);
    assert.equal(response.listenerCount("close"), 0);
    stop(); stop();
    assert.equal(broker.totalSubscribers(), 0);
  });
  it("does not register a response that was already closed", () => {
    const broker = new SseBroker();
    const response = new TestResponse(); response.destroyed = true;
    broker.subscribe("episode", response.response());
    assert.equal(response.frames.length, 0);
    assert.equal(broker.totalSubscribers(), 0);
  });
  it("keeps temporary backpressure below the bound and allows a drained stream to continue", () => {
    const broker = new SseBroker();
    const response = new TestResponse(); response.buffered = true;
    const stop = broker.subscribe("episode", response.response());
    emit(broker, "暂时积压".repeat(1000));
    assert.equal(response.destroyed, false);
    assert.equal(broker.totalSubscribers(), 1);
    response.writableLength = 0;
    response.buffered = false;
    emit(broker);
    assert.equal(response.frames.length, 3);
    stop();
  });
  it("disconnects stalled streams before buffered bytes exceed 1 MiB and keeps other tabs live", () => {
    const broker = new SseBroker();
    const stalled = new TestResponse(); stalled.buffered = true;
    const healthy = new TestResponse();
    broker.subscribe("episode", stalled.response());
    const stop = broker.subscribe("episode", healthy.response());
    for (let index = 0; index < 12; index++) emit(broker, "进度".repeat(20_000));
    assert.equal(stalled.destroyed, true);
    assert.ok(stalled.writableLength <= 1024 * 1024);
    assert.equal(stalled.listenerCount("close"), 0);
    assert.equal(broker.subscriberCount("episode"), 1);
    // Disconnect cleanup is synchronous in this fixture; it must not skip the next tab.
    assert.equal(healthy.frames.length, 13);
    stop();
  });
  it("preserves missed events for a fresh subscriber after a slow connection closes", () => {
    const broker = new SseBroker();
    emit(broker, "first"); emit(broker, "second"); emit(broker, "third");
    const stalled = new TestResponse(); stalled.writableLength = 1024 * 1024;
    broker.subscribe("episode", stalled.response(), 1);
    assert.equal(stalled.destroyed, true);
    assert.equal(broker.totalSubscribers(), 0);
    const healthy = new TestResponse();
    const stop = broker.subscribe("episode", healthy.response(), 1);
    assert.ok(healthy.frames[0].startsWith("id: 2\n"));
    assert.ok(healthy.frames[1].startsWith("id: 3\n"));
    assert.equal(healthy.frames.length, 3);
    stop();
  });
  it("broadcast delivery survives a failed earlier subscriber", () => {
    const broker = new SseBroker();
    const broken = new TestResponse();
    const healthy = new TestResponse();
    broker.subscribe("__global__", broken.response());
    const stop = broker.subscribe("__global__", healthy.response());
    broken.failWrites = true;
    broker.broadcast("shot.updated", { message: "still delivered" }, "episode");
    assert.equal(broker.totalSubscribers(), 1);
    assert.equal(healthy.frames.length, 2);
    stop();
  });
});
