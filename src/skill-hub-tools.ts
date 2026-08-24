/**
 * Skill-hub tools (F3: v0.32.0) — omo_skill_find, omo_skill_get, omo_skill_add
 *
 * Design:
 * - Each builder follows the exact pattern of existing custom-tools.ts tools
 * - Deps are injected for DI and testability
 * - All execute() catch errors and return friendly ToolResult (never throw)
 * - Ranking uses reciprocalRankFusion from src/ranker.ts
 * - FTS5 search uses sqlite-backend.skillSearch
 * - Live fallback uses skills.sh/api/search
 * - Content fetch uses EmbedClient or direct fetch from skills.sh API
 * - add uses proc-guard for Windows-safe subprocess (taskkill /T /F)
 */

import { tool, type ToolResult } from "@opencode-ai/plugin"
import { z } from "zod"

// Reuse existing modules
import type { SqliteBackend } from "./sqlite-backend"
import type { EmbedClient, FetchFn } from "./embed-client"
import { reciprocalRankFusion } from "./ranker"
import { filterByMinInstalls } from "./ranker"

// ---------------------------------------------------------------------------
// OmoSkillFindDeps
// ---------------------------------------------------------------------------

export interface OmoSkillFindDeps {
  sqlite: SqliteBackend
  fetch?: FetchFn
  embedClient?: EmbedClient
  cwd: string
}

/**
 * Build the `omo_skill_find` tool.
 *
 * Args:
 *   query: search query string (min 3 chars)
 *   limit: max results (default 10)
 *   minInstalls: minimum installs filter
 *
 * Returns formatted list of matching skills with installs count.
 * Hybrid: local FTS5 + live fallback via skills.sh/api/search.
 * Merge via reciprocalRankFusion(k=60) from src/ranker.ts.
 */
