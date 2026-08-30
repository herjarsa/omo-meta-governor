/**
 * v0.39.0 — omo doctor CLI
 * Pure detection/reporting + thin CLI wrapper.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { buildInstructionsSnippet, isInstalled, stripSnippet } from "./utils/instructions-md";
import { readOpencodeJsonc, patchInstructionsArray } from "./utils/migrate";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface DoctorIssue {
  ok: boolean;
  category: string;
  message: string;
  fix?: () => Promise<{ ok: boolean; detail?: string }>;
}

export interface DoctorReport {
  version: string;
  issues: DoctorIssue[];
  fixedCount: number;
  preExistingCount: number;
}

export interface DoctorOptions {
  newPaths: {
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
  };
  oldPaths: {
    log: string;
    health: string;
    selfVersionCache: string;
    upgradeCheck: string;
    cliAnythingUpgradeCheck: string;
  };
  opencodeJsoncPath: string;
  version: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function opencodeBaseDir(): string {
  // Allow test injection via env var
  const testBase = process.env.OMO_DOCTOR_TEST_BASE;
  if (testBase) return testBase;
  return join(homedir(), ".config", "opencode");
}

function ensureDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function isWritableDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.omo-doctor-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    writeFileSync(probe, "probe", "utf8");
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function isWritableFile(filePath: string): boolean {
  try {
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
    // try to test writability via temp file in same dir
    const probe = join(dir, `.omo-doctor-probe-${Date.now()}`);
    writeFileSync(probe, "probe", "utf8");
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Pure doctor
// ---------------------------------------------------------------------------
export async function runDoctor(opts: DoctorOptions, mode: { reportOnly?: boolean; yes?: boolean } = {}): Promise<DoctorReport> {
  const issues: DoctorIssue[] = [];
  let preExistingCount = 0;
  let fixedCount = 0;

  const reportOnly = mode.reportOnly === true;

  // Helper to push issue and potentially fix
  async function handleIssue(issue: DoctorIssue): Promise<void> {
    issues.push(issue);
    if (!issue.ok) {
      preExistingCount++;
      if (!reportOnly && issue.fix) {
        try {
          const res = await issue.fix();
          if (res.ok) {
            fixedCount++;
            issue.ok = true;
            issue.message = issue.message + " → fixed";
          }
        } catch {
          // fix failed, remains not ok
        }
      }
    }
  }

  // 1. Plugin folder exists and is writable (create if missing)
  {
    const dir = opts.newPaths.pluginDir;
    const exists = existsSync(dir);
    if (exists) {
      const writable = isWritableDir(dir);
      await handleIssue({
        ok: writable,
        category: "plugin-folder",
        message: writable ? `Plugin folder: ${dir}` : `Plugin folder not writable: ${dir}`,
        fix: writable
          ? undefined
          : async () => {
              const ok = ensureDir(dir) && isWritableDir(dir);
              return { ok, detail: ok ? "created" : "failed" };
            },
      });
    } else {
      await handleIssue({
        ok: false,
        category: "plugin-folder",
        message: `Plugin folder missing: ${dir}`,
        fix: async () => {
          const ok = ensureDir(dir);
          return { ok, detail: ok ? "created" : "failed" };
        },
      });
    }
  }

  // 2. Log dir exists (create if missing)
  {
    const dir = opts.newPaths.logDir;
    const exists = existsSync(dir);
    if (exists) {
      await handleIssue({ ok: true, category: "log-dir", message: `Log dir: ${dir}` });
    } else {
      await handleIssue({
        ok: false,
        category: "log-dir",
        message: `Log dir missing: ${dir}`,
        fix: async () => {
          const ok = ensureDir(dir);
          return { ok };
        },
      });
    }
  }

  // 3. Cache dir exists (create if missing)
  {
    const dir = opts.newPaths.cacheDir;
    const exists = existsSync(dir);
    if (exists) {
      await handleIssue({ ok: true, category: "cache-dir", message: `Cache dir: ${dir}` });
    } else {
      await handleIssue({
        ok: false,
        category: "cache-dir",
        message: `Cache dir missing: ${dir}`,
        fix: async () => {
          const ok = ensureDir(dir);
          return { ok };
        },
      });
    }
  }

  // 4-8. Old files migrate
  const migratePairs: Array<{ oldPath: string; newPath: string; category: string; label: string }> = [
    { oldPath: opts.oldPaths.log, newPath: opts.newPaths.log, category: "old-log", label: "Old log file" },
    { oldPath: opts.oldPaths.health, newPath: opts.newPaths.health, category: "old-health", label: "Old health file" },
    { oldPath: opts.oldPaths.selfVersionCache, newPath: opts.newPaths.selfVersionCache, category: "old-self-version", label: "Old self-version cache" },
    { oldPath: opts.oldPaths.upgradeCheck, newPath: opts.newPaths.upgradeCheck, category: "old-upgrade-check", label: "Old upgrade-check" },
    { oldPath: opts.oldPaths.cliAnythingUpgradeCheck, newPath: opts.newPaths.cliAnythingUpgradeCheck, category: "old-cli-anything", label: "Old cli-anything upgrade-check" },
  ];
  for (const p of migratePairs) {
    const exists = existsSync(p.oldPath);
    if (!exists) {
      await handleIssue({ ok: true, category: p.category, message: `${p.label}: not present (ok)` });
    } else {
      await handleIssue({
        ok: false,
        category: p.category,
        message: `${p.label}: ${p.oldPath} exists → migrate to ${p.newPath}`,
        fix: async () => {
          try {
            const dir = dirname(p.newPath);
            mkdirSync(dir, { recursive: true });
            if (!existsSync(p.newPath)) {
              copyFileSync(p.oldPath, p.newPath);
            } else {
              // if new already exists, just remove old
            }
            unlinkSync(p.oldPath);
            return { ok: true, detail: "migrated" };
          } catch (e) {
            return { ok: false, detail: e instanceof Error ? e.message : String(e) };
          }
        },
      });
    }
  }

  // 9. AGENTS.md contains old snippet → strip + write instructions.md
  {
    const agentsMdPath = join(dirname(opts.opencodeJsoncPath), "AGENTS.md");
    let hasSnippet = false;
    let agentsContent = "";
    if (existsSync(agentsMdPath)) {
      try {
        agentsContent = readFileSync(agentsMdPath, "utf8");
        hasSnippet = isInstalled(agentsContent);
      } catch {
        hasSnippet = false;
      }
    }
    if (!hasSnippet) {
      await handleIssue({ ok: true, category: "agents-snippet", message: "AGENTS.md has no old snippet" });
    } else {
      await handleIssue({
        ok: false,
        category: "agents-snippet",
        message: "AGENTS.md has old snippet (marker)",
        fix: async () => {
          try {
            const stripped = stripSnippet(agentsContent);
            writeFileSync(agentsMdPath, stripped, "utf8");
            const snippet = buildInstructionsSnippet(opts.version);
            const instrDir = dirname(opts.newPaths.instructions);
            mkdirSync(instrDir, { recursive: true });
            writeFileSync(opts.newPaths.instructions, snippet, "utf8");
            return { ok: true };
          } catch (e) {
            return { ok: false, detail: e instanceof Error ? e.message : String(e) };
          }
        },
      });
    }
  }

  // 10. opencode.jsonc exists and is parseable
  {
    const p = opts.opencodeJsoncPath;
    const read = readOpencodeJsonc(p);
    if (!read.exists) {
      await handleIssue({
        ok: false,
        category: "opencode-jsonc",
        message: `opencode.jsonc missing: ${p}`,
      });
    } else if (read.error) {
      await handleIssue({
        ok: false,
        category: "opencode-jsonc",
        message: `opencode.jsonc invalid JSON: ${read.error}`,
      });
    } else {
      await handleIssue({ ok: true, category: "opencode-jsonc", message: `opencode.jsonc parseable: ${p}` });

      // 11. instructions array includes new relative path → patch if missing
      const instructionRel = "plugins/omo-meta-governor/instructions.md";
      const data = read.data as Record<string, unknown>;
      const instr = data["instructions"];
      let needsPatch = false;
      if (instr === undefined) needsPatch = true;
      else if (Array.isArray(instr)) {
        if (!instr.includes(instructionRel)) needsPatch = true;
      } else {
        // not an array — report as issue but not auto-fixable via patch? treat as not ok without fix
        await handleIssue({
          ok: false,
          category: "opencode-instructions",
          message: `opencode.jsonc instructions is not an array`,
        });
        needsPatch = false;
      }
      if (needsPatch) {
        // we already know read.data case is patchable
        await handleIssue({
          ok: false,
          category: "opencode-instructions",
          message: `opencode.jsonc instructions missing ${instructionRel}`,
          fix: async () => {
            try {
              const res = patchInstructionsArray(p, instructionRel);
              return { ok: res.changed || res.wrote, detail: res.error };
            } catch (e) {
              return { ok: false, detail: e instanceof Error ? e.message : String(e) };
            }
          },
        });
      } else if (Array.isArray(instr) && instr.includes(instructionRel)) {
        await handleIssue({ ok: true, category: "opencode-instructions", message: `opencode.jsonc instructions includes ${instructionRel}` });
      }
    }
  }

  // 12. config.json exists in plugin folder → write defaults if missing
  {
    const cfg = opts.newPaths.config;
    if (existsSync(cfg)) {
      await handleIssue({ ok: true, category: "config", message: `config.json exists: ${cfg}` });
    } else {
      await handleIssue({
        ok: false,
        category: "config",
        message: `Missing config.json: ${cfg}`,
        fix: async () => {
          try {
            const dir = dirname(cfg);
            mkdirSync(dir, { recursive: true });
            writeFileSync(cfg, JSON.stringify({}, null, 2) + "\n", "utf8");
            return { ok: true };
          } catch (e) {
            return { ok: false, detail: e instanceof Error ? e.message : String(e) };
          }
        },
      });
    }
  }

  // 13. Log file writable (touch + unlink test)
  {
    const writable = isWritableFile(opts.newPaths.log);
    await handleIssue({
      ok: writable,
      category: "log-writable",
      message: writable ? "Log writable" : "Log not writable",
    });
  }

  // 14. Health file writable (touch + unlink test)
  {
    const writable = isWritableFile(opts.newPaths.health);
    await handleIssue({
      ok: writable,
      category: "health-writable",
      message: writable ? "Health snapshot writable" : "Health snapshot not writable",
    });
  }

  return {
    version: opts.version,
    issues,
    fixedCount,
    preExistingCount,
  };
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------
function printUsage(): void {
  console.log(`Usage: omo doctor [--report-only] [--verbose] [--yes]
  --report-only, -r  Only report, do not fix
  --verbose, -v      Extra detail
  --yes, -y          Skip confirmation prompts (no prompts in v0.39.0)
  --help, -h         Show this help`);
}

export async function main(argv?: string[]): Promise<number> {
  const rawArgs = argv ?? process.argv.slice(2);
  // Handle subcommand "doctor" as first arg
  let args = [...rawArgs];
  if (args[0] === "doctor") args = args.slice(1);

  let reportOnly = false;
  let verbose = false;
  let yes = false;

  for (const a of args) {
    if (a === "--report-only" || a === "-r") reportOnly = true;
    else if (a === "--verbose" || a === "-v") verbose = true;
    else if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--help" || a === "-h") {
      printUsage();
      return 0;
    } else if (a.startsWith("-")) {
      console.error(`Unknown option: ${a}`);
      printUsage();
      return 2;
    } else {
      console.error(`Unknown argument: ${a}`);
      printUsage();
      return 2;
    }
  }

  // Resolve version — try package.json, fallback to 0.39.0
  let version = "0.39.0";
  try {
    const pkgPath = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "..", "package.json");
    // On Windows, import.meta.url pathname has leading slash
    const raw = readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    if (pkg.version) version = pkg.version;
  } catch {
    // fallback
  }

  // Allow test base override
  const baseDir = opencodeBaseDir();
  // Dynamically import migrate to get paths (avoid circular)
  const { oldPluginPaths, newPluginPaths } = await import("./utils/migrate");
  const oldPaths = oldPluginPaths(baseDir);
  const newPaths = newPluginPaths(baseDir);
  const opencodeJsoncPath = join(baseDir, "opencode.jsonc");

  const opts: DoctorOptions = {
    newPaths: newPaths as unknown as DoctorOptions["newPaths"],
    oldPaths: oldPaths as unknown as DoctorOptions["oldPaths"],
    opencodeJsoncPath,
    version,
  };

  console.log(`🔍 omo-meta-governor v${version} doctor`);
  console.log("─────────────────────────────");

  const report = await runDoctor(opts, { reportOnly, yes });

  for (const iss of report.issues) {
    const prefix = iss.ok ? "[OK]" : reportOnly || !iss.fix ? "[!!]" : "[FIX]";
    // For fixed issues, iss.ok is now true but we want [FIX] prefix
    // We track preExisting: if it was fixed, show [FIX]
    // Simpler: if issue was pre-existing and now ok and fixedCount includes it, show [FIX] for those that were fixed
    // We can detect via message containing "→ fixed" or by checking preExisting vs fixed
    let displayPrefix: string;
    if (iss.ok) {
      // Determine if this was originally failing but fixed
      // Heuristic: message contains "→ fixed" or category is one of fixable and preExistingCount >0
      // Better: we mutated ok to true after fix, so we need to know if it was fixed
      // We'll use message includes "→ fixed" as signal
      if (iss.message.includes("→ fixed")) displayPrefix = "[FIX]";
      else displayPrefix = "[OK]";
    } else {
      // still not ok — unfixable or reportOnly
      displayPrefix = "[!!]";
    }
    // For reportOnly mode, fixed issues remain not ok, so they'll show [!!] which is correct per spec exit code 1
    // But spec says [FIX] for auto-fixed issues, [!!] for unfixable
    // So adjust: if reportOnly, all failing show [!!]
    if (reportOnly && !iss.ok) displayPrefix = "[!!]";
    console.log(`${displayPrefix} ${iss.message}`);
    if (verbose && iss.category) {
      console.log(`  category: ${iss.category}`);
    }
  }

  console.log(`\nSummary: ${report.preExistingCount} issues found, ${report.fixedCount} fixed.`);

  if (report.preExistingCount > 0 && report.fixedCount < report.preExistingCount) {
    // unfixable remain or reportOnly
    return 1;
  }
  return 0;
}

// Direct invocation via bun src/cli-doctor.ts [doctor] [...]
if (import.meta.main) {
  const code = await main();
  process.exit(code);
}
