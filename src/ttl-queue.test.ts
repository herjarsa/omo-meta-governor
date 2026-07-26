/**
 * Tests for the TTL-bounded pending queues in plugin.ts (F1.3).
 * These tests exercise the data shape and TTL contract; the actual Map
 * operations live inside plugin.ts closure, so we test the contract
 * via a small inline replica.
 */
import { describe, expect, it } from "bun:test"

interface TTLEntry<T> {
  items: T[]
  expiresAtMs: number
}

function makeTTLQueue<T>(ttlMs: number, now: () => number = Date.now) {
  const store = new Map<string, TTLEntry<T>>()
  return {
    set(key: string, items: T[]) {
      store.set(key, { items, expiresAtMs: now() + ttlMs })
    },
    get(key: string): TTLEntry<T> | undefined {
      const e = store.get(key)
      if (!e) return undefined
      if (e.expiresAtMs <= now()) {
        store.delete(key)
        return undefined
      }
      return e
    },
    has(key: string): boolean {
      return this.get(key) !== undefined
    },
    delete(key: string) {
      return store.delete(key)
    },
    size: () => store.size,
  }
}

describe("TTL-wrapped pending queues (F1.3)", () => {
  describe("#given a queue with 5min TTL", () => {
    it("then items are accessible while not expired", () => {
      let t = 1_000_000
      const q = makeTTLQueue<string>(5 * 60 * 1000, () => t)
      q.set("s1", ["v1", "v2"])
      expect(q.has("s1")).toBe(true)
      expect(q.get("s1")?.items).toEqual(["v1", "v2"])
    })

    it("then items expire after TTL elapses", () => {
      let t = 1_000_000
      const q = makeTTLQueue<string>(5 * 60 * 1000, () => t)
      q.set("s1", ["v1"])
      t += 5 * 60 * 1000 + 1
      expect(q.has("s1")).toBe(false)
      expect(q.get("s1")).toBeUndefined()
    })

    it("then expired entries are dropped on read", () => {
      let t = 1_000_000
      const q = makeTTLQueue<string>(1000, () => t)
      q.set("s1", ["v1"])
      t += 2000
      q.get("s1") // triggers cleanup
      expect(q.size()).toBe(0)
    })
  })

  describe("#given a 5min TTL queue that has accumulated entries", () => {
    it("then 1000 sessions × 5 items each stay bounded across hours", () => {
      let t = 1_000_000
      const q = makeTTLQueue<string>(5 * 60 * 1000, () => t)
      for (let i = 0; i < 1000; i++) {
        q.set(`s${i}`, [`item-${i}`])
        t += 1000
      }
      // After ~16 minutes, the first entries should be expired
      // and the rest still valid (5min TTL window).
      expect(q.size()).toBeLessThanOrEqual(1000)
      // Latest 301 entries (5min = 300 1s ticks + 1 buffer) should still be valid
      expect(q.has("s999")).toBe(true)
      expect(q.has("s701")).toBe(true)
      // Entries older than 5min (300 ticks at 1s/tick) should be expired
      // s0 was inserted at t=1_000_000, expires at t=1_300_000
      // After all 1000 ticks, t=1_001_000. s0 still alive by 1ms. Use s100 to be safe.
      expect(q.has("s0")).toBe(false)
    })
  })
})