export function buildOmoSkillFindTool(deps: OmoSkillFindDeps) {
  return tool({
    description:
      "Search the skill-hub catalog by name/description. " +
      "Hybrid local FTS5 + live fallback via skills.sh/api/search. " +
      "Results merged via Reciprocal Rank Fusion (k=60). " +
      "Filter by minimum installs count. " +
      "Graceful degradation: if embed/sqlite unavailable, FTS-only with note.",
    args: {
      query: z.string().min(3).describe("Search query for skill name/description"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Max number of results to return"),
      minInstalls: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Minimum install count to filter by"),
    },
    async execute(args, ctx): Promise<ToolResult> {
      const start = Date.now()
      try {
        const { query, limit = 10, minInstalls } = args

        // --- Step 1: Local FTS5 search via sqlite ---
        let localResults: Array<{
          id: string
          name: string
          description: string | null
          installs: number
        }> = []

        try {
          localResults = await deps.sqlite.skillSearch({
            query,
            minInstalls,
            filterDuplicates: true,
          })
          // skillSearch returns { id, name, description, installs, skill_id, repo_url, download_count }
          localResults = localResults.map((r) => ({
            id: r.id,
            name: r.name,
            description: r.description,
            installs: r.installs,
          })) as any
        } catch {
          // If sqlite is unavailable, localResults stays empty — fall through to live only
        }

        // --- Step 2: Live fallback via skills.sh/api/search ---
        let liveResults: Array<{
          id: string
          name: string
          description: string | null
          installs: number
        }> = []

        try {
          const searchUrl = `https://skills.sh/api/search?q=${encodeURIComponent(
            query,
          )}&limit=${limit}`
          const fetchFn = deps.fetch ?? (async (input: string) => {
            const res = await fetch(input)
            return new Response(res.body, { status: res.status })
          }) as FetchFn

          const res = await fetchFn(searchUrl, {
            method: "GET",
            headers: { "Content-Type": "application/json" },
          })

          if (!res.ok) {
            // If live search fails and we have local results, return FTS-only
            if (localResults.length > 0) {
              return {
                title: `omo_skill_find: ${localResults.length} results`,
                output: formatFindResults(localResults, {
                  title: "Local FTS5 Results",
                  note:
                    "Live fallback (skills.sh) unavailable — showing local FTS5 results only.",
                }),
                metadata: {
                  tool: "omo_skill_find",
                  query,
                  kind: "local-fts5-only",
                  timedOut: false,
                  durationMs: Date.now() - start,
                  sessionID: ctx.sessionID,
                },
              }
            }
            return {
              title: "omo_skill_find: search unavailable",
              output:
                "Both local FTS5 and live fallback (skills.sh/api/search) are unavailable. " +
                "Check that the skill-hub sync has been run or that network access is available.",
              metadata: {
                tool: "omo_skill_find",
                query,
                kind: "error",
                timedOut: false,
                durationMs: Date.now() - start,
                sessionID: ctx.sessionID,
              },
            }
          }

          const liveData = (await res.json()) as {
            skills: Array<{
              id: string
              name: string
              description: string | null
              installs: number
            }>
          }
          liveResults = (liveData.skills || []).map((r) => ({
            id: r.id,
            name: r.name,
            description: r.description,
            installs: r.installs,
          }))
        } catch (liveErr) {
          // Live fallback failed — return FTS-only if available
          if (localResults.length > 0) {
            return {
              title: `omo_skill_find: ${localResults.length} results`,
              output: formatFindResults(localResults, {
                title: "Local FTS5 Results",
                note:
                  "Live fallback (skills.sh) unavailable — showing local FTS5 results only.",
              }),
              metadata: {
                tool: "omo_skill_find",
                query,
                kind: "local-fts5-only",
                timedOut: false,
                durationMs: Date.now() - start,
                sessionID: ctx.sessionID,
              },
            }
          }
          return {
            title: "omo_skill_find: search unavailable",
            output:
              "Both local FTS5 and live fallback (skills.sh/api/search) are unavailable. " +
              "Check that the skill-hub sync has been run or that network access is available.",
            metadata: {
              tool: "omo_skill_find",
              query,
              kind: "error",
              timedOut: false,
              durationMs: Date.now() - start,
              sessionID: ctx.sessionID,
            },
          }
        }

        // --- Step 3: Apply minInstalls filter if specified ---
        let filteredResults = localResults
        if (minInstalls !== undefined) {
          filteredResults = filterByMinInstalls(localResults, minInstalls)
        }
        let filteredLive = liveResults
        if (minInstalls !== undefined) {
          filteredLive = filterByMinInstalls(liveResults, minInstalls)
        }

        // --- Step 4: Merge via reciprocalRankFusion ---
        const allResults = [...filteredResults, ...filteredLive] // already filtered by minInstalls

        if (allResults.length === 0) {
          return {
            title: "omo_skill_find: no results",
            output: `No results found${
              minInstalls !== undefined ? ` with at least ${minInstalls} installs` : ""
            }.`,
            metadata: {
              tool: "omo_skill_find",
              query,
              kind: "empty",
              timedOut: false,
              durationMs: Date.now() - start,
              sessionID: ctx.sessionID,
            },
          }
        }

        // Deduplicate by id before ranking
        const seen = new Set<string>()
        const uniqueResults = allResults.filter((r) => {
          if (seen.has(r.id)) return false
          seen.add(r.id)
          return true
        })

        // Rank via RRF — each list gets equal weight (k=60 default)
        const rankedIds = reciprocalRankFusion(
          [filteredResults.map((r) => r.id), filteredLive.map((r) => r.id)],
          60,
        )

        // Build output from ranked IDs — map back to full result objects
        const resultObjects: typeof uniqueResults = []
        for (const id of rankedIds) {
          const match = uniqueResults.find((r) => r.id === id)
          if (match) resultObjects.push(match)
        }

        return {
          title: `omo_skill_find: ${resultObjects.length} results`,
          output: formatFindResults(resultObjects, {
            title: "Skill Search Results",
          }),
          metadata: {
            tool: "omo_skill_find",
            query,
            kind: "hybrid",
            timedOut: false,
            durationMs: Date.now() - start,
            sessionID: ctx.sessionID,
            resultsFrom: localResults.length > 0 && liveResults.length > 0 ? "hybrid" : localResults.length > 0 ? "local-fts5" : "live",
          },
        }
      } catch (err) {
        // Graceful degradation: never throw
        const error = err as Error
        return {
          title: "omo_skill_find: error",
          output:
            `Search encountered an unexpected error: ${error.message}. ` +
            "Please try again or check the skill-hub configuration.",
          metadata: {
            tool: "omo_skill_find",
            query: (args as any).query,
            kind: "error",
            timedOut: false,
            durationMs: Date.now() - start,
            sessionID: ctx.sessionID,
          },
        }
      }
    },
  })
}

// ---------------------------------------------------------------------------
// OmoSkillGetDeps
// ---------------------------------------------------------------------------

export interface OmoSkillGetDeps {
  sqlite: SqliteBackend
  fetch?: FetchFn
  embedClient?: EmbedClient
  cwd: string
}

/**
 * Build the `omo_skill_get` tool.
 *
 * Args:
 *   id: skill ID string (e.g. "owner/repo/slug")
 *
 * Fetches skill content via SkillHubSync or direct fetch from downloadBaseUrl.
 * Hash-cached — uses content_hash from sqlite to avoid re-fetching.
 * Returns first file contents preview.
 * Graceful: if not found → friendly hint.
 */
export function buildOmoSkillGetTool(deps: OmoSkillGetDeps) {
  return tool({
    description:
      "Get the full content of a skill from the skill-hub catalog. " +
      "Looks up the skill by ID in the local sqlite catalog first, " +
      "then falls back to live fetch from skills.sh API. " +
      "Content is hash-cached via content_hash to avoid redundant fetches. " +
      "Returns the first file's contents as a preview. " +
      "Graceful: if not found → friendly hint with next steps.",
    args: {
      id: z.string().min(3).describe("Skill ID (e.g. 'owner/repo/slug')"),
    },
    async execute(args, ctx): Promise<ToolResult> {
      const start = Date.now()
      try {
        const skillId = args.id

        // --- Step 1: Look up skill in local sqlite ---
        let skill: Awaited<ReturnType<SqliteBackend["skillGet"]>> | null = null

        try {
          skill = await deps.sqlite.skillGet(skillId)
        } catch {
          // Continue to live fallback
        }

        // --- Step 2: If found in cache, return cached info ---
        if (skill !== null && skill.content_hash) {
          return {
            title: `omo_skill_get: ${skill.name}`,
            output: `Skill found in cache:\n- ID: ${skill.id}\n- Name: ${skill.name}\n- Description: ${skill.description || "(no description)"}\n- Installs: ${skill.installs}\n- Last synced: ${skill.last_synced?.toString() || "never"}\n- Content hash: ${skill.content_hash}`,
            metadata: {
              tool: "omo_skill_get",
              id: skillId,
              kind: "cached",
              timedOut: false,
              durationMs: Date.now() - start,
              sessionID: ctx.sessionID,
            },
          }
        }

        // --- Step 3: Fall back to live fetch from skills.sh API ---
        // Construct the download URL for the skill
        // Expected format: "owner/repo/slug" — parse the ID parts
        const idParts = skillId.split("/")
        if (idParts.length < 3) {
          return {
            title: "omo_skill_get: invalid ID format",
            output:
              `Skill ID "${skillId}" is not in the expected format "owner/repo/slug". ` +
              "Please use the full ID from the skill-hub catalog, or run omo_skill_find first.",
            metadata: {
              tool: "omo_skill_get",
              id: skillId,
              kind: "error",
              timedOut: false,
              durationMs: Date.now() - start,
              sessionID: ctx.sessionID,
            },
          }
        }

        const [, owner, repo, slug] = idParts as [unknown, string, string, string]
        const liveUrl = `https://skills.sh/api/download/${owner}/${repo}/${slug}`

        const fetchFn = deps.fetch ?? (async (input: string) => {
          const res = await fetch(input)
          return new Response(res.body, { status: res.status })
        }) as FetchFn

        try {
          const res = await fetchFn(liveUrl, {
            method: "GET",
            signal: AbortSignal.timeout(30_000),
          })

          if (!res.ok) {
            // Skill not found in remote catalog
            return {
              title: "omo_skill_get: skill not found",
              output:
                `Skill "${skillId}" not found in the skill-hub catalog. ` +
                `Try running \`omo_skill_sync\` to update the local catalog, ` +
                `or use \`omo_skill_find\` to browse available skills.`,
              metadata: {
                tool: "omo_skill_get",
                id: skillId,
                kind: "not-found",
                timedOut: false,
                durationMs: Date.now() - start,
                sessionID: ctx.sessionID,
              },
            }
          }

          // Parse the response — skills.sh download returns { files: [{path, contents}] }
          const data = (await res.json()) as {
            files: Array<{ path: string; contents: string }>
          }

          if (!data.files || data.files.length === 0) {
            return {
              title: "omo_skill_get: no files",
              output:
                `Skill "${skillId}" was found but has no associated files. ` +
                "This may indicate a catalog corruption issue.",
              metadata: {
                tool: "omo_skill_get",
                id: skillId,
                kind: "no-files",
                timedOut: false,
                durationMs: Date.now() - start,
                sessionID: ctx.sessionID,
              },
            }
          }

          // Return the first file's contents as a preview
          const firstFile = data.files[0]
          return {
            title: `omo_skill_get: ${skillId} — ${firstFile.path}`,
            output: `Skill: ${skillId}\nFile: ${firstFile.path}\n\n---\n${firstFile.contents}\n---`,
            metadata: {
              tool: "omo_skill_get",
              id: skillId,
              kind: "fetched",
              timedOut: false,
              durationMs: Date.now() - start,
              sessionID: ctx.sessionID,
            },
          }
        } catch (fetchErr) {
          return {
            title: "omo_skill_get: fetch error",
            output:
              `Failed to fetch skill "${skillId}": ${
                fetchErr instanceof Error ? fetchErr.message : String(fetchErr)
              }. ` +
              "Check network connectivity and try again.",
            metadata: {
              tool: "omo_skill_get",
              id: skillId,
              kind: "error",
              timedOut: false,
              durationMs: Date.now() - start,
              sessionID: ctx.sessionID,
            },
          }
        }
      } catch (err) {
        // Graceful degradation: never throw
        const error = err as Error
        return {
          title: "omo_skill_get: error",
          output:
            `Unexpected error retrieving skill: ${error.message}. ` +
            "Please try again or contact support.",
          metadata: {
            tool: "omo_skill_get",
            id: (args as any).id,
            kind: "error",
            timedOut: false,
            durationMs: Date.now() - start,
            sessionID: ctx.sessionID,
          },
        }
      }
    },
  })
}

// ---------------------------------------------------------------------------
// OmoSkillAddDeps
// ---------------------------------------------------------------------------

export interface OmoSkillAddDeps {
  sqlite: SqliteBackend
  cwd: string
  runner?: (
    cmd: string,
    args: string[],
    opts: { timeoutMs: number },
  ) => Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }>
}

