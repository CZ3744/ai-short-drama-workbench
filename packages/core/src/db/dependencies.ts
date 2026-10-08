// T07: Resource dependency graph — track shot→resource refs, dirty marking, change notification
import { getDb } from "./database";

export interface ShotRef {
  shot_stable_id: string;
  ref_type: "character" | "scene" | "style" | "voice" | "vault";
  ref_id: string;
}

/** Record that a shot references a resource */
export function addShotRef(shotStableId: string, refType: ShotRef["ref_type"], refId: string): void {
  getDb().prepare("INSERT OR IGNORE INTO shot_refs (shot_stable_id, ref_type, ref_id) VALUES (?, ?, ?)").run(shotStableId, refType, refId);
}

/** Remove a specific reference */
export function removeShotRef(shotStableId: string, refType: ShotRef["ref_type"], refId: string): void {
  getDb().prepare("DELETE FROM shot_refs WHERE shot_stable_id = ? AND ref_type = ? AND ref_id = ?").run(shotStableId, refType, refId);
}

/** Get all resources a shot references */
export function getShotRefs(shotStableId: string): ShotRef[] {
  return getDb().prepare("SELECT * FROM shot_refs WHERE shot_stable_id = ?").all(shotStableId) as ShotRef[];
}

/** Find all shots that reference a given resource. Returns shot IDs + affected shot info */
export function findShotsReferencing(refType: ShotRef["ref_type"], refId: string): string[] {
  const rows = getDb().prepare("SELECT DISTINCT shot_stable_id FROM shot_refs WHERE ref_type = ? AND ref_id = ?").all(refType, refId) as Array<{ shot_stable_id: string }>;
  return rows.map(r => r.shot_stable_id);
}

/** Get full dependency graph for a project's resources */
export function getProjectDependencyGraph(projectId: string): {
  resources: Array<{ ref_type: string; ref_id: string; shot_count: number }>;
  shots: Array<{ shot_stable_id: string; ref_count: number }>;
} {
  const db = getDb();

  // Get all characters/scenes/styles for this project
  const charIds = db.prepare("SELECT id FROM characters WHERE project_id = ?").all(projectId) as Array<{ id: string }>;
  const sceneIds = db.prepare("SELECT id FROM scenes WHERE project_id = ?").all(projectId) as Array<{ id: string }>;
  const styleIds = db.prepare("SELECT id FROM styles WHERE project_id = ?").all(projectId) as Array<{ id: string }>;

  const allRefs: Array<{ ref_type: string; ref_id: string }> = [
    ...charIds.map(c => ({ ref_type: "character", ref_id: c.id })),
    ...sceneIds.map(s => ({ ref_type: "scene", ref_id: s.id })),
    ...styleIds.map(s => ({ ref_type: "style", ref_id: s.id })),
  ];

  const resources = allRefs.map(ref => {
    const count = (db.prepare("SELECT COUNT(*) as cnt FROM shot_refs WHERE ref_type = ? AND ref_id = ?").get(ref.ref_type, ref.ref_id) as any).cnt;
    return { ...ref, shot_count: count };
  });

  const shotRows = db.prepare("SELECT shot_stable_id, COUNT(*) as cnt FROM shot_refs GROUP BY shot_stable_id").all() as Array<{ shot_stable_id: string; cnt: number }>;
  const shots = shotRows.map(r => ({ shot_stable_id: r.shot_stable_id, ref_count: r.cnt }));

  return { resources, shots };
}

/** Batch set all refs for a shot (replaces existing refs for this shot) */
export function setShotRefs(shotStableId: string, refs: Array<{ ref_type: ShotRef["ref_type"]; ref_id: string }>): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM shot_refs WHERE shot_stable_id = ?").run(shotStableId);
    for (const ref of refs) {
      db.prepare("INSERT INTO shot_refs (shot_stable_id, ref_type, ref_id) VALUES (?, ?, ?)").run(shotStableId, ref.ref_type, ref.ref_id);
    }
  });
  tx();
}

// ─── Dirty marking ──────────────────────────────────────────────────

/** Mark all shots referencing a resource as dirty */
export function markDirtyByResource(refType: ShotRef["ref_type"], refId: string): number {
  const shots = findShotsReferencing(refType, refId);
  const db = getDb();
  const now = new Date().toISOString();
  let count = 0;
  for (const shotId of shots) {
    // Mark dirty in vault_records that reference this shot
    const result = db.prepare("UPDATE vault_records SET status = 'dirty', updated_at = ? WHERE source_shot_id = ? AND status != 'dirty'").run(now, shotId);
    count += result.changes;
  }
  return count;
}
