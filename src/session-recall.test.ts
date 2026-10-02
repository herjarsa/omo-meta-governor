/**
 * Session-start recall — automatic LESSONS FROM PAST SESSIONS (v0.53.1).
 *
 * WHY: omo_recall is voluntary today (START PROTOCOL step 1 suggests it,
 * graph-priming nudges it, nothing executes it), so high-value lessons never
 * surface unless the agent remembers to ask. Compaction already auto-injects
 * top-3 lessons into its context for the same reason; session-start mirrors
 * it via the same system-transform surface (no new channel, no synthetic
 * assistant message → no TUI pause on turn 0).
 *
 * Contract:
 * - Once per session, main session only (isMainSession), silent when empty.
 * - Top 3 by confidence>=0.5 (the P1 floor — low-confidence noise stays out).
 * - Block is named 'LESSONS FROM PAST SESSIONS' and carries lesson titles.
 */
import { describe, expect, it } from "bun:test";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PluginInput } from "@opencode-ai/plugin";
import { createMetaGovernorPlugin, buildSessionRecallBlock } from "./plugin";
import { SqliteBackend } from "./sqlite-backend";
import { clearAll } from "./decision-store";

const mockBaseInput = {
  client: null as unknown as PluginInput["client"],
  project: null as unknown as PluginInput["project"],
  directory: "",
  worktree: "",
  experimental_workspace: { register: () => {} },
  serverUrl: new URL("http://localhost"),
  $: null as unknown as PluginInput["$"],
} as const;

function hermeticDeps(extra: Record<string, unknown> = {}) {
  return {
    __test_runGraphSync: async () => ({
      attempted: false,
      codes: ["disabled"],
      availability: { codegraph: false, graphify: false, codegraphIndexExists: false, graphifyIndexExists: false },
      alreadyInitialized: true,
    }),
    __test_runCliAnythingSync: async () => ({
      attempted: false,
      codes: ["cli-hub-version-probed"] as never,
      availability: { cliHub: false, cliHubVersion: null, metaSkill: false },
      alreadyInitialized: true,
    }),
    __test_startSkillsFsWatcher: async () => ({ stop: async () => {} }),
    ...extra,
  } as never;
}