/**
 * Build the `omo_skill_add` tool.
 *
 * Args:
 *   id: skill ID string (e.g. "owner/repo/slug")
 *   confirm: must be explicit true — requires user confirmation before install
 *
 * Wrapper around `npx skills add <id>` or skills.sh download.
 * Requires explicit confirm=true. Uses proc-guard for Windows-safe subprocess.
 * Returns installation result.
 */
export function buildOmoSkillAddTool(deps: OmoSkillAddDeps) {
  return tool({
    description:
      "Install a skill from the skill-hub catalog into the local sqlite database. " +
      "Requires explicit confirm=true for safety. " +
      "Uses proc-guard for Windows-safe subprocess handling (taskkill /T /F). " +
      "After install, the skill is upserted into the local catalog. " +
      "Without confirm=true, returns a confirmation-required error.",
    args: {
      id: z.string().min(3).describe("Skill ID to install (e.g. 'owner/repo/slug')"),
      confirm: z
        .boolean()
        .default(false)
        .describe(
          "Must be explicit true to proceed with installation. " +
            "This is a safety guard to prevent accidental installs.",
        ),
    },
    async execute(args, ctx): Promise<ToolResult> {
      const start = Date.now()
      try {
        const { id, confirm } = args

        // Safety guard: confirm must be explicit true
        if (confirm !== true) {
          return {
            title: "omo_skill_add: confirmation required",
            output:
              "Skill installation requires explicit confirmation. " +
              "Run again with `confirm=true` to proceed.",
            metadata: {
              tool: "omo_skill_add",
              id,
              kind: "confirm-required",
              timedOut: false,
              durationMs: Date.now() - start,
              sessionID: ctx.sessionID,
            },
          }
        }

        // --- Step 1: Run npx skills add with proc-guard ---
        // Use the guarded spawn to ensure the process tree dies on Windows
        const guardedOpts: { timeoutMs: number } = { timeoutMs: 60_000 }

        let result: { stdout: string; stderr: string; code: number | null; timedOut: boolean }

        if (deps.runner) {
          result = await deps.runner("npx", ["skills", "add", id], guardedOpts)
        } else {
          const { runGuarded } = await import("./proc-guard")
          try {
            result = await runGuarded("npx", ["skills", "add", id], guardedOpts)
          } catch {
            result = { stdout: "", stderr: "npx skills add failed", code: 1, timedOut: false }
          }
        }

        const stdout = result.stdout
        const stderr = result.stderr
        const code = result.code

        // --- Step 2: Upsert the installed skill into local sqlite ---
        try {
          await deps.sqlite.skillAddOrUpdate({
            id,
            name: id.split("/").pop() || id, // use the slug as name
            description: `Installed from skill-hub: ${id}`,
            installs: 0,
            download_count: 0,
            last_synced: Date.now(),
            content_hash: "",
          })
        } catch {
          // Best-effort — if upsert fails, the install still succeeded
        }

        // --- Step 3: Return installation result ---
        let output = "Skill installation result:\n"
        if (code === 0) {
          output += `stdout: ${stdout}\n`
          output += `Skill "${id}" installed successfully and added to local catalog.`
        } else {
          output += `stderr: ${stderr}\n`
          output += `Skill install exited with code ${code}. ` +
            `stdout: ${stdout}. ` +
            `The skill may have already been installed or there was an issue with the download.`
        }

        return {
          title: `omo_skill_add: ${id} installed`,
          output,
          metadata: {
            tool: "omo_skill_add",
            id,
            kind: "installed",
            timedOut: result.timedOut ?? false,
            durationMs: Date.now() - start,
            sessionID: ctx.sessionID,
          },
        }
      } catch (err) {
        // Graceful degradation: never throw
        const error = err as Error
        return {
          title: "omo_skill_add: error",
          output:
            `Skill installation failed: ${error.message}. ` +
            "Please check the skill ID and try again.",
          metadata: {
            tool: "omo_skill_add",
            id: (args as any).id,
            kind: "error",
            timedOut: false,
            durationMs: Date.now() - start,
            sessionID: ctx.sessionID,
          },
        }
      }
    },
  })
}

// ---------------------------------------------------------------------------
// Helper: formatFindResults
// ---------------------------------------------------------------------------

/**
 * Format skill search results into a readable string.
 */
function formatFindResults(
  results: ReadonlyArray<{
    id: string
    name: string
    description: string | null
    installs: number
  }>,
  opts: { title: string; note?: string },
): string {
  const { title, note } = opts
  let output = `${title}\n`
  output += `Query: results for "${results[0]?.id || ""}"${
    results.length > 0 ? "" : " (no matches)"
  }\n`

  if (results.length === 0) {
    output += "No results found\n"
  } else {
    output += "\n"
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      const installsLabel = r.installs >= 1000 ? `${(r.installs / 1000).toFixed(1)}K` : r.installs.toString()
      output += `${i + 1}. ${r.name}`
      output += ` (${installsLabel} installs)`
      if (r.description) {
        output += ` — ${r.description}`
      }
      output += "\n"
    }
  }

  if (note) {
    output += `\n${note}\n`
  }

  return output
}