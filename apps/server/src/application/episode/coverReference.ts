import { listShots } from "../../api/v2/seriesStore";
import { readAsset } from "../../repositories/assetRepo";
import { getVaultEntry } from "../../../../../packages/library/src/assetVault";
import { resolveSingleRef } from "../generation/shared/resolveRef";

/** Resolve once for both prompt review and generation; never drop a selected reference silently. */
export async function resolveCoverReference(slug: string, episodeId: string, shotId: string) {
  const shot = (await listShots(slug, episodeId)).find(candidate => candidate.id === shotId);
  if (!shot) throw new Error("参考分镜不存在，请重新选择参考图");
  const pickedId = shot.picked_first_frame_generation_id ?? shot.picked_generation_id;
  const trashedIds = new Set((shot.trashed_generations ?? []).map(item => item.generation_id));
  const generations = shot.active_generations?.length ? shot.active_generations : (shot.generations ?? []);
  const generation = generations.find(item => item.generation_id === pickedId &&
    item.type === "first_frame" && item.status === "done" && !trashedIds.has(item.generation_id));
  const assetId = generation?.asset_id ?? generation?.vault_id;
  if (!assetId) throw new Error("参考分镜尚未选定可用首帧，请重新选择参考图或取消参考图");
  // Validate the file before returning a preview or reaching any paid provider.
  await resolveSingleRef({ ref: { asset_id: assetId }, series_slug: slug, temp_paths: [], tmpDirName: "cover-preview" });
  const vault = await getVaultEntry(assetId);
  if (vault && vault.status !== "active") throw new Error("参考图已移入回收站，请重新选择参考图");
  let url: string;
  if (vault) {
    url = `/api/v2/vault/${encodeURIComponent(assetId)}/raw`;
  } else {
    const asset = await readAsset(slug, assetId);
    const assetPath = asset?.path.replaceAll("\\", "/");
    if (!assetPath || !/^assets\/images\/[^/]+$/.test(assetPath)) {
      throw new Error("参考图暂时无法预览，请重新导入图片后再试");
    }
    url = `/api/v2/series/${encodeURIComponent(slug)}/${assetPath.split("/").map(encodeURIComponent).join("/")}`;
  }
  return { asset_id: assetId, url, label: `第 ${shot.index} 镜${shot.title ? ` · ${shot.title}` : ""}首帧` };
}
