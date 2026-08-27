/**
 * skills-create-tool.ts - omo_skill_create tool.
 *
 * v0.35.9: Last-resort scaffold. When `omo_skill_semantic_find` returns no
 * useful hits (or the agent knows the skill it wants but the catalog lacks
 * it), the agent can describe what the skill should do and we write a
 * canonical SKILL.md into the project's <cwd>/.agents/skills/<slug>/.
 *
 * The scaffolded SKILL.md has valid frontmatter (name + description) so
 * downstream consumers (skills-resolver, skills-semantic-index) pick it up.
 */
import { tool, type ToolResult } from "@opencode-ai/plugin"
import { z } from "zod"
import { mkdirSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { projectSkillsRoot, skillSlugFromId } from "./skills-catalog.js"

export interface OmoSkillCreateDeps {
  cwd: string
}

export interface CreatedSkill {
  slug: string
  path: string
  existed: boolean
}

/**
 * Pure helper: validate slug + write SKILL.md with frontmatter. Returns
 * the created/overwritten path. Throws on IO failure.
 */
export function writeSkillScaffold(
  projectCwd: string,
  id: string,
  description: string,
  body: string,
): CreatedSkill {
  const slug = skillSlugFromId(id)
  const root = projectSkillsRoot(projectCwd)
  const skillDir = join(root, slug)
  const skillMdPath = join(skillDir, "SKILL.md")
  const existed = existsSync(skillMdPath)
  mkdirSync(skillDir, { recursive: true })
  const safeDescription = description.replace(/"/g, '\\"').replace(/\r?\n/g, " ")
  const safeBody = body.replace(/\r?\n$/, "")
  const content =
    `---\n` +
    `name: ${slug}\n` +
    `description: "${safeDescription}"\n` +
    `---\n\n` +
    `# ${slug}\n\n` +
    `${safeBody}\n`
  writeFileSync(skillMdPath, content, "utf8")
  return { slug, path: skillMdPath, existed }
}

export function buildOmoSkillCreateTool(deps: OmoSkillCreateDeps) {
  return tool({
    description:
      "Create a local skill scaffold at <project>/.agents/skills/<slug>/SKILL.md " +
      "with valid frontmatter (name + description). Use as a last-resort when " +
      "omo_skill_find and omo_skill_semantic_find cannot locate a suitable skill " +
      "in the catalog. The scaffold becomes immediately discoverable by the " +
      "resolver and the semantic index on the next search. After creating, you " +
      "should edit the body of SKILL.md with the actual skill instructions.",
    args: {
      id: z
        .string()
        .min(3)
        .describe(
          "Skill identifier. The last path segment becomes the slug " +
          "(e.g. 'my-team/fastapi-skill' -> slug 'fastapi-skill').",
        ),
      description: z
        .string()
        .min(10)
        .max(500)
        .describe(
          "One-line description of what the skill does. Goes into the " +
          "SKILL.md frontmatter and is what semantic search will embed.",
        ),
      body: z
        .string()
        .min(20)
        .describe(
          "Initial SKILL.md body (markdown). After creating, edit the file to " +
          "fill in the actual instructions. Should be at least the section " +
          "headers the skill needs.",
        ),
      overwrite: z
        .boolean()
        .default(false)
        .describe(
          "If the SKILL.md already exists at the target path, overwrite it. " +
          "Default false: refuses to clobber an existing skill.",
        ),
    },
    async execute(args, _ctx): Promise<ToolResult> {
      const slug = skillSlugFromId(args.id)
      const root = projectSkillsRoot(deps.cwd)
      const skillMdPath = join(root, slug, "SKILL.md")
      const existed = existsSync(skillMdPath)
      if (existed && !args.overwrite) {
        return {
          title: `omo_skill_create: ${slug} already exists`,
          output:
            `Skill already exists at ${skillMdPath}.\n` +
            `Re-run with overwrite=true to replace it, or pick a different id.`,
          metadata: {
            tool: "omo_skill_create",
            id: args.id,
            slug,
            ok: false,
            existed: true,
            reason: "already-exists",
          },
        }
      }
      try {
        const result = writeSkillScaffold(deps.cwd, args.id, args.description, args.body)
        return {
          title: existed
            ? `omo_skill_create: ${slug} overwritten`
            : `omo_skill_create: ${slug} created`,
          output:
            `${existed ? "Overwrote" : "Created"} scaffold at:\n` +
            `  ${result.path}\n\n` +
            `Next steps:\n` +
            `1. Edit the file to fill in the skill body.\n` +
            `2. Re-run omo_skill_semantic_find with a query that targets this skill — ` +
            `it will be discovered automatically (semantic index invalidates on mtime).\n` +
            `3. Optionally omo_skill_link to mirror into ~/.agents/skills/ for reuse.`,
          metadata: {
            tool: "omo_skill_create",
            id: args.id,
            slug,
            ok: true,
            existed,
            path: result.path,
          },
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          title: `omo_skill_create: ${slug} failed`,
          output: `Failed to write scaffold: ${msg}`,
          metadata: {
            tool: "omo_skill_create",
            id: args.id,
            slug,
            ok: false,
            error: msg,
          },
        }
      }
    },
  })
}