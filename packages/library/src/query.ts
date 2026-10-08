import type { Asset, AssetKind } from "./types.js";
import type { AssetStore } from "./assetStore.js";

// ── Convenience query functions ─────────────────────────────────────────

/**
 * Find all image assets belonging to a character.
 */
export async function findByCharacter(
  store: AssetStore,
  charId: string
): Promise<Asset[]> {
  return store.list({
    kind: "image",
    tags: [`character:${charId}`],
  });
}

/**
 * Find all candidate assets for a specific shot.
 */
export async function findCandidatesByShot(
  store: AssetStore,
  shotId: string,
  kind: "image" | "video" = "image"
): Promise<Asset[]> {
  return store.list({
    kind: kind as AssetKind,
    tags: [`shot:${shotId}`],
  });
}

/**
 * Find all assets belonging to an episode (all kinds).
 */
export async function findByEpisode(
  store: AssetStore,
  epId: string
): Promise<Asset[]> {
  return store.list({
    tags: [`episode:${epId}`],
  });
}
