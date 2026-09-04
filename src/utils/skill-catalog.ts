/**
 * FASE 8 helper: list chore skill names from `bundled-skills/` directory.
 * Used by the session-start directive to populate the system prompt with the
 * available skill catalog so the LLM can pick the right chore skill per task.
 */
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export function listBundledSkillNames(workspaceDir: string): string[] {
  const dir = join(workspaceDir, "bundled-skills");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => n !== "node_modules" && !n.startsWith("."))
      .sort();
  } catch {
    return [];
  }
}
