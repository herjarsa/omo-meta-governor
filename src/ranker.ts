/**
 * Ranker (v0.32.0 F2b) — RRF(k=60) fusion + install filters.
 *
 * Fuses FTS5 lexical ranking and cosine vector ranking via
 * Reciprocal Rank Fusion. No external deps.
 */

export function reciprocalRankFusion(lists: readonly (readonly string[])[], k = 60): string[] {
  if (lists.length === 0) return []
  const scores = new Map<string, number>()
  const firstSeen = new Map<string, number>()
  let order = 0
  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      const id = list[i]
      if (id === undefined) continue
      if (!firstSeen.has(id)) {
        firstSeen.set(id, order++)
      }
      const rank = i + 1
      const prev = scores.get(id) ?? 0
      scores.set(id, prev + 1 / (k + rank))
    }
  }
  if (scores.size === 0) return []
  const entries = [...scores.entries()]
  entries.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1]
    const ao = firstSeen.get(a[0]) ?? 0
    const bo = firstSeen.get(b[0]) ?? 0
    return ao - bo
  })
  return entries.map(([id]) => id)
}

export interface SkillWithInstalls {
  readonly id: string
  readonly installs: number
}

export function filterByMinInstalls<T extends SkillWithInstalls>(
  skills: readonly T[],
  minInstalls: number,
): T[] {
  if (minInstalls <= 0) return [...skills]
  return skills.filter((s) => s.installs >= minInstalls)
}
