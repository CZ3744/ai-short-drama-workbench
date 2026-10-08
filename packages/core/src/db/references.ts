// T15: LLM resource reference parser — resolve @角色.X @场景.X @风格.X @音色.X tokens
import { getDb } from "./database";

export interface ResolvedReference {
  raw: string;           // original token e.g. "@角色.林夜"
  ref_type: "character" | "scene" | "style" | "voice" | "vault";
  match_method: "exact" | "fuzzy" | "cross_project";
  resolved: boolean;
  resource_id?: string;
  resource_name?: string;
  resource_data?: Record<string, unknown>;
  error?: string;
}

const REF_PATTERNS: Array<{ pattern: RegExp; type: ResolvedReference["ref_type"]; labelMap: string[] }> = [
  { pattern: /@角色\.([^\s@,，。！？、]+)/g, type: "character", labelMap: ["char", "角色"] },
  { pattern: /@场景\.([^\s@,，。！？、]+)/g, type: "scene", labelMap: ["scene", "场景"] },
  { pattern: /@风格\.([^\s@,，。！？、]+)/g, type: "style", labelMap: ["style", "风格"] },
  { pattern: /@音色\.([^\s@,，。！？、]+)/g, type: "voice", labelMap: ["voice", "音色"] },
  { pattern: /@素材库\.([^\s@,，。！？、]+)/g, type: "vault", labelMap: ["vault", "素材库"] },
  // English aliases
  { pattern: /@char:([^\s@,，。！？、]+)/g, type: "character", labelMap: ["char"] },
  { pattern: /@scene:([^\s@,，。！？、]+)/g, type: "scene", labelMap: ["scene"] },
];

/** Extract all @-references from a text */
export function extractReferences(text: string): Array<{ raw: string; type: ResolvedReference["ref_type"]; name: string }> {
  const results: Array<{ raw: string; type: ResolvedReference["ref_type"]; name: string }> = [];
  for (const { pattern, type } of REF_PATTERNS) {
    // BUG-46: 用 matchAll 避免 /g 标志的 RegExp.exec() lastIndex 泄漏
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      results.push({ raw: match[0], type, name: match[1] });
    }
  }
  return results;
}

