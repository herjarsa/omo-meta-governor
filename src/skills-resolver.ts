/**
 * Skills resolver — unified query layer over three tiers.
 *
 * Precedence: project-local (cwd/.agents/skills) > chore global
 * (~/.agents/skills) > hub catalog (SQLite FTS5).
 *
 * Pure functions only: no fs mutation, no network calls. Hub search is
 * injected via `ResolverState.hubSearch` so the resolver stays testable
 * without real network.
 */

import { createHash } from "node:crypto"
import { join } from "node:path"
import { scanSkillsDir, type ParsedSkillFrontmatter } from "./skills-fs.js"

export type SkillSource = 'chore' | 'hub-materialized' | 'custom' | 'hub'
export type Tier = 1 | 2 | 3
export type TierFilter = 'all' | 'chore' | 'custom' | 'hub'

export interface SkillDescriptor {
  slug: string
  name: string
  description: string
  source: SkillSource
  tier: Tier
  path: string | null
  contentHash: string | null
}

export interface HubEntry {
  slug: string
  name: string
  description: string
  installs?: number
}

export interface ResolverState {
  choreDir: string
  projectDir: string
  hubSearch: (query: string, limit: number) => Promise<HubEntry[]>
  /**
   * Returns true if a given project-local slug was materialized from the hub
   * (i.e. SQLite `last_materialized_at` is set), false if it is custom-written.
   * Resolver uses this to label `source: 'hub-materialized'` vs 'custom'.
   * Optional: defaults to a function that returns false (treat all project-local as custom).
   */
  isMaterialized?: (slug: string) => Promise<boolean>
}





const hashContent = (content: string): string =>
  "sha256:" + createHash("sha256").update(content).digest("hex")

const toDescriptor = (
  source: SkillSource,
  tier: Tier,
  slug: string,
  parsed: ParsedSkillFrontmatter,
  skillPath: string,
): SkillDescriptor => ({
  slug,
  name: parsed.name,
  description: parsed.description,
  source,
  tier,
  path: skillPath,
  contentHash: hashContent(parsed.raw + parsed.name + parsed.description),
})

const hubEntryToDescriptor = (entry: HubEntry): SkillDescriptor => ({
  slug: entry.slug,
  name: entry.name,
  description: entry.description,
  source: 'hub',
  tier: 2,
  path: null,
  contentHash: null,
})

export async function findSkill(
  slug: string,
  state: ResolverState,
): Promise<SkillDescriptor | null> {
  const [projectMap, choreMap] = await Promise.all([
    scanSkillsDir(state.projectDir),
    scanSkillsDir(state.choreDir),
  ])


  // Precedence: project-local > chore > hub
  if (projectMap.has(slug)) {
    const parsed = projectMap.get(slug)!
    const materialized = state.isMaterialized ? await state.isMaterialized(slug) : false
    return toDescriptor(materialized ? 'hub-materialized' : 'custom', 3, slug, parsed, join(state.projectDir, slug, "SKILL.md"))
  }



  if (choreMap.has(slug)) {
    const parsed = choreMap.get(slug)!
    return toDescriptor('chore', 1, slug, parsed, join(state.choreDir, slug, "SKILL.md"))
  }
  const hubHits = await state.hubSearch(slug, 1)
  const hit = hubHits.find((h) => h.slug === slug)
  if (hit) return hubEntryToDescriptor(hit)
  return null
}

export async function searchSkills(
  query: string,
  state: ResolverState,
  opts?: { tier?: TierFilter; limit?: number },
): Promise<SkillDescriptor[]> {
  const tier: TierFilter = opts?.tier ?? 'all'
  const limit = opts?.limit ?? 50

  const out: SkillDescriptor[] = []
  const seen = new Set<string>()

  if (tier === 'all' || tier === 'custom') {
    const projectMap = await scanSkillsDir(state.projectDir)
    for (const [slug, parsed] of projectMap) {
      if (matches(query, slug, parsed.name, parsed.description)) {
        const materialized = state.isMaterialized ? await state.isMaterialized(slug) : false
        out.push(toDescriptor(materialized ? 'hub-materialized' : 'custom', 3, slug, parsed, join(state.projectDir, slug, "SKILL.md")))
        seen.add(slug)
      }
    }
  }









  if (tier === 'all' || tier === 'chore') {
    const choreMap = await scanSkillsDir(state.choreDir)
    for (const [slug, parsed] of choreMap) {
      if (seen.has(slug)) continue
      if (matches(query, slug, parsed.name, parsed.description)) {
        out.push(toDescriptor('chore', 1, slug, parsed, join(state.choreDir, slug, "SKILL.md")))
        seen.add(slug)
      }
    }
  }

  if (tier === 'all' || tier === 'hub') {
    const hubHits = await state.hubSearch(query, limit)
    for (const hit of hubHits) {
      if (seen.has(hit.slug)) continue
      out.push(hubEntryToDescriptor(hit))
      seen.add(hit.slug)
    }
  }

  return out.slice(0, limit)
}

function matches(query: string, slug: string, name: string, description: string): boolean {
  if (!query) return true  // empty query returns everything
  const q = query.toLowerCase()
  return slug.toLowerCase().includes(q) ||
         name.toLowerCase().includes(q) ||
         description.toLowerCase().includes(q)
}
