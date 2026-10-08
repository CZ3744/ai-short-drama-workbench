/** 使用真实中间件和日志查询器，但只启动临时 HTTP 服务，不接管用户工作台。 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { requestLogging } from "../middleware/requestLogging";
import { queryLogs, getLogSummary } from "../api/v2/logController";
import { getAppLogger } from "../../../../packages/core/src/logger";

let base = "";
let server: http.Server;
let capturedRequestId = "";

describe("logging chain", () => {
  before(async () => {
    // 同时发起首次初始化，验证并发不会产生多份 logger/文件流。
    const loggers = await Promise.all(Array.from({ length: 20 }, () => getAppLogger()));
    assert.ok(loggers.every(logger => logger === loggers[0]));
    const app = express();
    app.use(requestLogging());
    app.get("/health", (_req, res) => res.json({ ok: true }));
    app.get("/logs/query", queryLogs);
    app.get("/logs/summary", getLogSummary);
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
        resolve();
      });
      server.once("error", reject);
    });
    const res = await fetch(`${base}/health`);
    capturedRequestId = res.headers.get("x-request-id") ?? "";
    await res.arrayBuffer();
  });

  after(async () => {
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it("serves a full unique X-Request-Id in response header", async () => {
    assert.match(capturedRequestId, /^[0-9a-f-]{36}$/);
    const responses = await Promise.all(Array.from({ length: 10 }, () => fetch(`${base}/health`)));
    assert.equal(new Set(responses.map(r => r.headers.get('x-request-id'))).size, 10);
    await Promise.all(responses.map(r => r.arrayBuffer()));
  });

  it("GET /logs/query returns entries array", async () => {
    const res = await fetch(`${base}/logs/query?limit=5`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.entries));
    assert.equal(typeof body.total, "number");
  });

  it("GET /logs/query?requestId finds the actual access log", async () => {
    // 等待可观测条件，不假定磁盘一定在固定 500ms 内完成刷新。
    let found = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const res = await fetch(`${base}/logs/query?requestId=${capturedRequestId}&limit=10`);
      assert.equal(res.status, 200);
      const body = await res.json();
      found = body.entries.some((entry: { msg?: string; requestId?: string }) =>
        entry.requestId === capturedRequestId && entry.msg?.includes("HTTP GET /health"));
      if (found) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(found, "请求日志必须真实写入并能按 requestId 查询");
  });

  it("GET /logs/summary returns correct structure", async () => {
    const res = await fetch(`${base}/logs/summary`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.groups));
    assert.equal(typeof body.total_errors, "number");
  });

  it("GET /logs/query with level filter works", async () => {
    const res = await fetch(`${base}/logs/query?level=error&limit=5`);
    assert.equal(res.status, 200);
    const body = await res.json();
    for (const entry of body.entries) assert.equal(entry.level, 50);
  });
});
