import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { clientDisconnectSignal } from "./clientDisconnectSignal";

function pair() {
  const req = Object.assign(new EventEmitter(), { aborted: false });
  const res = Object.assign(new EventEmitter(), { writableFinished: false, destroyed: false });
  const signal = () => clientDisconnectSignal(req as unknown as express.Request, res as unknown as express.Response);
  return { req, res, signal };
}

describe("client disconnect cancellation", () => {
  it("request body close is not user cancellation and multiple callers share one signal", () => {
    const p = pair(); const signal = p.signal();
    assert.equal(signal, p.signal());
    p.req.emit("close");
    assert.equal(signal.aborted, false);
    p.res.writableFinished = true;
    p.res.emit("finish"); p.res.emit("close");
    assert.equal(signal.aborted, false);
    assert.equal(p.req.listenerCount("aborted"), 0);
    assert.equal(p.res.listenerCount("close"), 0);
  });
  it("a premature response close cancels and releases listeners", () => {
    const p = pair(); const signal = p.signal();
    p.res.emit("close");
    assert.equal(signal.aborted, true);
    assert.equal(signal.reason.name, "AbortError");
    assert.equal(p.req.listenerCount("aborted"), 0);
    assert.equal(p.res.listenerCount("finish"), 0);
  });
  it("an incomplete uploaded request cancels", () => {
    const p = pair(); const signal = p.signal();
    p.req.emit("aborted");
    assert.equal(signal.aborted, true);
  });
  it("a request already aborted before the helper is called is cancelled", () => {
    const p = pair(); p.req.aborted = true;
    assert.equal(p.signal().aborted, true);
  });
  it("a real POST body remains active until its response, while client abort cancels", async () => {
    const app = express(); app.use(express.json());
    let notifyStarted!: () => void;
    let notifyAborted!: () => void;
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    const aborted = new Promise<void>(resolve => { notifyAborted = resolve; });
    app.post("/normal", async (req, res) => {
      const signal = clientDisconnectSignal(req, res);
      await new Promise(resolve => setTimeout(resolve, 20));
      res.json({ aborted: signal.aborted, received: req.body.text });
    });
    app.post("/cancel", (req, res) => {
      const signal = clientDisconnectSignal(req, res);
      signal.addEventListener("abort", notifyAborted, { once: true });
      notifyStarted();
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const response = await fetch(`${base}/normal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "中文请求" }) });
      assert.deepEqual(await response.json(), { aborted: false, received: "中文请求" });
      const controller = new AbortController();
      const request = fetch(`${base}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: controller.signal });
      const rejected = assert.rejects(request, { name: "AbortError" });
      await started;
      controller.abort();
      await Promise.all([rejected, aborted]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
