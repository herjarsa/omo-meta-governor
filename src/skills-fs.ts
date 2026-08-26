import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * Skills filesystem primitives — frontmatter parser and dir scanner.
 *
 * A skill is a directory containing a SKILL.md file with YAML frontmatter:
 *   ---
 *   name: brainstorming
 *   description: Use when creating features
 *   ---
 *   # Body content
 *
 * The raw body is preserved verbatim in `parsed.raw` so it can be returned
 * to the agent as the skill's full content.
 */

export interface ParsedSkillFrontmatter {
  name: string
  description: string
  raw: string
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

function parseYamlBlock(block: string): Record<string, string> {
  // Minimal YAML parser for skill frontmatter: flat string keys only.
  // Avoids a full yaml lib dependency for ~20 lines of skill metadata.
  const out: Record<string, string> = {}
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/)
    if (!m) continue
    const key = m[1]!
    let value = m[2] ?? ""
    // Reject YAML constructs the flat-only parser cannot handle:
    // unquoted `[` (sequence), unquoted `{` (mapping), or an unclosed quote.
    if ((value.length > 0 && (value[0] === "[" || value[0] === "{")) ||
        ((value.startsWith('"') && !value.endsWith('"')) ||
         (value.startsWith("'") && !value.endsWith("'")))) {
      throw new Error("SKILL.md frontmatter is malformed")
    }
    // strip surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

export function parseSkillFrontmatter(content: string): ParsedSkillFrontmatter {
  const match = FRONTMATTER_RE.exec(content)
  if (!match) {
    throw new Error("SKILL.md missing or malformed YAML frontmatter")
  }
  const yamlBlock = match[1] ?? ""
  const body = match[2] ?? ""
  const parsed = parseYamlBlock(yamlBlock)
  if (!parsed.name) {
    throw new Error("SKILL.md frontmatter missing required 'name' field")
  }
  return {
    name: parsed.name,
    description: parsed.description ?? "",
    raw: body,
  }
}

export async function scanSkillsDir(dir: string): Promise<Map<string, ParsedSkillFrontmatter>> {
  const out = new Map<string, ParsedSkillFrontmatter>()
  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out  // dir doesn't exist or unreadable; return empty
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillPath = join(dir, entry.name, "SKILL.md")
    try {
      const content = await readFile(skillPath, "utf8")
      const parsed = parseSkillFrontmatter(content)
      out.set(entry.name, parsed)
    } catch (err) {
      // skip malformed skills; do not throw
      console.warn(`[skills-fs] skipping ${entry.name}: ${(err as Error).message}`)
    }
  }
  return out
}
