// 2026-05-17: 视频 src 工具 — 强制让 <video> 显示首帧
//
// 用户反馈"视频封面应该展示视频首帧, 现在不是".
//
// 根因: HTML <video src=...> 默认在用户点击播放前显示黑底.
// 即使加 preload="metadata", Chrome / Edge 也不保证渲染首帧像素.
//
// Web 标准技巧: URL fragment `#t=0.1` 强制浏览器把 currentTime 定位到 0.1s,
// 配合 preload="metadata" 会主动 decode 第一帧并显示 (Media Fragments URI spec).
// 0.1s 而非 0s 防有些 codec 在 t=0 解码失败 (B-frame depencency).

export function videoFirstFrameSrc(url: string | null | undefined): string {
  if (!url) return "";
  // 已带 fragment 的 src 不二次加 (e.g. 用户外部传的特殊 URL)
  if (url.includes("#t=") || url.includes("#xywh=")) return url;
  return `${url}#t=0.1`;
}
