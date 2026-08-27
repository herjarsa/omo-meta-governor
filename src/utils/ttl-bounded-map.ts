/**
 * TtlBoundedMap — TTL + size-capped Map for hot-path state that must not
 * leak memory if sessions emit high volumes of entries in a short window.
 *
 * v0.35.0 (audit fix F14): plugin.ts had pendingViolations and
 * pendingBotFeedback as plain Maps with only TTL protection. A session
 * emitting 1000s of violations in 5 minutes retained all in RAM.
 * This wrapper enforces both eviction policies:
 *   - Entries older than ttlMs are lazily evicted on access.
 *   - The oldest entry is evicted when maxEntries is reached.
 *
 * Intentionally minimal: no iterators (callers do not need them) and no
 * async eviction (TTL is checked synchronously on read).
 */
export class TtlBoundedMap<K, V> {
  private map = new Map<K, { value: V; expiresAtMs: number }>()
  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
  ) {}

  set(key: K, value: V): void {
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    this.map.set(key, { value, expiresAtMs: Date.now() + this.ttlMs })
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key)
    if (!entry) return undefined
    if (Date.now() >= entry.expiresAtMs) {
      this.map.delete(key)
      return undefined
    }
    return entry.value
  }

  has(key: K): boolean {
    return this.get(key) !== undefined
  }

  delete(key: K): void {
    this.map.delete(key)
  }

  get size(): number {
    return this.map.size
  }
}
