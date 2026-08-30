#!/usr/bin/env node
/**
 * v0.39.0 — postinstall bootstrap for ~/.config/opencode/plugins/omo-meta-governor/instructions.md.
 *
 * Runs after `npm install @herjarsa/omo-meta-governor`. Appends an
 * idempotent snippet of meta-governor [SYSTEM-NUDGE] directives to the
 * user's plugin instructions.md so that sub-agents spawned outside the
 * opencode process still see the plugin's directives. Also strips the
 * old AGENTS.md snippet (v0.38.x backward-compat) and patches
 * opencode.jsonc `instructions` array.
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
const VERSION = "0.39.0";
const MARKER_OPEN = "<!-- META-GOVERNOR AUTO-INSTALL SNIPPET (";
const MARKER_CLOSE = "<!-- END META-GOVERNOR AUTO-INSTALL SNIPPET -->";
const TARGET = join(homedir(), ".config", "opencode", "plugins", "omo-meta-governor", "instructions.md");
const OLD_TARGET = join(homedir(), ".config", "opencode", "AGENTS.md");
const OPENCODE_JSONC = join(homedir(), ".config", "opencode", "opencode.jsonc");
const INSTRUCTION_REL = "plugins/omo-meta-governor/instructions.md";

// ─── Helpers (mirror src/bootstrap-agents-md.ts + src/utils/instructions-md.ts) ──
function buildSnippet(version) {
  return [
    `${MARKER_OPEN}v${version}) -->`,
    "<!-- Auto-installed by @herjarsa/omo-meta-governor. Safe to remove. Will NOT reappear if OMO_META_GOVERNOR_NO_BOOTSTRAP=1. -->",
    "",
    "## [SYSTEM-NUDGE] Meta-Governance Compliance (binding)",
    "",
    "All [SYSTEM-NUDGE] directives emitted by the omo-meta-governor plugin",
    "(or surfaced via this instructions.md) are **binding instructions**,",
    "not suggestions. You MUST follow them.",
    "",
    "Deviate only when:",
    "1. The user explicitly overrides a directive in the current turn.",
    "2. Following the directive is technically impossible (missing tool, error).",
    "3. Following the directive would cause data loss or security issues.",
    "",
    "When deviating, briefly state WHY in your response (one short sentence).",
    "Silent omission is non-compliance.",
    "",
    "The directives below are listed in priority order. Read them all",
    "before acting on a task that touches multiple domains.",
    "",
    "---",
    "",
    "## [SYSTEM-NUDGE] Oracle Review Gate (v0.38.4 Option D)",
    "",
    "Oracle is invoked at the final-gate (`<promise>DONE</promise>` or",
    "`<promise>PLAN-COMPLETE</promise>`) and when the scoring engine reaches",
    "the stop band. `warn` / `escalate` are logged but do NOT auto-invoke.",
    "Configure frequency via `oracle.frequency` in omo-meta-governor.jsonc.",
    "",
    "## [SYSTEM-NUDGE] Lesson Capture (omo_remember)",
    "",
    "After solving a non-obvious bug, learning a project rule, or discovering",
    "a config quirk, call `omo_remember` to persist it cross-session.",
    "Recall previous lessons before asking the user: `omo_recall query=\"<topic>\"`.",
    "On empty result, try `omo_recall_mcp` (cross-session AgentMemory bridge).",
    "DO NOT save routine operations or facts already covered by memory.",
    "",
    "## [SYSTEM-NUDGE] Skill Priming (select before writing code)",
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
    "## [SYSTEM-NUDGE] Sisyphus Protocol Enforcement",
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
      "# Plugin instructions for OpenCode. Edit freely.",
      "# This file is auto-managed by npm postinstall; set OMO_META_GOVERNOR_NO_BOOTSTRAP=1 to disable.",
      "",
      snippet,
      "",
    ].join("\n");
  }
  return appendSnippet(existing, snippet);
}

// ─── JSONC helpers (mirror src/utils/migrate.ts) ──────────────────────────
function stripJsoncComments(content) {
  let out = "";
  let i = 0;
  let inString = false;
  let stringChar = "";
  let escaped = false;
  while (i < content.length) {
    const ch = content[i];
    const next = content[i + 1];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === stringChar) {
        inString = false;
      }
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < content.length && content[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < content.length && !(content[i] === "*" && content[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function patchInstructionsArray(jsoncPath, instructionPath) {
  if (!existsSync(jsoncPath)) return { changed: false, wrote: false, error: "file not found" };
  let raw;
  try {
    raw = readFileSync(jsoncPath, "utf8");
  } catch (e) {
    return { changed: false, wrote: false, error: e instanceof Error ? e.message : String(e) };
  }
  let data;
  try {
    const stripped = stripJsoncComments(raw);
    data = JSON.parse(stripped);
  } catch (e) {
    return { changed: false, wrote: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { changed: false, wrote: false, error: "root is not an object" };
  }
  const existing = data["instructions"];
  if (existing === undefined) {
    data["instructions"] = [instructionPath];
  } else if (Array.isArray(existing)) {
    if (existing.includes(instructionPath)) {
      return { changed: false, wrote: false };
    }
    existing.push(instructionPath);
  } else {
    return { changed: false, wrote: false, error: "instructions is not an array" };
  }
  try {
    const newRaw = JSON.stringify(data, null, 2) + "\n";
    writeFileSync(jsoncPath, newRaw, "utf8");
    return { changed: true, wrote: true };
  } catch (e) {
    return { changed: false, wrote: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── Runtime ──────────────────────────────────────────────────────────────
function main() {
  if (process.env.OMO_META_GOVERNOR_NO_BOOTSTRAP === "1") {
    console.log("[bootstrap] skipped (OMO_META_GOVERNOR_NO_BOOTSTRAP=1)");
    return;
  }
  try {
    // 1. Backward-compat: strip old snippet from AGENTS.md if present
    try {
      if (existsSync(OLD_TARGET)) {
        const oldContent = readFileSync(OLD_TARGET, "utf-8");
        if (installedVersion(oldContent) !== null) {
          const stripped = stripSnippet(oldContent);
          writeFileSync(OLD_TARGET, stripped, "utf-8");
          console.log(`[bootstrap] stripped old snippet from ${OLD_TARGET}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[bootstrap] warning: failed to strip AGENTS.md: ${msg}`);
    }

    // 2. Write new snippet to instructions.md
    try {
      mkdirSync(dirname(TARGET), { recursive: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[bootstrap] warning: failed to create plugin dir: ${msg}`);
    }
    let existing = "";
    try {
      existing = existsSync(TARGET) ? readFileSync(TARGET, "utf-8") : "";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[bootstrap] warning: failed to read instructions.md: ${msg}`);
      existing = "";
    }
    if (isInstalled(existing, VERSION)) {
      console.log(`[bootstrap] v${VERSION} snippet already present at ${TARGET}, skipping`);
    } else {
      const snippet = buildSnippet(VERSION);
      const merged = mergeInto(existing, snippet, VERSION);
      try {
        writeFileSync(TARGET, merged, "utf-8");
        if (installedVersion(existing)) {
          console.log(`[bootstrap] upgraded to v${VERSION} at ${TARGET}`);
        } else {
          console.log(`[bootstrap] wrote v${VERSION} snippet to ${TARGET}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[bootstrap] failed to write instructions.md (non-fatal): ${msg}`);
      }
    }

    // 3. Patch opencode.jsonc to include instructions.md
    try {
      const res = patchInstructionsArray(OPENCODE_JSONC, INSTRUCTION_REL);
      if (res.changed) {
        console.log(`[bootstrap] patched ${OPENCODE_JSONC} to include ${INSTRUCTION_REL}`);
      } else if (res.error && res.error !== "file not found") {
        console.error(`[bootstrap] warning: failed to patch opencode.jsonc: ${res.error}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[bootstrap] warning: failed to patch opencode.jsonc: ${msg}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[bootstrap] failed (non-fatal): ${msg}`);
  }
}

main();
