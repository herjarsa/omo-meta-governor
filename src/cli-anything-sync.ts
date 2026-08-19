/**
 * cli-anything-sync.ts — orchestrator for auto-install + auto-upgrade of
 * cli-anything-hub (pip) and cli-hub-meta-skill (npx skills) on plugin load.
 *
 * Mirrors graph-sync.ts v0.26.0 pattern: tiered probes, version cache,
 * runner DI, never throws, emits structured codes.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import {
  fetchCliHubLatestVersion,
  getInstalledCliHubVersion,
  installCliHub,
  installCliHubMetaSkill,
  isCliHubMetaSkillInstalled,
  upgradeCliHub,
  upgradeCliHubMetaSkill,
  compareSemver,
  type CliAnythingCode,
  type Runner,
} from "./cli-anything"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CliAnythingSyncConfig {
  /** Enable auto-install + auto-upgrade on plugin load. Default true. */
  enabled: boolean
  /** Auto-install when missing. Default true. */
  autoInstall: boolean
  /** Auto-upgrade when a newer version is available. Default true. */
  autoUpgrade: boolean
  /** Filesystem path for the upgrade-cache file (latest-known version per channel). */
  cachePath: string
  /** Minimum ms between registry queries. Default 24h. */
  upgradeCheckTtlMs: number
  /** Project dir. Default process.cwd(). */
  projectDir?: string
  /** Test-only DI seam — replaces execSync so version probes never spawn real
   *  pip/npx in hermetic tests. */
  runner?: Runner
  /** Where to install the meta-skill. Default 'global'. */
  installScope?: "global" | "project"
  /** Override cli-hub binary path. */
  cliHubBin?: string
  /** Override skills binary path. */
  skillsBin?: string
  /** Install timeout ms. Default 60_000. */
  installTimeoutMs?: number
}

export interface CliAnythingSyncResult {
  attempted: boolean
  codes: CliAnythingCode[]
  availability: {
    cliHub: boolean
    cliHubVersion: string | null
    metaSkill: boolean
  }
  alreadyInitialized: boolean
}

// ---------------------------------------------------------------------------
// Cache file format
// ---------------------------------------------------------------------------

interface UpgradeCache {
  cliHubLatestVersion?: string | null
  metaSkillLastCheckedISO?: string | null
  updatedAtISO?: string
}

function readUpgradeCache(cachePath: string): UpgradeCache | null {
  if (!existsSync(cachePath)) return null
  try {
    return JSON.parse(readFileSync(cachePath, "utf8")) as UpgradeCache
  } catch {
    return null
  }
}

function writeUpgradeCache(cachePath: string, data: UpgradeCache): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true })
    writeFileSync(cachePath, JSON.stringify(data, null, 2), "utf8")
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Main sync function
// ---------------------------------------------------------------------------

