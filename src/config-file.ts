/**
 * JSONC config file loader for omo-meta-governor.
 *
 * Loads `omo-meta-governor.jsonc` from three layers (closer wins):
 *   1. CLI inline options (opts object) — highest priority
 *   2. Project config: `.opencode/omo-meta-governor.jsonc`
 *   3. User config: `~/.config/opencode/omo-meta-governor.jsonc`
 *   4. Defaults — lowest priority
 *
 * JSONC support: comments (//, /* * /) and trailing commas are stripped
 * before parsing. The raw JSON object is then projected into
 * `MetaGovernorPluginConfig` via `loadOrchestratorConfig()`.
 */

import { readFile, access } from "node:fs/promises"
import { resolve, join } from "node:path"
import { homedir } from "node:os"
import type { MetaGovernorPluginConfig } from "./config"

// ─── File name ─────────────────────────────────────────────────────

const CONFIG_FILE_NAME = "omo-meta-governor.jsonc"

// ─── JSONC parsing ─────────────────────────────────────────────────

/**
 * Strip JSONC comments (single-line // style and multi-line bracket style)
 * and trailing commas from a JSONC string so it can be parsed by JSON.parse.
 *
 * Handles:
 *   - // single-line comments
 *   - /asterisk ... asterisk/ multi-line comments
 *   - Trailing commas before ] or }
 *   - Strings containing comments (preserved)
 */
export function stripJsoncComments(jsonc: string): string {
  const result: string[] = []
  let i = 0

  while (i < jsonc.length) {
    const ch = jsonc[i]!

    // Detect string literal
    if (ch === '"' || ch === "'") {
      const quote = ch
      result.push(quote)
      i++
      while (i < jsonc.length) {
        const c = jsonc[i]!
        result.push(c)
        if (c === '\\') {
          i++
          if (i < jsonc.length) {
            result.push(jsonc[i]!)
          }
        } else if (c === quote) {
          i++
          break
        }
        i++
      }
      continue
    }

    // Single-line comment
    if (ch === '/' && i + 1 < jsonc.length && jsonc[i + 1] === '/') {
      i += 2
      while (i < jsonc.length && jsonc[i] !== '\n') {
        i++
      }
      continue
    }

    // Multi-line comment
    if (ch === '/' && i + 1 < jsonc.length && jsonc[i + 1] === '*') {
      i += 2
      while (i < jsonc.length) {
        if (jsonc[i] === '*' && i + 1 < jsonc.length && jsonc[i + 1] === '/') {
          i += 2
          break
        }
        i++
      }
      continue
    }

    result.push(ch)
    i++
  }

  // Strip trailing commas before ] or }
  let cleaned = result.join("")
  // Handle multiple passes for nested structures
  for (let pass = 0; pass < 10; pass++) {
    const before = cleaned
    cleaned = cleaned.replace(/,(\s*[\]}])/g, "$1")
    if (cleaned === before) break
  }

  return cleaned
}

/**
 * Parse a JSONC string into a JavaScript object.
 * Returns undefined on parse failure.
 */
export function parseJsonc<T = Record<string, unknown>>(jsonc: string): T | undefined {
  try {
    const cleaned = stripJsoncComments(jsonc)
    return JSON.parse(cleaned) as T
  } catch {
    return undefined
  }
}

// ─── Config paths ──────────────────────────────────────────────────

/**
 * Get the user-level config file path.
 */
export function getUserConfigPath(): string {
  return resolve(homedir(), ".config", "opencode", CONFIG_FILE_NAME)
}

/**
 * Get the project-level config file path for a given project directory.
 */
export function getProjectConfigPath(projectDir?: string): string {
  const base = projectDir ?? process.cwd()
  return join(base, ".opencode", CONFIG_FILE_NAME)
}

// ─── File existence check ──────────────────────────────────────────

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

// ─── Load single config file ───────────────────────────────────────

/**
 * Read and parse a single JSONC config file.
 * Returns undefined if the file does not exist or is unparseable.
 */
export async function loadJsoncFile<T = Record<string, unknown>>(
  filePath: string,
): Promise<T | undefined> {
  if (!(await fileExists(filePath))) return undefined
  try {
    const content = await readFile(filePath, "utf-8")
    return parseJsonc<T>(content)
  } catch {
    return undefined
  }
}

// ─── Merge two configs (deep merge, second wins) ───────────────────

/**
 * Deep-merge two config objects. Arrays are replaced (not concatenated).
 * The `source` values win when both exist.
 * Mutually recursive with mergeArrays=false for sub-objects.
 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>,
): T {
  const result = { ...target } as Record<string, unknown>

  for (const key of Object.keys(source)) {
    const srcVal = source[key as keyof typeof source]
    const tgtVal = result[key]

    if (srcVal === undefined) continue

    if (
      isPlainObject(srcVal) &&
      isPlainObject(tgtVal)
    ) {
      result[key] = deepMerge(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>)
    } else {
      result[key] = srcVal
    }
  }

  return result as T
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// ─── Full config loading pipeline ──────────────────────────────────

export interface ConfigFileSources {
  /** CLI inline options (highest priority) */
  cliOptions?: Partial<MetaGovernorPluginConfig>
  /** Project directory for project-level config lookup */
  projectDir?: string
}

export interface ConfigFileResult {
  /** The merged MetaGovernorPluginConfig */
  config: Partial<MetaGovernorPluginConfig>
  /** Which source files were loaded */
  sources: string[]
  /** Which source was the effective highest-priority non-empty source */
  effectiveSource: "cli" | "project" | "user" | "defaults"
}

/**
 * Load the MetaGovernor config from all available sources with priority:
 *   CLI inline > project `.opencode/omo-meta-governor.jsonc` >
 *   user `~/.config/opencode/omo-meta-governor.jsonc` > defaults
 *
 * Higher-priority sources override lower-priority ones.
 */
export async function loadMetaGovernorConfig(
  sources: ConfigFileSources = {},
): Promise<ConfigFileResult> {
  const loadedSources: string[] = []
  let effectiveSource: ConfigFileResult["effectiveSource"] = "defaults"

  // Start with empty config (defaults applied later by loadOrchestratorConfig)
  let merged: Partial<MetaGovernorPluginConfig> = {}

  // 1. User config (lowest file priority)
  const userPath = getUserConfigPath()
  const userConfig = await loadJsoncFile<Partial<MetaGovernorPluginConfig>>(userPath)
  if (userConfig) {
    merged = deepMerge(merged, userConfig)
    loadedSources.push(`user:${userPath}`)
    effectiveSource = "user"
  }

  // 2. Project config (medium file priority)
  const projectPath = getProjectConfigPath(sources.projectDir)
  const projectConfig = await loadJsoncFile<Partial<MetaGovernorPluginConfig>>(projectPath)
  if (projectConfig) {
    merged = deepMerge(merged, projectConfig)
    loadedSources.push(`project:${projectPath}`)
    effectiveSource = "project"
  }

  // 3. CLI inline options (highest priority)
  if (sources.cliOptions && Object.keys(sources.cliOptions).length > 0) {
    merged = deepMerge(merged, sources.cliOptions)
    loadedSources.push("cli:inline")
    effectiveSource = "cli"
  }

  return {
    config: merged,
    sources: loadedSources,
    effectiveSource,
  }
}
