import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { studioWebIdentityPlugin } from "../../scripts/studio-web-identity";

const pkgVersion: string = (() => {
  try {
    const raw = readFileSync(resolve(__dirname, "../../package.json"), "utf-8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

// VITE_NO_WATCH=1 → 关闭 vite 文件监听器(等于关 HMR)。
// 为什么需要: 配合 Cowork / AI 改代码时, watcher 会与"非原子写入"竞态,
// 导致源文件被截断 / NUL 填充 / 冻结(详见 start-dev-nowatch.bat 注释)。
// 关掉 watcher 后改文件安全, 代价是前端改完要手动强刷浏览器。
// 正常本地开发(不用 Cowork)走 start-dev.bat, 仍享受 HMR。
export default defineConfig({
  define: {
    // 注入 package.json 的语义版本，前端用 __PACKAGE_VERSION__ 读取
    __PACKAGE_VERSION__: JSON.stringify(pkgVersion),
  },
  plugins: [studioWebIdentityPlugin(), react(), tailwindcss()],
  resolve: {
    alias: {
      shared: resolve(__dirname, "./src/components/shared"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
    watch: process.env.VITE_NO_WATCH ? null : undefined,
    proxy: {
      // W7-sse-proxy-fix (2026-05-16): SSE 长连接专用规则放在前面优先匹配.
      // string 简写会让 http-proxy-middleware 默认 buffer 响应 + 几秒后 timeout 中断,
      // SSE 长流被掐成 ECONNRESET → 浏览器 EventSource 永远收不到 task.done.
      // 显式配置 proxyTimeout/timeout=0 + selfHandleResponse=false 让连接长开,
      // 移除 content-length / content-encoding 强制 chunked transfer.
      "/api/v2/events": {
        target: "http://127.0.0.1:8788",
        changeOrigin: true,
        ws: false,
        selfHandleResponse: false,
        proxyTimeout: 0,
        timeout: 0,
        configure: (proxy: any) => {
          proxy.on("proxyRes", (proxyRes: any) => {
            delete proxyRes.headers["content-length"];
            delete proxyRes.headers["content-encoding"];
            proxyRes.headers["cache-control"] = "no-cache";
            proxyRes.headers["x-accel-buffering"] = "no";
          });
        },
      },
      // 2026-05-22 — compose SSE: useCompose hook 私建 EventSource 连
      // /api/v2/series/:slug/episodes/:epId/compose/progress, 跟 /events 同款 SSE.
      // 之前用户报 "合成完成中间不更新状态和成片预览" — toast 弹了 (App 全局 SSE
      // /events 收到 compose.done), 但 ComposePage stage 卡在 "composing" 因为
      // 私有 SSE 走默认 /api 字符串简写 → buffer + ECONNRESET 切断.
      // RegExp key 精确匹配 .../compose/progress 后缀, 不影响其他普通 API.
      [`^/api/v2/series/.*/episodes/.*/compose/progress`]: {
        target: "http://127.0.0.1:8788",
        changeOrigin: true,
        ws: false,
        selfHandleResponse: false,
        proxyTimeout: 0,
        timeout: 0,
        configure: (proxy: any) => {
          proxy.on("proxyRes", (proxyRes: any) => {
            delete proxyRes.headers["content-length"];
            delete proxyRes.headers["content-encoding"];
            proxyRes.headers["cache-control"] = "no-cache";
            proxyRes.headers["x-accel-buffering"] = "no";
          });
        },
      },
      // 2026-05-17: vault /raw 视频流走 chunked stream + Range request, 跟 SSE 同问题
      // string 简写 buffer 响应 + timeout 切断 → 浏览器 <video> 转圈加载不出来 (用户报告)
      // 显式 stream-friendly 配置 (proxyTimeout 大 + 不删 chunked header)
      "/api/v2/vault": {
        target: "http://127.0.0.1:8788",
        changeOrigin: true,
        ws: false,
        selfHandleResponse: false,
        proxyTimeout: 300_000,   // 5 min 给大视频流足够时间
        timeout: 300_000,
        configure: (proxy: any) => {
          proxy.on("proxyRes", (proxyRes: any) => {
            // 透传 Range / Accept-Ranges / Content-Range — 不动它们让 <video> 真识别 seek
            // 移除 content-encoding (chunked transfer 与 gzip 冲突)
            delete proxyRes.headers["content-encoding"];
            proxyRes.headers["x-accel-buffering"] = "no";
          });
        },
      },
      // 2026-05-25 字幕烧录 + 多规格 ffmpeg 被 abort 的真 root cause —
      // 用户原话: "ffmpeg exit 1" (实际看 log: "[aborted] Process killed via AbortSignal").
      // 没人主动取消, 是 vite proxy 默认 timeout 切断 fetch → 后端 req.on("close") →
      // ac.abort() → kill ffmpeg. 同文件 line 38 注释已警告 string 简写会 timeout 中断,
      // 但 /api 兜底还是用了 string 简写, 导致任何超过几秒的 POST (export 跑多规格 ffmpeg /
      // compose 跑 ffmpeg 拼接) 都被切断 → ffmpeg 被杀.
      //
      // 改成 object + proxyTimeout=0/timeout=0 让长 POST 永不超时 (后端 Express 自管 timeout).
      "/api": {
        target: "http://127.0.0.1:8788",
        changeOrigin: true,
        proxyTimeout: 0,
        timeout: 0,
      },
    }
  },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true
  }
});
