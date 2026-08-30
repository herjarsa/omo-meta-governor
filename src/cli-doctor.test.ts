import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInstructionsSnippet, MARKER_OPEN } from "./utils/instructions-md";

// Helper to create isolated tmp env for doctor tests
function makeTmpEnv() {
  const tmpRoot = mkdtempSync(join(tmpdir(), "omo-doctor-test-"));
  const opencodeDir = join(tmpRoot, ".config", "opencode");
  mkdirSync(opencodeDir, { recursive: true });
  const pluginDir = join(opencodeDir, "plugins", "omo-meta-governor");
  const logDir = join(pluginDir, "log");
  const cacheDir = join(pluginDir, "cache");
  mkdirSync(logDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  const oldPaths = {
    log: join(opencodeDir, "meta-governor.log"),
    health: join(opencodeDir, "meta-governor-health.json"),
    selfVersionCache: join(opencodeDir, "omo-meta-governor-self-version-cache.json"),
    upgradeCheck: join(opencodeDir, "omo-meta-governor-upgrade-check.json"),
    cliAnythingUpgradeCheck: join(opencodeDir, "omo-cli-anything-upgrade-check.json"),
  };
  const newPaths = {
    pluginDir,
    logDir,
    cacheDir,
    log: join(logDir, "meta-governor.log"),
    health: join(pluginDir, "health.json"),
    selfVersionCache: join(cacheDir, "self-version.json"),
    upgradeCheck: join(cacheDir, "upgrade-check.json"),
    cliAnythingUpgradeCheck: join(cacheDir, "cli-anything-upgrade-check.json"),
    instructions: join(pluginDir, "instructions.md"),
    config: join(pluginDir, "config.json"),
  };
  const opencodeJsoncPath = join(opencodeDir, "opencode.jsonc");
  const agentsMdPath = join(opencodeDir, "AGENTS.md");
  // Default clean state: valid opencode.jsonc with instructions, config present, no old files, no snippet
  writeFileSync(opencodeJsoncPath, JSON.stringify({ instructions: ["plugins/omo-meta-governor/instructions.md"] }, null, 2), "utf8");
  writeFileSync(newPaths.config, JSON.stringify({}), "utf8");
  // ensure log writable file can be created
  return { tmpRoot, opencodeDir, pluginDir, logDir, cacheDir, oldPaths, newPaths, opencodeJsoncPath, agentsMdPath };
}

function cleanup(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}

// Use dynamic import inside tests to allow RED before cli-doctor exists
async function getDoctor() {
  const mod = await import("./cli-doctor");
  return mod;
}

describe("cli-doctor runDoctor", () => {
  it("1. Clean state (no old paths, new paths empty) → 0 issues found", async () => {
    const env = makeTmpEnv();
    try {
      const { runDoctor } = await getDoctor();
      const report = await runDoctor(
        { newPaths: env.newPaths as never, oldPaths: env.oldPaths as never, opencodeJsoncPath: env.opencodeJsoncPath, version: "0.39.0" },
        {}
      );
      expect(report.preExistingCount).toBe(0);
      expect(report.fixedCount).toBe(0);
      expect(report.issues.filter((i) => !i.ok).length).toBe(0);
    } finally {
      cleanup(env.tmpRoot);
    }
  });

  it("2. Old log file present → 1 issue detected + fixed; new log has same content; old removed", async () => {
    const env = makeTmpEnv();
    try {
      writeFileSync(env.oldPaths.log, "old log content", "utf8");
      const { runDoctor } = await getDoctor();
      const report = await runDoctor(
        { newPaths: env.newPaths as never, oldPaths: env.oldPaths as never, opencodeJsoncPath: env.opencodeJsoncPath, version: "0.39.0" },
        {}
      );
      expect(report.preExistingCount).toBe(1);
      expect(report.fixedCount).toBe(1);
      expect(existsSync(env.oldPaths.log)).toBe(false);
      expect(existsSync(env.newPaths.log)).toBe(true);
      expect(readFileSync(env.newPaths.log, "utf8")).toBe("old log content");
    } finally {
      cleanup(env.tmpRoot);
    }
  });

  it("3. All 5 old paths present → 5 issues detected + all 5 fixed; idempotent second run shows 0 issues", async () => {
    const env = makeTmpEnv();
    try {
      writeFileSync(env.oldPaths.log, "log", "utf8");
      writeFileSync(env.oldPaths.health, '{"h":1}', "utf8");
      writeFileSync(env.oldPaths.selfVersionCache, '{"v":1}', "utf8");
      writeFileSync(env.oldPaths.upgradeCheck, '{"u":1}', "utf8");
      writeFileSync(env.oldPaths.cliAnythingUpgradeCheck, '{"c":1}', "utf8");
      const { runDoctor } = await getDoctor();
      const first = await runDoctor(
        { newPaths: env.newPaths as never, oldPaths: env.oldPaths as never, opencodeJsoncPath: env.opencodeJsoncPath, version: "0.39.0" },
        {}
      );
      expect(first.preExistingCount).toBe(5);
      expect(first.fixedCount).toBe(5);
      const second = await runDoctor(
        { newPaths: env.newPaths as never, oldPaths: env.oldPaths as never, opencodeJsoncPath: env.opencodeJsoncPath, version: "0.39.0" },
        {}
      );
      expect(second.preExistingCount).toBe(0);
      expect(second.fixedCount).toBe(0);
    } finally {
      cleanup(env.tmpRoot);
    }
  });

  it("4. AGENTS.md with old snippet → detect + strip from AGENTS.md + write instructions.md (must contain compliance block, version stamp)", async () => {
    const env = makeTmpEnv();
    try {
      const snippet = buildInstructionsSnippet("0.38.9");
      // also include user content
      writeFileSync(env.agentsMdPath, `user top\n${snippet}\nuser bottom`, "utf8");
      const { runDoctor } = await getDoctor();
      const report = await runDoctor(
        { newPaths: env.newPaths as never, oldPaths: env.oldPaths as never, opencodeJsoncPath: env.opencodeJsoncPath, version: "0.39.0" },
        {}
      );
      expect(report.preExistingCount).toBeGreaterThanOrEqual(1);
      const agentsContent = readFileSync(env.agentsMdPath, "utf8");
      expect(agentsContent).not.toContain(MARKER_OPEN);
      expect(agentsContent).toContain("user top");
      expect(agentsContent).toContain("user bottom");
      expect(existsSync(env.newPaths.instructions)).toBe(true);
      const instr = readFileSync(env.newPaths.instructions, "utf8");
      expect(instr).toContain("Meta-Governance Compliance (binding)");
      expect(instr).toContain("v0.39.0");
      expect(instr).toContain("are **binding instructions**");
    } finally {
      cleanup(env.tmpRoot);
    }
  });

  it("5. opencode.jsonc missing instructions key → patched to include [\"plugins/omo-meta-governor/instructions.md\"]", async () => {
    const env = makeTmpEnv();
    try {
      writeFileSync(env.opencodeJsoncPath, JSON.stringify({}, null, 2), "utf8");
      const { runDoctor } = await getDoctor();
      const report = await runDoctor(
        { newPaths: env.newPaths as never, oldPaths: env.oldPaths as never, opencodeJsoncPath: env.opencodeJsoncPath, version: "0.39.0" },
        {}
      );
      expect(report.preExistingCount).toBeGreaterThanOrEqual(1);
      const data = JSON.parse(readFileSync(env.opencodeJsoncPath, "utf8"));
      expect(data.instructions).toContain("plugins/omo-meta-governor/instructions.md");
    } finally {
      cleanup(env.tmpRoot);
    }
  });

  it("6. opencode.jsonc with empty instructions array → patched", async () => {
    const env = makeTmpEnv();
    try {
      writeFileSync(env.opencodeJsoncPath, JSON.stringify({ instructions: [] }, null, 2), "utf8");
      const { runDoctor } = await getDoctor();
      await runDoctor(
        { newPaths: env.newPaths as never, oldPaths: env.oldPaths as never, opencodeJsoncPath: env.opencodeJsoncPath, version: "0.39.0" },
        {}
      );
      const data = JSON.parse(readFileSync(env.opencodeJsoncPath, "utf8"));
      expect(data.instructions).toContain("plugins/omo-meta-governor/instructions.md");
    } finally {
      cleanup(env.tmpRoot);
    }
  });

  it("7. opencode.jsonc with stale instructions: [\"other.md\"] → appended (no duplicate)", async () => {
    const env = makeTmpEnv();
    try {
      writeFileSync(env.opencodeJsoncPath, JSON.stringify({ instructions: ["other.md"] }, null, 2), "utf8");
      const { runDoctor } = await getDoctor();
      await runDoctor(
        { newPaths: env.newPaths as never, oldPaths: env.oldPaths as never, opencodeJsoncPath: env.opencodeJsoncPath, version: "0.39.0" },
        {}
      );
      const data = JSON.parse(readFileSync(env.opencodeJsoncPath, "utf8"));
      expect(data.instructions).toContain("other.md");
      expect(data.instructions).toContain("plugins/omo-meta-governor/instructions.md");
      expect(data.instructions.filter((x: string) => x === "plugins/omo-meta-governor/instructions.md").length).toBe(1);
    } finally {
      cleanup(env.tmpRoot);
    }
  });

  it("8. opencode.jsonc with current instruction already present → no change (idempotent)", async () => {
    const env = makeTmpEnv();
    try {
      const original = JSON.stringify({ instructions: ["plugins/omo-meta-governor/instructions.md"] }, null, 2);
      writeFileSync(env.opencodeJsoncPath, original, "utf8");
      const { runDoctor } = await getDoctor();
      const report = await runDoctor(
        { newPaths: env.newPaths as never, oldPaths: env.oldPaths as never, opencodeJsoncPath: env.opencodeJsoncPath, version: "0.39.0" },
        {}
      );
      expect(report.preExistingCount).toBe(0);
      expect(readFileSync(env.opencodeJsoncPath, "utf8")).toBe(original);
    } finally {
      cleanup(env.tmpRoot);
    }
  });

  it("9. opencode.jsonc invalid JSON → issue reported (not auto-fixed)", async () => {
    const env = makeTmpEnv();
    try {
      writeFileSync(env.opencodeJsoncPath, "{ invalid json", "utf8");
      const { runDoctor } = await getDoctor();
      const report = await runDoctor(
        { newPaths: env.newPaths as never, oldPaths: env.oldPaths as never, opencodeJsoncPath: env.opencodeJsoncPath, version: "0.39.0" },
        {}
      );
      expect(report.preExistingCount).toBeGreaterThanOrEqual(1);
      expect(report.issues.some((i) => !i.ok)).toBe(true);
      // file should remain invalid (not overwritten)
      expect(readFileSync(env.opencodeJsoncPath, "utf8")).toBe("{ invalid json");
    } finally {
      cleanup(env.tmpRoot);
    }
  });

  it("10. { reportOnly: true } mode → detects issues, does NOT call any fix", async () => {
    const env = makeTmpEnv();
    try {
      writeFileSync(env.oldPaths.log, "log", "utf8");
      writeFileSync(env.opencodeJsoncPath, JSON.stringify({}, null, 2), "utf8");
      const { runDoctor } = await getDoctor();
      const report = await runDoctor(
        { newPaths: env.newPaths as never, oldPaths: env.oldPaths as never, opencodeJsoncPath: env.opencodeJsoncPath, version: "0.39.0" },
        { reportOnly: true }
      );
      expect(report.preExistingCount).toBeGreaterThanOrEqual(2);
      expect(report.fixedCount).toBe(0);
      // old file should still exist
      expect(existsSync(env.oldPaths.log)).toBe(true);
      // opencode.jsonc should still be {}
      expect(JSON.parse(readFileSync(env.opencodeJsoncPath, "utf8"))).toEqual({});
    } finally {
      cleanup(env.tmpRoot);
    }
  });

  it("11. Idempotent: run twice in a row → second run reports 0 issues", async () => {
    const env = makeTmpEnv();
    try {
      writeFileSync(env.oldPaths.log, "x", "utf8");
      writeFileSync(env.opencodeJsoncPath, JSON.stringify({}, null, 2), "utf8");
      // remove config to trigger that fix too
      rmSync(env.newPaths.config, { force: true });
      const { runDoctor } = await getDoctor();
      const first = await runDoctor(
        { newPaths: env.newPaths as never, oldPaths: env.oldPaths as never, opencodeJsoncPath: env.opencodeJsoncPath, version: "0.39.0" },
        {}
      );
      expect(first.preExistingCount).toBeGreaterThan(0);
      const second = await runDoctor(
        { newPaths: env.newPaths as never, oldPaths: env.oldPaths as never, opencodeJsoncPath: env.opencodeJsoncPath, version: "0.39.0" },
        {}
      );
      expect(second.preExistingCount).toBe(0);
      expect(second.fixedCount).toBe(0);
    } finally {
      cleanup(env.tmpRoot);
    }
  });

  it("12. main([\"--help\"]) returns 0 and prints usage", async () => {
    const { main } = await getDoctor();
    const code = await main(["--help"]);
    expect(code).toBe(0);
  });

  it("13. main([]) returns 0 in clean state (or 1 with issues)", async () => {
    const env = makeTmpEnv();
    try {
      process.env.OMO_DOCTOR_TEST_BASE = env.opencodeDir;
      const { main } = await getDoctor();
      const code = await main([]);
      expect([0, 1]).toContain(code);
    } finally {
      delete process.env.OMO_DOCTOR_TEST_BASE;
      cleanup(env.tmpRoot);
    }
  });

  it("14. main([\"--report-only\"]) does not modify files", async () => {
    const env = makeTmpEnv();
    try {
      writeFileSync(env.oldPaths.log, "stays", "utf8");
      // Use env var to make main use tmp paths
      process.env.OMO_DOCTOR_TEST_BASE = env.opencodeDir;
      const { main } = await getDoctor();
      const code = await main(["--report-only"]);
      expect([0, 1]).toContain(code);
      expect(existsSync(env.oldPaths.log)).toBe(true);
      expect(readFileSync(env.oldPaths.log, "utf8")).toBe("stays");
    } finally {
      delete process.env.OMO_DOCTOR_TEST_BASE;
      cleanup(env.tmpRoot);
    }
  });

  it("15. runDoctor returns DoctorReport shape with issues, fixedCount, preExistingCount", async () => {
    const env = makeTmpEnv();
    try {
      const { runDoctor } = await getDoctor();
      const report = await runDoctor(
        { newPaths: env.newPaths as never, oldPaths: env.oldPaths as never, opencodeJsoncPath: env.opencodeJsoncPath, version: "0.39.0" },
        {}
      );
      expect(typeof report.version).toBe("string");
      expect(Array.isArray(report.issues)).toBe(true);
      expect(typeof report.fixedCount).toBe("number");
      expect(typeof report.preExistingCount).toBe("number");
      for (const iss of report.issues) {
        expect(typeof iss.ok).toBe("boolean");
        expect(typeof iss.category).toBe("string");
        expect(typeof iss.message).toBe("string");
      }
    } finally {
      cleanup(env.tmpRoot);
    }
  });
});

