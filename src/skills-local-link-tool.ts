/**
 * skills-local-link.ts - omo_skill_local_link tool.
 *
 * v0.35.8: symlink or copy from the global cache (~/.agents/skills/<slug>/)
 * to the project-local .agents/skills/<slug>/. Idempotent. Falls back from
 * symlink (junction on Windows) to recursive copy on failure.
 */
import { tool, type ToolResult } from "@opencode-ai/plugin"
import { z } from "zod"
import { ensureProjectLocalLink, listGlobalSkills, skillSlugFromId } from "./skills-catalog.js"

export interface OmoSkillLocalLinkDeps {
  cwd: string
}

export function buildOmoSkillLocalLinkTool(deps: OmoSkillLocalLinkDeps) {
  return tool({
    description:
      "Link a skill from the global chore cache (~/.agents/skills/<slug>/) into the " +
      "current project's .agents/skills/<slug>/. Tries symlink (junction on Windows) " +
      "first, falls back to recursive copy. Idempotent — if the local entry already " +
      "exists, returns noop-already-exists. Returns mechanism, globalPath, localPath, " +
      "and optional reason on failure.",
    args: {
      id: z
        .string()
        .min(1)
        .describe(
          "Skill ID to link, e.g. 'owner/repo' or 'owner/repo/skill'. " +
          "If omitted, lists all globally cached skills.",
        )
        .optional(),
    },
    async execute(args, ctx) {
      if (!args.id) {
        const slugs = listGlobalSkills()
        return {
          title: `omo_skill_local_link: ${slugs.length} global skill(s) available`,
          output: slugs.length === 0
            ? "No skills in global cache. Run omo_skill_add <id> first."
            : `Global cache contents (${slugs.length}):\n` +
              slugs.map((s) => `  - ${s}`).join("\n") +
              "\n\nPass `id` to link a specific one into this project.",
          metadata: { tool: "omo_skill_local_link", count: slugs.length },
        }
      }

      const slug = skillSlugFromId(args.id)
      const result = ensureProjectLocalLink(args.id, deps.cwd)

      let output = ""
      switch (result.mechanism) {
        case "symlink":
          output = `Linked (symlink/junction):\n  ${result.localPath}\n  -> ${result.globalPath}`
          break
        case "copy":
          output = `Linked (recursive copy):\n  ${result.localPath}\n  <- ${result.globalPath}`
          if (result.reason) output += `\n  Note: ${result.reason}`
          break
        case "noop-already-exists":
          output = `Already present:\n  ${result.localPath}`
          if (result.reason) output += `\n  (${result.reason})`
          break
      }
      if (!result.ok && result.reason) output = `Failed: ${result.reason}\n${output}`

      return {
        title: result.ok
          ? `omo_skill_local_link: ${slug} ${result.mechanism}`
          : `omo_skill_local_link: ${slug} failed`,
        output,
        metadata: {
          tool: "omo_skill_local_link",
          id: args.id,
          slug,
          ok: result.ok,
          mechanism: result.mechanism,
          globalPath: result.globalPath,
          localPath: result.localPath,
        },
      }
    },
  })
}