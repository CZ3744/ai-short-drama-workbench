// ── E3 · Global schema version migration framework ──
//
// Every persisted JSON/JSONL document carries a `schema_version` field.
// When the format evolves (field rename, structure change, etc.), add a
// migration function to MIGRATIONS and bump CURRENT_SCHEMA_VERSION.
//
// Readers call `migrateToLatest(data)` immediately after JSON.parse so
// that all consumers always see the latest schema, regardless of disk version.

/** Current latest schema version. Bump this when adding a migration. */
export const CURRENT_SCHEMA_VERSION = 3;

/** A migration function receives raw data and returns migrated data. */
export type MigrationFn = (data: Record<string, unknown>) => Record<string, unknown>;

/**
 * Ordered migration registry: version N → migration that produces version N+1.
 * Each function is responsible for transforming from its key version to the
 * next version. Functions are called in ascending order.
 */
const MIGRATIONS: Record<number, MigrationFn> = {
  // v1 -> v2: placeholder. No structural changes yet; migrateToLatest stamps the version.
  1: (data) => data,
  // v2 -> v3: add major/minor version markers for editable resource arrays.
  2: (data) => {
    const next = { ...data };
    for (const key of ["characters", "scenes", "styles", "shots"]) {
      const items = (next as any)[key];
      if (!Array.isArray(items)) continue;
      (next as any)[key] = items.map((item: Record<string, unknown>) => {
        const migratedItem = { ...item };
        migratedItem.major_version = typeof item.major_version === "number" ? item.major_version : 1;
        migratedItem.minor_version = typeof item.minor_version === "number" ? item.minor_version : 0;
        return migratedItem;
      });
    }
    return next;
  },
};

/**
 * Check `schema_version` on data and apply all pending migrations in order.
 *
 * - If `schema_version` is missing, it is treated as 0.
 * - If already at CURRENT_SCHEMA_VERSION or above, returns data unchanged.
 * - Otherwise applies every migration from the stored version up to (but not
 *   including) CURRENT_SCHEMA_VERSION, then stamps `schema_version`.
 *
 * Call this right after JSON.parse for every persisted JSON/JSONL document.
 */
export function migrateToLatest(data: Record<string, unknown>): Record<string, unknown> {
  const rawVersion = data.schema_version;
  const version =
    typeof rawVersion === "number"
      ? rawVersion
      : typeof rawVersion === "string" && Number.isFinite(Number(rawVersion))
        ? Number(rawVersion)
        : 0;
  if (version >= CURRENT_SCHEMA_VERSION) return data;

  let migrated = { ...data };
  for (let v = version; v < CURRENT_SCHEMA_VERSION; v++) {
    const fn = MIGRATIONS[v];
    if (fn) {
      migrated = fn(migrated);
    }
  }
  migrated.schema_version = CURRENT_SCHEMA_VERSION;
  return migrated;
}
