#!/usr/bin/env node
/**
 * v0.38.9 — postinstall bootstrap for ~/.config/opencode/AGENTS.md.
 *
 * Runs after `npm install @herjarsa/omo-meta-governor`. Appends an
 * idempotent snippet of meta-governor [SYSTEM-NUDGE] directives to the
 * user's global AGENTS.md so that sub-agents spawned outside the
 * opencode process still see the plugin's directives.
 *
 * Contract:
 * - Idempotent: detects the marker comments and skips re-write.
 * - Version-aware: upgrades in place when a newer version is installed.
 * - Safe: never overwrites user content; appends after.
 * - Non-fatal: catches all errors and logs to stderr, never throws.
 *   (postinstall must never break `npm install`.)
 * - Opt-out: `OMO_META_GOVERNOR_NO_BOOTSTRAP=1` skips entirely.
 *
 * PURE-JS so it runs under `node` (not `bun`) — npm consumers typically
 * don't have bun installed. The helper functions are inlined here to
 * avoid a TypeScript-module dependency. The same logic lives in
 * `src/bootstrap-agents-md.ts` (covered by unit tests); if you change
 * the snippet text or merge logic, update both.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ─── Constants (mirror src/bootstrap-agents-md.ts) ────────────────────────
const VERSION = "0.38.9";
const MARKER_OPEN = "<!-- META-GOVERNOR AUTO-INSTALL SNIPPET (";
const MARKER_CLOSE = "<!-- END META-GOVERNOR AUTO-INSTALL SNIPPET -->";
const TARGET = join(homedir(), ".config", "opencode", "AGENTS.md");

// ─── Helpers (mirror src/bootstrap-agents-md.ts) ──────────────────────────
function buildSnippet(version) {
  return [
    `${MARKER_OPEN}v${version}) -->`,
    "<!-- Auto-installed by @herjarsa/omo-meta-governor. Safe to remove. Will NOT reappear if OMO_META_GOVERNOR_NO_BOOTSTRAP=1. -->",
    "",
    "The following [SYSTEM-NUDGE] directives are pushed by the meta-governor",
    "plugin at runtime via `chat.system.transform` on every opencode session.",
    "They are also surfaced here (in AGENTS.md) so they reach agents that run",
    "outside the opencode process and never load the plugin. Keep both copies",
    "in sync if you customise them.",
    "",
    "[SYSTEM-NUDGE] Oracle Review Gate (v0.38.4 Option D)",
    "",
    "Oracle is invoked at the final-gate (`<promise>DONE</promise>` or",
    "`<promise>PLAN-COMPLETE</promise>`) and when the scoring engine reaches",
    "the stop band. `warn` / `escalate` are logged but do NOT auto-invoke.",
    "Configure frequency via `oracle.frequency` in omo-meta-governor.jsonc.",
    "",
    "[SYSTEM-NUDGE] Lesson Capture (omo_remember)",
    "",
    "After solving a non-obvious bug, learning a project rule, or discovering",
    "a config quirk, call `omo_remember` to persist it cross-session.",
    "Recall previous lessons before asking the user: `omo_recall query=\"<topic>\"`.",
    "On empty result, try `omo_recall_mcp` (cross-session AgentMemory bridge).",
    "DO NOT save routine operations or facts already covered by memory.",
    "",
    "[SYSTEM-NUDGE] Skill Priming (select before writing code)",
    "",
    "Before implementation work, query the skill-hub catalog for the 2-3",
    "capabilities most relevant to this task. Compose a minimal stack:",
    "1. `omo_skill_find \"<task type> <language>\" --limit 5`",
    "2. Inspect candidates with `omo_skill_get`",
    "3. Load selected skills via `omo_skill_add` (global cache) or",
    "   `omo_skill_create` if no catalog match.",
    "",
    "Primary discovery tools (use BEFORE grep/glob/raw read):",
    "- Architecture / concepts / cross-module relationships → `omo_search`",
    "- Symbol-level lookup, call graph, impact analysis → `omo_find` / `omo_impact`",
    "- Past lessons, decisions, prior solutions → `omo_recall`",
    "- Project status → `omo_health` / `omo_status`",
    "",
    "Do NOT enumerate the full catalog — keep the stack minimal and",
    "task-specific.",
    "",
    "[SYSTEM-NUDGE] Sisyphus Protocol Enforcement",
    "",
    "You MUST follow these rules:",
    "1. Codebase Graph First: Before grep/glob/read for architecture or",
    "   symbol queries, check whether codegraph/graphify exist. If so,",
    "   use them first, then grep/read only as last resort.",
    "2. Tool Routing:",
    "   - \"we did this before\" / \"you should know\" → `omo_recall`",
    "   - Starting a task that resembles a previous one → `omo_recall_mcp`",
    "   - Before asking the user a clarifying question → `omo_recall` first",
    "   - Save durable insight/decision/rule → `omo_remember`",
    "3. Parallel Query Rule: Fire independent tool queries in the same turn.",
    "   Do NOT serialize independent memory/context queries.",
    "4. Empty-Result Escalation: On empty `omo_recall`, try `omo_recall_mcp`",
    "   (cross-session bridge) before asking the user.",
    "5. Hard Rules (No Exceptions):",
    "   - Do NOT suppress type errors with `as any`, `@ts-ignore`,",
    "     `@ts-expect-error`.",
    "   - Do NOT leave empty catch blocks `catch(e) {}`.",
    "   - Do NOT start a fresh `task()` when `task(task_id=\"ses_...\")`",
    "     continuation exists.",
    "   - Do NOT batch-complete todos — mark each one completed immediately.",
    "   - Do NOT skip Oracle on 2+ file changes (post-task verification).",
    "6. CI Verification Loop (NON-NEGOTIABLE):",
    "   - After every push: `gh run watch <run-id> --exit-status`",
    "   - Assert `conclusion==success` on EVERY job.",
    "   - Never proceed on red CI.",
    "",
    MARKER_CLOSE,
  ].join("\n");
}

function installedVersion(content) {
  // Capture FULL version string including semver pre-release suffix
  // (e.g. "0.38.9-beta.1") so v0.38.9-beta is recognised as different
  // from v0.38.9.
  const m = content.match(/<!-- META-GOVERNOR AUTO-INSTALL SNIPPET \(v([^)]+)\) -->/);
  return m ? m[1] : null;
}

function isInstalled(content, version) {
  if (!content.includes(MARKER_OPEN) || !content.includes(MARKER_CLOSE)) return false;
  if (version === undefined) return true;
  return installedVersion(content) === version;
}

function stripSnippet(content) {
  const openIdx = content.indexOf(MARKER_OPEN);
  if (openIdx < 0) return content;
  const closeIdx = content.indexOf(MARKER_CLOSE, openIdx);
  if (closeIdx < 0) return content;
  const before = content.slice(0, openIdx).replace(/\s+$/, "");
  const after = content.slice(closeIdx + MARKER_CLOSE.length).replace(/^\s+/, "");
  if (!before) return after;
  if (!after) return before;
  return `${before}\n\n${after}`;
}

function appendSnippet(existing, snippet) {
  const trimmed = existing.replace(/\s+$/, "");
  return `${trimmed}\n\n${snippet}\n`;
}

function mergeInto(existing, snippet, version) {
  const existingVersion = installedVersion(existing);
  if (existingVersion === version) return existing;
  if (existingVersion !== null) {
    return appendSnippet(stripSnippet(existing), snippet);
  }
  if (!existing.trim()) {
    return [
      `# Auto-generated by @herjarsa/omo-meta-governor v${version}`,
      "# This file is read by opencode for every session. Edit freely.",
      "# The META-GOVERNOR snippet below is auto-managed by npm postinstall;",
      "# set OMO_META_GOVERNOR_NO_BOOTSTRAP=1 to disable re-installs.",
      "",
      snippet,
      "",
    ].join("\n");
  }
  return appendSnippet(existing, snippet);
}

// ─── Runtime ──────────────────────────────────────────────────────────────
function main() {
  if (process.env.OMO_META_GOVERNOR_NO_BOOTSTRAP === "1") {
    console.log("[bootstrap] skipped (OMO_META_GOVERNOR_NO_BOOTSTRAP=1)");
    return;
  }
  try {
    mkdirSync(dirname(TARGET), { recursive: true });
    const existing = existsSync(TARGET) ? readFileSync(TARGET, "utf-8") : "";
    if (isInstalled(existing, VERSION)) {
      console.log(`[bootstrap] v${VERSION} snippet already present at ${TARGET}, skipping`);
      return;
    }
    const snippet = buildSnippet(VERSION);
    const merged = mergeInto(existing, snippet, VERSION);
    writeFileSync(TARGET, merged, "utf-8");
    if (installedVersion(existing)) {
      console.log(`[bootstrap] upgraded to v${VERSION} at ${TARGET}`);
    } else {
      console.log(`[bootstrap] wrote v${VERSION} snippet to ${TARGET}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[bootstrap] failed (non-fatal): ${msg}`);
  }
}

main();
