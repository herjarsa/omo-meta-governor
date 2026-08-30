/**
 * v0.39.0 — plugin folder consolidation helpers.
 * Pure path helpers + file migration + opencode.jsonc patching.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export interface OldPluginPaths {
  log: string;
  health: string;
  selfVersionCache: string;
  upgradeCheck: string;
  cliAnythingUpgradeCheck: string;
}

export interface NewPluginPaths {
  pluginDir: string;
  logDir: string;
  cacheDir: string;
  log: string;
  health: string;
  selfVersionCache: string;
  upgradeCheck: string;
  cliAnythingUpgradeCheck: string;
  instructions: string;
  config: string;
}

function opencodeBaseDir(): string {
  return resolve(homedir(), ".config", "opencode");
}

export function oldPluginPaths(baseDir?: string): OldPluginPaths {
  const base = baseDir ?? opencodeBaseDir();
  return {
    log: join(base, "meta-governor.log"),
    health: join(base, "meta-governor-health.json"),
    selfVersionCache: join(base, "omo-meta-governor-self-version-cache.json"),
    upgradeCheck: join(base, "omo-meta-governor-upgrade-check.json"),
    cliAnythingUpgradeCheck: join(base, "omo-cli-anything-upgrade-check.json"),
  };
}

export function newPluginPaths(baseDir?: string): NewPluginPaths {
  const base = baseDir ?? opencodeBaseDir();
  const pluginDir = join(base, "plugins", "omo-meta-governor");
  return {
    pluginDir,
    logDir: join(pluginDir, "log"),
    cacheDir: join(pluginDir, "cache"),
    log: join(pluginDir, "log", "meta-governor.log"),
    health: join(pluginDir, "health.json"),
    selfVersionCache: join(pluginDir, "cache", "self-version.json"),
    upgradeCheck: join(pluginDir, "cache", "upgrade-check.json"),
    cliAnythingUpgradeCheck: join(pluginDir, "cache", "cli-anything-upgrade-check.json"),
    instructions: join(pluginDir, "instructions.md"),
    config: join(pluginDir, "config.json"),
  };
}

export interface MigrateResult {
  migrated: string[];
  skipped: string[];
}

export function migrateOldToNew(opts: { oldPaths: OldPluginPaths; newPaths: NewPluginPaths }): MigrateResult {
  const migrated: string[] = [];
  const skipped: string[] = [];
  const pairs: Array<[string, string]> = [
    [opts.oldPaths.log, opts.newPaths.log],
    [opts.oldPaths.health, opts.newPaths.health],
    [opts.oldPaths.selfVersionCache, opts.newPaths.selfVersionCache],
    [opts.oldPaths.upgradeCheck, opts.newPaths.upgradeCheck],
    [opts.oldPaths.cliAnythingUpgradeCheck, opts.newPaths.cliAnythingUpgradeCheck],
  ];
  for (const [oldP, newP] of pairs) {
    if (!existsSync(oldP)) {
      skipped.push(oldP);
      continue;
    }
    if (existsSync(newP)) {
      // already migrated — still remove old if present? idempotent: remove old
      try {
        unlinkSync(oldP);
        migrated.push(oldP);
      } catch {
        skipped.push(oldP);
      }
      continue;
    }
    try {
      mkdirSync(dirname(newP), { recursive: true });
      copyFileSync(oldP, newP);
      unlinkSync(oldP);
      migrated.push(oldP);
    } catch {
      skipped.push(oldP);
    }
  }
  return { migrated, skipped };
}

export interface ReadOpencodeJsoncResult {
  exists: boolean;
  raw?: string;
  data?: Record<string, unknown>;
  error?: string;
}

export function readOpencodeJsonc(filePath: string): ReadOpencodeJsoncResult {
  if (!existsSync(filePath)) return { exists: false };
  try {
    const raw = readFileSync(filePath, "utf8");
    // strip comments: // and /* */ and trailing commas approach via simple jsonc parse
    const stripped = stripJsoncComments(raw);
    const data = JSON.parse(stripped) as Record<string, unknown>;
    return { exists: true, raw, data };
  } catch (e) {
    return { exists: true, error: e instanceof Error ? e.message : String(e) };
  }
}

function stripJsoncComments(content: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let stringChar = "";
  let escaped = false;
  while (i < content.length) {
    const ch = content[i]!;
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
      // line comment
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

export interface PatchResult {
  changed: boolean;
  wrote: boolean;
  error?: string;
}

/**
 * Ensure `instructions` array in opencode.jsonc includes `instructionPath`.
 * Handles missing key, empty array, stale values. Idempotent.
 * Writes file if changed.
 */
export function patchInstructionsArray(jsoncPath: string, instructionPath: string): PatchResult {
  const read = readOpencodeJsonc(jsoncPath);
  if (!read.exists) return { changed: false, wrote: false, error: "file not found" };
  if (read.error || !read.data) return { changed: false, wrote: false, error: read.error ?? "parse error" };
  const data = read.data as Record<string, unknown>;
  const existing = data["instructions"];
  let arr: unknown[];
  if (existing === undefined) {
    arr = [instructionPath];
    data["instructions"] = arr;
  } else if (Array.isArray(existing)) {
    if (existing.includes(instructionPath)) {
      return { changed: false, wrote: false };
    }
    existing.push(instructionPath);
    arr = existing;
  } else {
    // instructions is not an array — treat as error, don't auto-fix
    return { changed: false, wrote: false, error: "instructions is not an array" };
  }
  try {
    // Preserve formatting: write pretty JSON (opencode.jsonc is JSONC but we output JSON)
    const newRaw = JSON.stringify(data, null, 2) + "\n";
    writeFileSync(jsoncPath, newRaw, "utf8");
    return { changed: true, wrote: true };
  } catch (e) {
    return { changed: false, wrote: false, error: e instanceof Error ? e.message : String(e) };
  }
}
