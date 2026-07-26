/**
 * TTL-based + LRU-bounded cache for per-session audit state.
 *
 * v0.15.0: closed the C1/H16 audit findings — `auditSessions` was an
 * unbounded Map that grew indefinitely. Replaced with a class that
 *
 *  1. Caps total entries (default 100, configurable).
 *  2. Evicts the least-recently-accessed entry when the cap is hit.
 *  3. TTLs each entry (default 1 hour, configurable). On read, expired
 *     entries are dropped.
 *
 * The cache is intentionally synchronous (Map-backed) — the audit
 * state mutations happen on the plugin's main thread between hooks
 * and are not shared across the event loop, so no locking is needed.
 *
 * v0.16.0 also documents: Bun's runtime is single-threaded, so a read
 * followed by an `await` cannot be interrupted by another write. This
 * means we do NOT need per-session mutex for the audit state. See
 * plugin.ts `// v0.16.0 concurrency model` comment block.
 */

export interface AuditStateCacheConfig {
  /** Max number of entries. Default 100. */
  readonly maxEntries?: number
  /** Time-to-live per entry in milliseconds. Default 3_600_000 (1h). */
  readonly ttlMs?: number
  /** Optional clock injection for testing. Returns ms since epoch. */
  readonly now?: () => number
}

interface CacheEntry<V> {
  readonly value: V
  readonly expiresAtMs: number
  /** Last access time for LRU. Updated on every get(). */
  lastAccessAtMs: number
}

export class AuditStateCache<V> {
  private readonly store = new Map<string, CacheEntry<V>>()
  private readonly maxEntries: number
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(config: AuditStateCacheConfig = {}) {
    this.maxEntries = config.maxEntries ?? 100
    this.ttlMs = config.ttlMs ?? 3_600_000
    this.now = config.now ?? Date.now
  }

  get(key: string): V | undefined {
    const entry = this.store.get(key)
    if (!entry) return undefined
    const now = this.now()
    if (entry.expiresAtMs <= now) {
      this.store.delete(key)
      return undefined
    }
    entry.lastAccessAtMs = now
    return entry.value
  }

  has(key: string): boolean {
    return this.get(key) !== undefined
  }

  set(key: string, value: V): void {
    const now = this.now()
    if (!this.store.has(key) && this.store.size >= this.maxEntries) {
      this.evictOldest()
    }
    this.store.set(key, {
      value,
      expiresAtMs: now + this.ttlMs,
      lastAccessAtMs: now,
    })
  }

  delete(key: string): boolean {
    return this.store.delete(key)
  }

  size(): number {
    return this.store.size
  }

  clear(): void {
    this.store.clear()
  }

  /** Evict the entry with the oldest lastAccessAtMs. No-op if empty. */
  private evictOldest(): void {
    let oldestKey: string | undefined
    let oldestAccess = Infinity
    for (const [k, v] of this.store) {
      if (v.lastAccessAtMs < oldestAccess) {
        oldestAccess = v.lastAccessAtMs
        oldestKey = k
      }
    }
    if (oldestKey !== undefined) {
      this.store.delete(oldestKey)
    }
  }
}
