/**
 * Skill-hub sync — registry-backed catalog ingestion (v0.32.0).
 *
 * Ingests bulk skill metadata (skills.sh ecosystem snapshots) into the
 * existing SQLite `skills` table (see SqliteBackend.skillAddOrUpdate),
 * skipping records whose content hash is unchanged.
 *
 * Source record shape (skills-library.com/api/skills.json, verified):
 *   { id: "owner/repo/slug", name, description, source: "owner/repo",
 *     skillId: "slug", installs, githubStars, repoUrl }
 */

import { createHash } from "node:crypto"
import type { SqliteBackend } from "./sqlite-backend"

export const SKHUB_NOT_IMPLEMENTED = "SKHUB_NOT_IMPLEMENTED"

/** Raw record shape from the bootstrap snapshot endpoint. */
export interface SkillHubSourceRecord {
  id?: unknown
  name?: unknown
  description?: unknown
  source?: unknown
  skillId?: unknown
  installs?: unknown
  githubStars?: unknown
  repoUrl?: unknown
}

export interface SkillHubIngestResult {
  /** Records written that did not exist before (new rows). */
  inserted: number
  /** Records written over an existing row whose hash changed. */
  updated: number
  /** Records skipped because content_hash matched existing row. */
  skippedUnchanged: number
  /** Records rejected (missing/invalid id or name). */
  invalid: number
}

/** Normalized record ready for the backend upsert. */
export interface SkillHubNormalizedRecord {
  id: string
  name: string
  description: string
  repo_url: string | undefined
  installs: number
  skill_id: string | undefined
  content_hash: string
}

/** Deterministic content hash for change detection across syncs. */
export function skillHubRecordHash(r: {
  id: string
  name: string
  description: string
  installs: number
}): string {
  const canonical = JSON.stringify([r.id, r.name, r.description, r.installs])
  return createHash("sha256").update(canonical).digest("hex")
}

/** Validate + normalize one raw source record. Returns null when invalid. */
export function normalizeSkillRecord(
  raw: SkillHubSourceRecord,
): SkillHubNormalizedRecord | null {
  if (typeof raw !== "object" || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== "string") return null
  const id = r.id.trim()
  if (id.length === 0) return null
  if (typeof r.name !== "string" || r.name.length === 0) return null
  if (typeof r.name !== "string" || r.name.length === 0) return null
  const description = typeof r.description === "string" ? r.description : ""
  const installs =
    typeof r.installs === "number" && Number.isFinite(r.installs) && r.installs >= 0
      ? Math.floor(r.installs)
      : 0
  const repo_url = typeof r.repoUrl === "string" && r.repoUrl.length > 0 ? r.repoUrl : undefined
  const skill_id = typeof r.skillId === "string" && r.skillId.length > 0 ? r.skillId : undefined
  const core = { id, name: r.name, description, installs }
  return { ...core, repo_url, skill_id, content_hash: skillHubRecordHash(core) }
}

export interface SkillHubSyncDeps {
  backend: Pick<
    SqliteBackend,
    "skillAddOrUpdate" | "skillGet"
  >
}

export class SkillHubSync {
  constructor(private readonly deps: SkillHubSyncDeps) {}

  /**
   * Ingest an array of raw bootstrap records into the backend,
   * skipping rows whose stored content_hash equals the computed hash.
   */
  async ingestBootstrap(
    records: unknown,
  ): Promise<SkillHubIngestResult> {
    const result: SkillHubIngestResult = { inserted: 0, updated: 0, skippedUnchanged: 0, invalid: 0 }
    if (!Array.isArray(records)) return result
    for (const raw of records) {
      const rec = normalizeSkillRecord(raw as SkillHubSourceRecord)
      if (rec === null) {
        result.invalid++
        continue
      }
      const existing = await this.deps.backend.skillGet(rec.id)
      if (existing !== null && existing.content_hash === rec.content_hash) {
        result.skippedUnchanged++
        continue
      }
      await this.deps.backend.skillAddOrUpdate({
        id: rec.id,
        name: rec.name,
        description: rec.description,
        repo_url: rec.repo_url,
        installs: rec.installs,
        skill_id: rec.skill_id,
        download_count: 0,
        last_synced: Date.now(),
        content_hash: rec.content_hash,
      })
      if (existing === null) {
        result.inserted++
      } else {
        result.updated++
      }
    }
    return result
  }
}
