import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { request, type Server } from "node:http";
import express from "express";
import cors from "cors";
import { localRequestGuard } from "./localRequestGuard";

describe("local request boundary", () => {
  let server: Server;
  let base: string;
  let mutations = 0;
  before(async () => {
    const app = express();
    app.use(localRequestGuard("http://127.0.0.1:15173"));
    app.use(cors({ origin: true }));
    app.use(express.json());
    app.get("/healthz", (_req, res) => { res.json({ ok: true }); });
    app.post("/save", (_req, res) => { mutations++; res.json({ ok: true }); });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it("permits header-free launcher/CLI probes and local JSON mutations", async () => {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    const response = await fetch(`${base}/save`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(response.status, 200);
  });
  for (const origin of ["http://127.0.0.1:15173", "http://localhost:15173", "http://[::1]:15173"]) {
    it(`permits configured development port and reflects CORS for ${origin}`, async () => {
      const response = await fetch(`${base}/save`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("access-control-allow-origin"), origin);
    });
  }
  it("permits same-origin browser POSTs and proxied GETs with a trusted referrer", async () => {
    assert.equal((await fetch(`${base}/save`, { method: "POST", headers: { Origin: base } })).status, 200);
    assert.equal((await fetch(`${base}/healthz`, { headers: { Referer: "http://localhost:15173/studio?search=hello", "Sec-Fetch-Site": "same-origin" } })).status, 200);
  });
  for (const origin of ["https://untrusted.example", "null", "http://localhost:15174", "http://localhost:15173.evil.test", "http://localhost:15173/path"]) {
    it(`rejects foreign or malformed origin ${origin} before route invocation`, async () => {
      const beforeCount = mutations;
      // A simple form-style request does not need CORS preflight.
      const response = await fetch(`${base}/save`, { method: "POST", headers: { Origin: origin, "Content-Type": "text/plain" }, body: "{}" });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, "UNTRUSTED_ORIGIN");
      assert.equal(mutations, beforeCount);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    });
  }
  it("rejects DNS-rebinding Host headers even if spoofed forwarded headers look local", async () => {
    // fetch rewrites Host, so use the real HTTP transport to send the hostile header.
    const response = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const req = request(`${base}/healthz`, { headers: { Host: "untrusted.example", "X-Forwarded-Host": "localhost:15173", "X-Forwarded-For": "127.0.0.1" } }, res => {
        let body = ""; res.setEncoding("utf8"); res.on("data", chunk => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, body }));
        res.on("error", reject);
      });
      req.on("error", reject); req.end();
    });
    assert.equal(response.status, 403);
    assert.equal(JSON.parse(response.body).error.code, "LOCAL_HOST_REQUIRED");
  });
  it("rejects cross-site requests and untrusted GET referrers without Origin", async () => {
    for (const headers of [{ "Sec-Fetch-Site": "cross-site" }, { Referer: "https://untrusted.example/page" }, { Referer: "not a URL" }]) {
      assert.equal((await fetch(`${base}/healthz`, { headers })).status, 403);
    }
  });
  it("rejects preflight for foreign pages but allows the configured application", async () => {
    for (const origin of ["https://untrusted.example", "http://localhost:15173"]) {
      const response = await fetch(`${base}/save`, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" } });
      assert.equal(response.status, origin.includes("untrusted") ? 403 : 204);
    }
  });
  it("fails visibly on an invalid WEB_ORIGIN instead of silently opening access", () => {
    for (const origin of ["*", "null", "file:///workspace", "http://localhost:5173/path", "http://user:secret@localhost"]) {
      assert.throws(() => localRequestGuard(origin), /WEB_ORIGIN/);
    }
  });
});
