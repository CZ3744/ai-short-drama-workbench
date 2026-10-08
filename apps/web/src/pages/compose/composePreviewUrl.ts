/** Separate a server file path from its refresh token before building a media route. */
export function composePreviewUrl(slug: string, episodeId: string, finalPath: string, revision?: string | null): string {
  const filename = finalPath.split(/[?#]/, 1)[0].replaceAll("\\", "/").split("/").pop() || "final.mp4";
  const base = `/api/v2/series/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(episodeId)}`;
  const route = filename === "final.mp4" ? `${base}/final.mp4` : `${base}/compose-file/${encodeURIComponent(filename)}`;
  return `${route}?v=${encodeURIComponent(`${revision || ""}:${finalPath}`)}`;
}

export function composeVersionUrl(url: string, createdAt: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(createdAt)}`;
}
