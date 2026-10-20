/**
 * model-context.ts — resolve the real context window of the model in use
 * (v0.61.0 F6).
 *
 * WHY this exists: the token-predictor measures the burn rate against
 * `modelLimit` and predicts overflow from it. Until v0.61.0 that number
 * was a hardcoded 200_000 — so on a model with a 1M window the predictor
 * believed the context was 5x smaller than it is, and on a 128k model it
 * believed it was 1.6x LARGER (it would predict an overflow that never
 * comes). Both directions are wrong: the overflow prediction is the thing
 * that makes the governor stop the agent before it gets truncated.
 *
 * The source of truth is opencode's own model registry cache
 * (`~/.cache/opencode/models.json`), which has the shape:
 *
 *   { [provider]: { models: { [modelId]: { limit: { context: number } } } } }
 *
 * 8279 of 8279 model entries carry `limit.context` (verified), so the
 * lookup is reliable.
 *
 * PRECEDENCE: explicit `modelOverride.modelLimit` > the registry > the
 * 200k fallback. An explicit override always wins — the user asked for it.
 */

import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface ModelRegistryEntry {
  readonly id?: string
  readonly limit?: { readonly context?: number; readonly output?: number }
  readonly [k: string]: unknown
}

export interface ModelRegistry {
  readonly [provider: string]: { readonly models?: { readonly [modelId: string]: ModelRegistryEntry } }
}

/** The fallback when nothing is known. Deliberately conservative. */
export const FALLBACK_MODEL_LIMIT = 200_000

/**
 * Candidate paths for opencode's model registry cache, in priority order.
 * The first one that exists wins.
 */
export function modelRegistryPaths(home = homedir()): string[] {
  return [
    join(home, ".cache", "opencode", "models.json"),
    join(home, ".local", "share", "opencode", "models.json"),
    join(home, ".config", "opencode", "models.json"),
  ]
}

/**
 * Look up a model's context window in the registry.
 *
 * The model id can be qualified (`provider/model`) or bare (`model`), and
 * the provider can be given separately. Both are matched: the qualified id
 * is tried first (exact provider match), then the bare id across every
 * provider (first hit wins — the context window is a property of the
 * model, not of the gateway that serves it).
 *
 * Returns undefined when the model is not in the registry.
 */
export function lookupContextWindow(
  registry: ModelRegistry,
  modelID: string | undefined,
  providerID?: string,
): number | undefined {
  if (!modelID) return undefined
  const bare = modelID.includes("/") ? modelID.slice(modelID.lastIndexOf("/") + 1) : modelID

  // 1. Exact: provider + model.
  if (providerID) {
    const entry = registry[providerID]?.models?.[modelID]
    const ctx = entry?.limit?.context
    if (typeof ctx === "number" && ctx > 0) return ctx
  }

  // 2. Exact model id in the named provider.
  if (providerID) {
    const models = registry[providerID]?.models ?? {}
    for (const [id, entry] of Object.entries(models)) {
      if (id === bare || id.endsWith("/" + bare)) {
        const ctx = entry?.limit?.context
        if (typeof ctx === "number" && ctx > 0) return ctx
      }
    }
  }

  // 3. Any provider that serves this model id.
  for (const provider of Object.values(registry)) {
    const models = provider?.models ?? {}
    for (const [id, entry] of Object.entries(models)) {
      if (id === bare || id.endsWith("/" + bare)) {
        const ctx = entry?.limit?.context
        if (typeof ctx === "number" && ctx > 0) return ctx
      }
    }
  }
  return undefined
}

/**
 * Read the registry from disk. Returns null when the file is missing or
 * unparseable — the caller degrades to the fallback.
 *
 * CACHED: the registry is 5 MB of JSON and parsing it costs ~250ms. The
 * plugin is created per session (and per test), so an uncached read turns
 * a constant into a per-session tax — and in the test suite it pushed
 * several 5s-timeout tests over the edge. The file does not change while
 * opencode runs, so one read per process is enough.
 */
let cachedRegistry: ModelRegistry | null | undefined

export function readModelRegistry(
  paths: readonly string[] = modelRegistryPaths(),
): ModelRegistry | null {
  if (cachedRegistry !== undefined) return cachedRegistry
  cachedRegistry = null
  for (const path of paths) {
    try {
      if (!existsSync(path)) continue
      const raw = readFileSync(path, "utf-8")
      const parsed = JSON.parse(raw) as ModelRegistry
      if (parsed && typeof parsed === "object") {
        cachedRegistry = parsed
        return cachedRegistry
      }
    } catch {
      // Try the next candidate.
    }
  }
  return cachedRegistry
}

/** Test seam: drop the cached registry. */
export function resetModelRegistryCache(): void {
  cachedRegistry = undefined
}

/**
 * Resolve the context window for a model.
 *
 * `override` (the explicit user config) always wins. Otherwise the
 * registry is consulted. The registry is read at most once per process —
 * it is 5 MB of JSON and does not change while opencode runs.
 */
export function resolveModelLimit(input: {
  readonly override?: number
  readonly modelID?: string
  readonly providerID?: string
  readonly registry?: ModelRegistry | null
}): number {
  if (typeof input.override === "number" && input.override > 0) return input.override
  // The registry read is deferred to HERE — the caller that actually needs
  // the window. Reading it eagerly cost 430ms per plugin creation.
  const registry = input.registry !== undefined ? input.registry : readModelRegistry()
  if (!registry) return FALLBACK_MODEL_LIMIT
  const found = lookupContextWindow(registry, input.modelID, input.providerID)
  return found ?? FALLBACK_MODEL_LIMIT
}
