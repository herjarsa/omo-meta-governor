/**
 * Ranker tests (v0.32.0 F2b).
 * RRF(k=60) fuses FTS5 ⊕ cosine rankings; filters minInstalls / duplicate.
 */

import { describe, expect, it } from "bun:test"
import { reciprocalRankFusion, filterByMinInstalls } from "./ranker"

describe("Ranker #RED F2b", () => {
  describe("reciprocalRankFusion", () => {
    it("then fuses two lists with k=60", () => {
      const fts = ["a", "b", "c"]
      const vec = ["b", "a", "d"]
      const fused = reciprocalRankFusion([fts, vec], 60)
      // a and b appear in both lists → tied top; c,d only in one → lower
      // stable sort: a before b as in first list order when scores equal
      expect(fused.slice(0, 2)).toEqual(["a", "b"])
      expect(new Set(fused)).toEqual(new Set(["a", "b", "c", "d"]))
    })

    it("then defaults k to 60 when omitted", () => {
      const fusedExplicit = reciprocalRankFusion([["x", "y"]], 60)
      const fusedDefault = reciprocalRankFusion([["x", "y"]])
      expect(fusedDefault).toEqual(fusedExplicit)
    })

    it("then handles empty lists", () => {
      expect(reciprocalRankFusion([])).toEqual([])
      expect(reciprocalRankFusion([[], []])).toEqual([])
    })
  })

  describe("filterByMinInstalls", () => {
    it("then filters below threshold", () => {
      const skills = [
        { id: "a", installs: 10 },
        { id: "b", installs: 100 },
        { id: "c", installs: 50 },
      ]
      const filtered = filterByMinInstalls(skills, 50)
      expect(filtered.map((s) => s.id).sort()).toEqual(["b", "c"])
    })

    it("then returns all when threshold 0", () => {
      const skills = [
        { id: "a", installs: 0 },
        { id: "b", installs: 5 },
      ]
      expect(filterByMinInstalls(skills, 0).length).toBe(2)
    })
  })
})