function tmpDbPath(prefix: string): string {
  return join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanupDb(path: string, backend: SqliteBackend): void {
  try { backend.close(); } catch {}
  for (const p of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    try { if (existsSync(p)) unlinkSync(p); } catch {}
  }
}

async function seedLessons(backend: SqliteBackend, n: number): Promise<string[]> {
  const titles: string[] = [];
  for (let i = 0; i < n; i++) {
    const title = `Recall lesson ${i + 1} — avoid bare grep`;
    titles.push(title);
    await backend.saveLesson({
      content: `${title}\nUse omo_search before grep for indexed repos.`,
      context: "session:seed",
      confidence: 0.7,
      tags: ["recall-test", "grep"],
    });
  }
  return titles;
}

describe("session-start recall — LESSONS FROM PAST SESSIONS", () => {
  it("(a) with 3 high-confidence lessons the block appears with their titles", async () => {
    const dbPath = tmpDbPath("recall-full");
    const backend = new SqliteBackend(dbPath);
    try {
      clearAll();
      const titles = await seedLessons(backend, 3);
      const sid = `ses_recall_full_${Date.now()}`;
      const plugin = await createMetaGovernorPlugin(
        { graphSync: { enabled: false }, cliAnything: { enabled: false } },
        hermeticDeps({
          __test_isMainSession: () => true,
          __test_sessionRecallBackend: backend,
        }),
      )({ ...mockBaseInput } as PluginInput, { meta_governor: { enabled: true } } as never);
      const sysTransform = (plugin as unknown as Record<string, unknown>)["experimental.chat.system.transform"] as unknown as (
        i: unknown, o: { system: string[] },
      ) => Promise<void>;
      const sysOut = { system: [] as string[] };
      await sysTransform({ sessionID: sid, model: { providerID: "t", modelID: "t" } }, sysOut);
      const all = sysOut.system.join("\n");
      expect(all).toContain("LESSONS FROM PAST SESSIONS");
      for (const t of titles) expect(all).toContain(t.slice(0, 30));
    } finally {
      cleanupDb(dbPath, backend);
    }
  });

  it("(b) empty backend injects nothing (zero noise)", async () => {
    const dbPath = tmpDbPath("recall-empty");
    const backend = new SqliteBackend(dbPath);
    try {
      clearAll();
      const sid = `ses_recall_empty_${Date.now()}`;
      const plugin = await createMetaGovernorPlugin(
        { graphSync: { enabled: false }, cliAnything: { enabled: false } },
        hermeticDeps({
          __test_isMainSession: () => true,
          __test_sessionRecallBackend: backend,
        }),
      )({ ...mockBaseInput } as PluginInput, { meta_governor: { enabled: true } } as never);
      const sysTransform = (plugin as unknown as Record<string, unknown>)["experimental.chat.system.transform"] as unknown as (
        i: unknown, o: { system: string[] },
      ) => Promise<void>;
      const sysOut = { system: [] as string[] };
      await sysTransform({ sessionID: sid, model: { providerID: "t", modelID: "t" } }, sysOut);
      expect(sysOut.system.join("\n")).not.toContain("LESSONS FROM PAST SESSIONS");
      // Pure helper agrees: empty → null.
      expect(buildSessionRecallBlock([])).toBeNull();
    } finally {
      cleanupDb(dbPath, backend);
    }
  });

  it("(c) second call in the same session injects nothing (once)", async () => {
    const dbPath = tmpDbPath("recall-once");
    const backend = new SqliteBackend(dbPath);
    try {
      clearAll();
      await seedLessons(backend, 3);
      const sid = `ses_recall_once_${Date.now()}`;
      const plugin = await createMetaGovernorPlugin(
        { graphSync: { enabled: false }, cliAnything: { enabled: false } },
        hermeticDeps({
          __test_isMainSession: () => true,
          __test_sessionRecallBackend: backend,
        }),
      )({ ...mockBaseInput } as PluginInput, { meta_governor: { enabled: true } } as never);
      const sysTransform = (plugin as unknown as Record<string, unknown>)["experimental.chat.system.transform"] as unknown as (
        i: unknown, o: { system: string[] },
      ) => Promise<void>;
      const first = { system: [] as string[] };
      await sysTransform({ sessionID: sid, model: { providerID: "t", modelID: "t" } }, first);
      expect(first.system.join("\n")).toContain("LESSONS FROM PAST SESSIONS");
      const second = { system: [] as string[] };
      await sysTransform({ sessionID: sid, model: { providerID: "t", modelID: "t" } }, second);
      expect(second.system.join("\n")).not.toContain("LESSONS FROM PAST SESSIONS");
    } finally {
      cleanupDb(dbPath, backend);
    }
  });

  it("(d) subagent sessions get nothing", async () => {
    const dbPath = tmpDbPath("recall-sub");
    const backend = new SqliteBackend(dbPath);
    try {
      clearAll();
      await seedLessons(backend, 3);
      const sid = `ses_recall_sub_${Date.now()}`;
      const plugin = await createMetaGovernorPlugin(
        { graphSync: { enabled: false }, cliAnything: { enabled: false } },
        hermeticDeps({
          __test_isMainSession: () => false,
          __test_sessionRecallBackend: backend,
        }),
      )({ ...mockBaseInput } as PluginInput, { meta_governor: { enabled: true } } as never);
      const sysTransform = (plugin as unknown as Record<string, unknown>)["experimental.chat.system.transform"] as unknown as (
        i: unknown, o: { system: string[] },
      ) => Promise<void>;
      const sysOut = { system: [] as string[] };
      await sysTransform({ sessionID: sid, model: { providerID: "t", modelID: "t" } }, sysOut);
      expect(sysOut.system.join("\n")).not.toContain("LESSONS FROM PAST SESSIONS");
    } finally {
      cleanupDb(dbPath, backend);
    }
  });
});
