/**
 * AuditStateCache tests — TTL + LRU eviction semantics.
 */
import { describe, expect, it } from "bun:test"
import { AuditStateCache } from "./audit-state-cache"

describe("AuditStateCache", () => {
  describe("#given a default cache (maxEntries=100, ttlMs=1h)", () => {
    it("then set + get round-trips", () => {
      const cache = new AuditStateCache<string>()
      cache.set("s1", "value-1")
      expect(cache.get("s1")).toBe("value-1")
    })

    it("then has() returns true after set, false after delete", () => {
      const cache = new AuditStateCache<string>()
      cache.set("s1", "v")
      expect(cache.has("s1")).toBe(true)
      cache.delete("s1")
      expect(cache.has("s1")).toBe(false)
    })

    it("then get() on missing key returns undefined", () => {
      const cache = new AuditStateCache<string>()
      expect(cache.get("nope")).toBeUndefined()
    })

    it("then size() reflects entries", () => {
      const cache = new AuditStateCache<string>()
      expect(cache.size()).toBe(0)
      cache.set("a", "1")
      cache.set("b", "2")
      expect(cache.size()).toBe(2)
    })
  })

  describe("#given a cache with maxEntries=3 and a clock", () => {
    it("then a 4th set evicts the oldest-accessed entry", () => {
      let t = 1_000_000
      const cache = new AuditStateCache<string>({
        maxEntries: 3,
        now: () => t,
      })
      cache.set("a", "1")
      t += 1
      cache.set("b", "2")
      t += 1
      cache.set("c", "3")
      t += 1
      cache.get("a")
      t += 1
      cache.set("d", "4")

      expect(cache.has("a")).toBe(true)
      expect(cache.has("b")).toBe(false)
      expect(cache.has("c")).toBe(true)
      expect(cache.has("d")).toBe(true)
      expect(cache.size()).toBe(3)
    })

    it("then updating an existing key does NOT trigger eviction", () => {
      let t = 1_000_000
      const cache = new AuditStateCache<string>({ maxEntries: 2, now: () => t })
      cache.set("a", "1")
      t += 1
      cache.set("b", "2")
      t += 1
      cache.set("a", "updated")
      expect(cache.size()).toBe(2)
      expect(cache.get("a")).toBe("updated")
    })
  })

  describe("#given a cache with ttlMs=1000 and a fake clock", () => {
    it("then entries expire after ttlMs", () => {
      let t = 1_000_000
      const cache = new AuditStateCache<string>({ ttlMs: 1000, now: () => t })
      cache.set("s1", "v")
      expect(cache.get("s1")).toBe("v")
      t += 999
      expect(cache.get("s1")).toBe("v")
      t += 2
      expect(cache.get("s1")).toBeUndefined()
      expect(cache.size()).toBe(0)
    })

    it("then has() returns false for expired entries", () => {
      let t = 1_000_000
      const cache = new AuditStateCache<string>({ ttlMs: 100, now: () => t })
      cache.set("s1", "v")
      t += 200
      expect(cache.has("s1")).toBe(false)
    })
  })

  describe("#given 200 sessions on a default cache with clock", () => {
    it("then the cache caps at 100 entries (LRU evicts oldest)", () => {
      let t = 1_000_000
      const cache = new AuditStateCache<string>({ now: () => t })
      for (let i = 0; i < 200; i++) {
        cache.set(`s${i}`, `v${i}`)
        t += 1
      }
      expect(cache.size()).toBe(100)
      expect(cache.has("s199")).toBe(true)
      expect(cache.has("s100")).toBe(true)
      expect(cache.has("s0")).toBe(false)
      expect(cache.has("s99")).toBe(false)
    })
  })

  describe("#given a cache with clear()", () => {
    it("then size drops to 0", () => {
      const cache = new AuditStateCache<string>()
      cache.set("a", "1")
      cache.set("b", "2")
      cache.clear()
      expect(cache.size()).toBe(0)
      expect(cache.get("a")).toBeUndefined()
    })
  })
})