export async function runCliAnythingSync(
  config: Partial<CliAnythingSyncConfig> = {},
): Promise<CliAnythingSyncResult> {
  const fullConfig: CliAnythingSyncConfig = {
    enabled: config.enabled ?? true,
    autoInstall: config.autoInstall ?? true,
    autoUpgrade: config.autoUpgrade ?? true,
    cachePath:
      config.cachePath ??
      `${process.env.HOME || process.env.USERPROFILE || "~"}/.config/opencode/omo-cli-anything-upgrade-check.json`,
    upgradeCheckTtlMs: config.upgradeCheckTtlMs ?? 24 * 60 * 60 * 1000,
    projectDir: config.projectDir,
    runner: config.runner,
    installScope: config.installScope ?? "global",
    cliHubBin: config.cliHubBin,
    skillsBin: config.skillsBin,
    installTimeoutMs: config.installTimeoutMs ?? 60_000,
  }

  if (!fullConfig.enabled) {
    return {
      attempted: false,
      codes: ["cli-anything-upgrade-skipped"],
      availability: { cliHub: false, cliHubVersion: null, metaSkill: false },
      alreadyInitialized: true,
    }
  }

  const codes: CliAnythingCode[] = []
  const runner = fullConfig.runner ?? ((cmd, opts) => {
    // Lazy require so the test-only DI seam is the default in production
    // (this block only runs when no runner is injected)
    const { execSync } = require("node:child_process") as typeof import("node:child_process")
    return execSync(cmd, {
      timeout: opts?.timeoutMs ?? 10_000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
  })

  // --- 1. Probe installed state ---
  const installedVersion = getInstalledCliHubVersion(runner)
  const metaSkillInstalled = isCliHubMetaSkillInstalled(
    fullConfig.installScope,
    runner,
    10_000,
    fullConfig.skillsBin,
  )

  const availability = {
    cliHub: installedVersion !== null,
    cliHubVersion: installedVersion,
    metaSkill: metaSkillInstalled,
  }

  // --- 2. Auto-install when missing ---
  if (installedVersion === null && fullConfig.autoInstall) {
    const install = installCliHub(runner, fullConfig.installTimeoutMs)
    codes.push(install.code)
    if (install.ok) {
      // Re-probe to update availability
      const newVersion = getInstalledCliHubVersion(runner)
      availability.cliHub = true
      availability.cliHubVersion = newVersion
    }
  } else if (installedVersion !== null) {
    codes.push("cli-anything-already-installed")
  }

  if (!metaSkillInstalled && fullConfig.autoInstall) {
    const skillInstall = installCliHubMetaSkill(
      fullConfig.installScope,
      runner,
      fullConfig.installTimeoutMs,
      fullConfig.skillsBin,
    )
    codes.push(skillInstall.code)
    if (skillInstall.ok) {
      availability.metaSkill = true
    }
  } else if (metaSkillInstalled) {
    codes.push("skill-already-current")
  }

  // --- 3. Auto-upgrade with cache TTL ---
  if (fullConfig.autoUpgrade) {
    const cache = readUpgradeCache(fullConfig.cachePath)
    const now = Date.now()
    let shouldProbe = true
    if (cache?.updatedAtISO) {
      const lastUpdateMs = Date.parse(cache.updatedAtISO)
      if (Number.isFinite(lastUpdateMs) && now - lastUpdateMs < fullConfig.upgradeCheckTtlMs) {
        shouldProbe = false
      }
    }

    let latestCliHubVersion: string | null = cache?.cliHubLatestVersion ?? null
    if (shouldProbe) {
      latestCliHubVersion = fetchCliHubLatestVersion(runner)
      writeUpgradeCache(fullConfig.cachePath, {
        cliHubLatestVersion: latestCliHubVersion,
        metaSkillLastCheckedISO: new Date(now).toISOString(),
        updatedAtISO: new Date(now).toISOString(),
      })
    }

    if (
      availability.cliHub &&
      latestCliHubVersion !== null &&
      availability.cliHubVersion !== null &&
      compareSemver(latestCliHubVersion, availability.cliHubVersion) > 0
    ) {
      const upgrade = upgradeCliHub(runner, fullConfig.installTimeoutMs)
      codes.push(upgrade.code)
      if (upgrade.ok) {
        const newVersion = getInstalledCliHubVersion(runner)
        availability.cliHubVersion = newVersion
      }
    } else if (availability.cliHub && availability.cliHubVersion) {
      // Already current — no-op
    }

    // Meta-skill upgrade (always attempt; npx skills update is idempotent)
    if (availability.metaSkill) {
      const skillUpgrade = upgradeCliHubMetaSkill(
        fullConfig.installScope,
        runner,
        fullConfig.installTimeoutMs,
        fullConfig.skillsBin,
      )
      // If "no update needed" exits non-zero, treat as success
      if (skillUpgrade.ok || /no update/i.test(skillUpgrade.stderr)) {
        if (!codes.includes("skill-already-current")) {
          codes.push(skillUpgrade.ok ? "skill-upgrade-succeeded" : "skill-already-current")
        }
      } else {
        codes.push(skillUpgrade.code)
      }
    }
  }

  return {
    attempted: true,
    codes,
    availability,
    alreadyInitialized: false,
  }
}