/** Resolve references against project + public asset library */
export function resolveReferences(
  refs: Array<{ raw: string; type: ResolvedReference["ref_type"]; name: string }>,
  projectId?: string,
): ResolvedReference[] {
  const db = getDb();
  const results: ResolvedReference[] = [];

  for (const ref of refs) {
    const base = { raw: ref.raw, ref_type: ref.type, match_method: "exact" as const, resolved: false };

    switch (ref.type) {
      case "character": {
        const exact = projectId
          ? db.prepare("SELECT * FROM characters WHERE project_id = ? AND name = ?").get(projectId, ref.name) as any
          : undefined;
        if (exact) {
          results.push({ ...base, resolved: true, resource_id: exact.id, resource_name: exact.name, match_method: "exact",
            resource_data: parseCharacterRefData(exact) });
          continue;
        }
        // Try fuzzy match (LIKE)
        const fuzzy = projectId
          ? db.prepare("SELECT * FROM characters WHERE project_id = ? AND (name LIKE ? OR aliases LIKE ?)").get(projectId, `%${ref.name}%`, `%${ref.name}%`) as any
          : undefined;
        if (fuzzy) {
          results.push({ ...base, resolved: true, resource_id: fuzzy.id, resource_name: fuzzy.name, match_method: "fuzzy",
            resource_data: parseCharacterRefData(fuzzy) });
          continue;
        }
        // Try public asset library
        const pub = db.prepare("SELECT * FROM assets WHERE asset_type = 'character' AND name LIKE ? LIMIT 1").get(`%${ref.name}%`) as any;
        if (pub) {
          results.push({ ...base, resolved: true, resource_id: pub.id, resource_name: pub.name, match_method: "cross_project",
            resource_data: { name: pub.name, description: pub.description } });
          continue;
        }
        results.push({ ...base, error: `未找到角色"${ref.name}"` });
        break;
      }
      case "scene": {
        const exact = projectId
          ? db.prepare("SELECT * FROM scenes WHERE project_id = ? AND name = ?").get(projectId, ref.name) as any
          : undefined;
        if (exact) {
          results.push({ ...base, resolved: true, resource_id: exact.id, resource_name: exact.name,
            resource_data: { name: exact.name, description: exact.description, location_type: exact.location_type, time_of_day: exact.time_of_day } });
          continue;
        }
        const pub = db.prepare("SELECT * FROM assets WHERE asset_type = 'scene' AND name LIKE ? LIMIT 1").get(`%${ref.name}%`) as any;
        if (pub) {
          results.push({ ...base, resolved: true, resource_id: pub.id, resource_name: pub.name, match_method: "cross_project",
            resource_data: { name: pub.name, description: pub.description } });
          continue;
        }
        results.push({ ...base, error: `未找到场景"${ref.name}"` });
        break;
      }
      case "style": {
        const exact = projectId
          ? db.prepare("SELECT * FROM styles WHERE project_id = ? AND name = ?").get(projectId, ref.name) as any
          : undefined;
        if (exact) {
          results.push({ ...base, resolved: true, resource_id: exact.id, resource_name: exact.name,
            resource_data: { name: exact.name, description: exact.description, mood: exact.mood } });
          continue;
        }
        const pub = db.prepare("SELECT * FROM assets WHERE asset_type = 'style' AND name LIKE ? LIMIT 1").get(`%${ref.name}%`) as any;
        if (pub) {
          results.push({ ...base, resolved: true, resource_id: pub.id, resource_name: pub.name, match_method: "cross_project",
            resource_data: { name: pub.name, description: pub.description } });
          continue;
        }
        results.push({ ...base, error: `未找到风格"${ref.name}"` });
        break;
      }
      case "voice": {
        const exact = projectId
          ? db.prepare("SELECT * FROM characters WHERE project_id = ? AND voice_id IS NOT NULL AND name = ?").get(projectId, ref.name) as any
          : undefined;
        if (exact) {
          results.push({ ...base, resolved: true, resource_id: exact.id, resource_name: exact.name,
            resource_data: { voice_provider: exact.voice_provider, voice_id: exact.voice_id } });
          continue;
        }
        const pub = db.prepare("SELECT * FROM assets WHERE asset_type = 'voice' AND name LIKE ? LIMIT 1").get(`%${ref.name}%`) as any;
        if (pub) {
          results.push({ ...base, resolved: true, resource_id: pub.id, resource_name: pub.name, match_method: "cross_project",
            resource_data: { name: pub.name, description: pub.description } });
          continue;
        }
        results.push({ ...base, error: `未找到音色"${ref.name}"` });
        break;
      }
      case "vault": {
        // Vault references are always cross-project (public vault)
        const pub = db.prepare("SELECT * FROM assets WHERE asset_type = 'vault' AND name LIKE ? LIMIT 1").get(`%${ref.name}%`) as any;
        if (pub) {
          results.push({ ...base, resolved: true, resource_id: pub.id, resource_name: pub.name, match_method: "cross_project",
            resource_data: { name: pub.name, description: pub.description } });
          continue;
        }
        // Also search vault_records
        const vRec = db.prepare("SELECT * FROM vault_records WHERE status = 'unused' AND tags LIKE ? LIMIT 1").get(`%${ref.name}%`) as any;
        if (vRec) {
          results.push({ ...base, resolved: true, resource_id: vRec.id, resource_name: vRec.id, match_method: "cross_project",
            resource_data: { prompt: vRec.prompt, provider: vRec.provider } });
          continue;
        }
        results.push({ ...base, error: `未找到素材库资源"${ref.name}"` });
        break;
      }
    }
  }

  return results;
}

/** Generate LLM system prompt addition about @ reference syntax */
export function getResourceReferenceSystemPrompt(projectSlug: string): string {
  return `你可以使用以下引用语法来引用本项目或公共素材库的资源：
- @角色.名称 — 引用角色（外观、音色）
- @场景.名称 — 引用场景（环境、光照）
- @风格.名称 — 引用视觉风格
- @音色.名称 — 引用角色音色
- @素材库.名称 — 引用公共素材库资源

当拆分镜时，引用的资源会自动注入参考图和风格描述。跨项目引用会自动通过公共素材库解析。`;
}

function parseCharacterRefData(row: any): Record<string, unknown> {
  return {
    name: row.name,
    description: row.description,
    age_range: row.age_range,
    gender: row.gender,
    style_description: row.style_description,
    voice: row.voice_provider ? {
      provider: row.voice_provider,
      voice_id: row.voice_id,
    } : null,
  };
}
