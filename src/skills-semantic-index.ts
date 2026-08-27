/**
 * skills-semantic-index.ts - lazy embeddings cache for skill semantic search.
 * v0.35.8: backs omo_skill_semantic_find with the local embed-server (pm2).
 *
 * Strategy:
 *   1. On first search, enumerate ~/.agents/skills/*, parse each SKILL.md's
 *      frontmatter (name + description), embed via EmbedClient.
 *   2. Cache to ~/.cache/omo-meta-governor/skill-embeddings.json.
 *   3. Subsequent searches reuse the cache. mtime invalidation per skill.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { EmbedClient, EmbedTimeoutError } from "./embed-client.js"
import { globalSkillsRoot, listGlobalSkills } from "./skills-catalog.js"

export interface IndexedSkill {
  slug: string
  text: string          // concatenated name + description for embedding
  embedding: number[]
  mtimeMs: number
}

export interface SemanticIndex {
  version: 1
  model: string
  builtAt: number
  skills: Record<string, IndexedSkill>
}

function cachePath(): string {
  return join(homedir(), ".cache", "omo-meta-governor", "skill-embeddings.json")
}

/** Test seam: override the cache file location. */
let _cachePathOverride: string | null = null
export function setCachePathOverride(p: string | null): void {
  _cachePathOverride = p
}
function effectiveCachePath(): string {
  return _cachePathOverride ?? cachePath()
}

function readCache(): SemanticIndex | null {
  const p = effectiveCachePath()
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, "utf8")) as SemanticIndex
  } catch {
    return null
  }
}

function writeCache(idx: SemanticIndex): void {
  const p = effectiveCachePath()
  mkdirSync(join(homedir(), ".cache", "omo-meta-governor"), { recursive: true })
  writeFileSync(p, JSON.stringify(idx, null, 2), "utf8")
}

/**
 * Best-effort frontmatter extraction. Looks for the first `---` block at the
 * top of SKILL.md, parses `name:` and `description:` lines. Returns "" for
 * either field if not found.
 */
function parseFrontmatter(content: string): { name: string; description: string } {
  const out = { name: "", description: "" }
  if (!content.startsWith("---")) return out
  const end = content.indexOf("\n---", 3)
  if (end === -1) return out
  const block = content.slice(3, end)
  for (const line of block.split(/\r?\n/)) {
    const m = /^(\w+)\s*:\s*(.*)$/.exec(line.trim())
    if (!m) continue
    const key = m[1]
    let val = m[2].trim()
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1)
    if (key === "name") out.name = val
    else if (key === "description") out.description = val
  }
  return out
}

function loadSkillText(slug: string): { text: string; mtimeMs: number } {
  const skillMd = join(globalSkillsRoot(), slug, "SKILL.md")
  const fallback = join(globalSkillsRoot(), slug, "skill.md")
  const p = existsSync(skillMd) ? skillMd : (existsSync(fallback) ? fallback : "")
  if (!p) return { text: slug, mtimeMs: 0 }
  try {
    const content = readFileSync(p, "utf8")
    const fm = parseFrontmatter(content)
    const mtimeMs = statSync(p).mtimeMs
    const text = [fm.name, fm.description].filter(Boolean).join(" — ") || slug
    return { text, mtimeMs }
  } catch {
    return { text: slug, mtimeMs: 0 }
  }
}

export interface IndexDeps {
  baseUrl: string       // e.g. "http://127.0.0.1:3114/v1"
  model: string         // e.g. "bge-m3"
  fetch?: typeof fetch
  /** override for tests */
  nowMs?: () => number
}

export async function buildOrUpdateIndex(deps: IndexDeps): Promise<SemanticIndex> {
  const slugs = listGlobalSkills()
  const cached = readCache()
  const idx: SemanticIndex = cached && cached.version === 1 && cached.model === deps.model
    ? cached
    : { version: 1, model: deps.model, builtAt: deps.nowMs?.() ?? Date.now(), skills: {} }

  // Determine which skills need (re)embedding
  const toEmbed: { slug: string; text: string; mtimeMs: number }[] = []
  for (const slug of slugs) {
    const { text, mtimeMs } = loadSkillText(slug)
    const existing = idx.skills[slug]
    if (existing && existing.text === text && existing.mtimeMs === mtimeMs) continue
    toEmbed.push({ slug, text, mtimeMs })
  }

  if (toEmbed.length === 0) {
    idx.builtAt = deps.nowMs?.() ?? Date.now()
    writeCache(idx)
    return idx
  }

  const client = new EmbedClient({
    baseUrl: deps.baseUrl,
    model: deps.model,
    fetch: deps.fetch ?? globalThis.fetch,
  })
  try {
    const vectors = await client.embedBatch(toEmbed.map((t) => t.text))
    for (let i = 0; i < toEmbed.length; i++) {
      const item = toEmbed[i]
      const vec = vectors[i]
      if (!vec) continue
      idx.skills[item.slug] = {
        slug: item.slug,
        text: item.text,
        embedding: vec,
        mtimeMs: item.mtimeMs,
      }
    }
    idx.builtAt = deps.nowMs?.() ?? Date.now()
    writeCache(idx)
    return idx
  } catch (err) {
    if (err instanceof EmbedTimeoutError) {
      throw new Error(`Embed server unreachable at ${deps.baseUrl} after timeout: ${err.message}`)
    }
    throw err
  }
}

export interface SemanticHit {
  slug: string
  score: number
  text: string
}

function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!
    dot += x * y; na += x * x; nb += y * y
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

export async function semanticSearch(
  deps: IndexDeps,
  query: string,
  limit: number,
): Promise<SemanticHit[]> {
  if (query.trim().length === 0) return []
  const idx = await buildOrUpdateIndex(deps)
  const client = new EmbedClient({
    baseUrl: deps.baseUrl, model: deps.model, fetch: deps.fetch ?? globalThis.fetch,
  })
  const [qvec] = await client.embed(query)
  if (!qvec) return []
  const hits: SemanticHit[] = []
  for (const skill of Object.values(idx.skills)) {
    hits.push({ slug: skill.slug, score: cosine(qvec, skill.embedding), text: skill.text })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, limit)
}