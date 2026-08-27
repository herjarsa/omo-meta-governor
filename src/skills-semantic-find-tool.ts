/**
 * skills-semantic-find-tool.ts - omo_skill_semantic_find tool.
 *
 * v0.35.8: embeddings-backed skill search over the global chore catalog
 * (~/.agents/skills/*). Uses EmbedClient against the local embed-server
 * (pm2-managed, http://127.0.0.1:3114/v1). Lazy cache in
 * ~/.cache/omo-meta-governor/skill-embeddings.json with mtime invalidation.
 */
import { tool, type ToolResult } from "@opencode-ai/plugin"
import { z } from "zod"
import { semanticSearch, type IndexDeps } from "./skills-semantic-index.js"

export interface OmoSkillSemanticFindDeps extends IndexDeps {}

export function buildOmoSkillSemanticFindTool(deps: OmoSkillSemanticFindDeps) {
  return tool({
    description:
      "Semantic search over installed skills using vector embeddings. " +
      "Backs onto the local embed-server (bge-m3 by default) via EmbedClient. " +
      "Indexes ~/.agents/skills/* lazily and caches results in " +
      "~/.cache/omo-meta-governor/skill-embeddings.json. " +
      "Use this when you know what you want but not the exact skill id.",
    args: {
      query: z
        .string()
        .min(2)
        .describe("Natural-language query, e.g. 'python websocket server'."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(5)
        .describe("Max results to return (default 5, max 20)."),
    },
    async execute(args, _ctx): Promise<ToolResult> {
      try {
        const hits = await semanticSearch(deps, args.query, args.limit)
        if (hits.length === 0) {
          return {
            title: `omo_skill_semantic_find: 0 hits for "${args.query}"`,
            output:
              `No skills in the global cache match "${args.query}".\n` +
              `Install one with omo_skill_add <owner/repo> and retry.`,
            metadata: { tool: "omo_skill_semantic_find", query: args.query, count: 0 },
          }
        }
        const lines = hits.map(
          (h, i) =>
            `  ${i + 1}. ${h.slug}  (score ${h.score.toFixed(3)})\n` +
            `     ${h.text.slice(0, 200)}`,
        )
        return {
          title: `omo_skill_semantic_find: ${hits.length} hit(s) for "${args.query}"`,
          output:
            `Semantic matches for "${args.query}":\n` +
            lines.join("\n") +
            `\n\nLink into this project with omo_skill_local_link id=<slug>.`,
          metadata: {
            tool: "omo_skill_semantic_find",
            query: args.query,
            count: hits.length,
            hits: hits.map((h) => ({ slug: h.slug, score: h.score })),
          },
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          title: "omo_skill_semantic_find: error",
          output:
            `Semantic search failed: ${msg}\n\n` +
            `Check that the embed-server is running:\n` +
            `  pm2 list | grep embed-server\n` +
            `  curl http://${new URL(deps.baseUrl).host}/health`,
          metadata: { tool: "omo_skill_semantic_find", error: msg },
        }
      }
    },
  })
}