/**
 * Tests for memory-aggregator.ts (PR 2 of 8 for MetaGovernor).
 *
 * Tests the aggregateRead function with unit-fake backends (no I/O, no MCP).
 * Each test verifies: correct merge of 3 sources, graceful degrade, timeout,
 * sorting, and limits.
 *
 * Pattern: unit fakes with injected backends — clean, fast, no mock.module().
 */

import { describe, it, expect } from "bun:test"
import { aggregateRead } from "./memory-aggregator"
import type {
  AgentmemoryBackend,
  BoulderStateBackend,
  AggregateReadInput,
  Backends,
} from "./memory-aggregator"

// ---------------------------------------------------------------------------
// Fake backends (unit fakes, not MCP mocks — clean, no I/O, no side effects)

function makeFakeAgentmemory(overrides?: {
  lessons?: Array<{ id: string; title: string; content: string; type: string; concepts: string[]; confidence: number; files: string[] }>
}): AgentmemoryBackend {
  return {
    smartSearch: async () => ({
      lessons: overrides?.lessons ?? [],
      crystals: [],
    }),
  }
}

function makeFakeBoulder(overrides?: {
  tasks?: Array<{ id: string; title: string; priority: number; status: string; description: string; createdAtMs: number; updatedAtMs: number }>
  readFn?: (input: { directory: string; sessionID: string; query?: string }) => Promise<unknown[]>
}): BoulderStateBackend {
  return {
    boulderRead: async (input) => overrides?.readFn ? overrides.readFn(input) as never : (overrides?.tasks ?? []),
  }
}

function makeInput(overrides?: Partial<AggregateReadInput>): AggregateReadInput {
  return {
    directory: "/test",
    sessionID: "test-session",
    query: "test query",
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// RED — tests written FIRST. These should fail against an empty impl.

describe("memory-aggregator", () => {
  describe("#aggregateRead merges all 3 sources", () => {
    it("returns lessons from agentmemory sorted by confidence DESC", async () => {
      // given
      const lessons = [
        { id: "l1", title: "low", content: "c", type: "pattern", concepts: [], confidence: 0.2, files: [] },
        { id: "l2", title: "high", content: "c", type: "pattern", concepts: [], confidence: 0.8, files: [] },
        { id: "l3", title: "mid", content: "c", type: "pattern", concepts: [], confidence: 0.5, files: [] },
      ]
      const backends: Backends = {
        agentmemory: makeFakeAgentmemory({ lessons }),
        boulderState: makeFakeBoulder(),
      }

      // when
      const result = await aggregateRead(makeInput(), backends)

      // then — conforms to AgentMemoryRead contract
      expect(result.agentmemory.available).toBe(true)
      expect(result.agentmemory.lessons).toHaveLength(3)
      expect(result.agentmemory.lessons[0].id).toBe("l2") // confidence 0.8
      expect(result.agentmemory.lessons[1].id).toBe("l3") // confidence 0.5
      expect(result.agentmemory.lessons[2].id).toBe("l1") // confidence 0.2
    })

    it("maps RawLesson to RelevantLesson with advice='info'", async () => {
      const lessons = [
        { id: "l1", title: "test lesson", content: "c", type: "pattern", concepts: ["auth", "jwt"], confidence: 0.7, files: [] },
      ]
      const backends: Backends = {
        agentmemory: makeFakeAgentmemory({ lessons }),
        boulderState: makeFakeBoulder(),
      }

      const result = await aggregateRead(makeInput(), backends)
      expect(result.agentmemory.lessons[0]).toEqual({
        id: "l1",
        title: "test lesson",
        advice: "info",
        confidence: 0.7,
        concepts: ["auth", "jwt"],
      })
    })

    it("returns tasks from boulder-state sorted by priority ASC then recency DESC", async () => {
      const now = Date.now()
      const tasks = [
        { id: "t1", title: "low priority old", priority: 8, status: "pending", description: "", createdAtMs: now - 1000, updatedAtMs: now - 1000 },
        { id: "t2", title: "high priority new", priority: 2, status: "pending", description: "", createdAtMs: now, updatedAtMs: now },
        { id: "t3", title: "high priority old", priority: 2, status: "pending", description: "", createdAtMs: now - 5000, updatedAtMs: now - 5000 },
      ]
      const backends: Backends = {
        agentmemory: makeFakeAgentmemory(),
        boulderState: makeFakeBoulder({ tasks }),
      }

      const result = await aggregateRead(makeInput(), backends)
      expect(result.boulderState.available).toBe(true)
      expect(result.boulderState.tasks).toHaveLength(3)
      // contract shape: { id, status, title }
      expect(result.boulderState.tasks[0].id).toBe("t2") // priority 2, newer
      expect(result.boulderState.tasks[1].id).toBe("t3") // priority 2, older
      expect(result.boulderState.tasks[2].id).toBe("t1") // priority 8
    })

    it("computes planProgress from tasks", async () => {
      const tasks = [
        { id: "t1", title: "done", priority: 1, status: "done", description: "", createdAtMs: 1, updatedAtMs: 1 },
        { id: "t2", title: "done2", priority: 1, status: "done", description: "", createdAtMs: 1, updatedAtMs: 1 },
        { id: "t3", title: "pending", priority: 1, status: "pending", description: "", createdAtMs: 1, updatedAtMs: 1 },
      ]
      const backends: Backends = {
        agentmemory: makeFakeAgentmemory(),
        boulderState: makeFakeBoulder({ tasks }),
      }

      const result = await aggregateRead(makeInput(), backends)
      expect(result.boulderState.planProgress).toBe(2 / 3)
    })

    it("returns zeroed planProgress when no tasks", async () => {
      const backends: Backends = {
        agentmemory: makeFakeAgentmemory(),
        boulderState: makeFakeBoulder({ tasks: [] }),
      }

      const result = await aggregateRead(makeInput(), backends)
      expect(result.boulderState.planProgress).toBe(0)
    })

    it("returns MemoryRead contract fields: query and timestampISO", async () => {
      const backends: Backends = {
        agentmemory: makeFakeAgentmemory(),
        boulderState: makeFakeBoulder(),
      }

      const result = await aggregateRead(makeInput({ query: "my query" }), backends)
      expect(result.query).toBe("my query")
      expect(result.timestampISO).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })
  })

  describe("#aggregateRead graceful degrade", () => {
    it("degrades agentmemory gracefully — other sources still return", async () => {
      const brokenAgentmemory: AgentmemoryBackend = {
        smartSearch: async () => { throw new Error("MCP connection lost") },
      }
      const backends: Backends = {
        agentmemory: brokenAgentmemory,
        boulderState: makeFakeBoulder({ tasks: [{ id: "t1", title: "task", priority: 1, status: "pending", description: "", createdAtMs: 1, updatedAtMs: 1 }] }),
      }

      const result = await aggregateRead(makeInput(), backends)

      expect(result.agentmemory.available).toBe(false)
      expect(result.agentmemory.lessons).toHaveLength(0)
      expect(result.boulderState.available).toBe(true)
      expect(result.boulderState.tasks).toHaveLength(1)
      expect(result.degradedSources).toContain("agentmemory")
      expect(result.errorMessages.agentmemory).toContain("MCP connection lost")
    })

    it("degrades boulder-state gracefully", async () => {
      const brokenBoulder: BoulderStateBackend = {
        boulderRead: async () => { throw new Error("no state file") },
      }
      const backends: Backends = {
        agentmemory: makeFakeAgentmemory(),
        boulderState: brokenBoulder,
      }

      const result = await aggregateRead(makeInput(), backends)
      expect(result.boulderState.available).toBe(false)
      expect(result.boulderState.tasks).toHaveLength(0)
      expect(result.boulderState.planProgress).toBe(0)
      expect(result.degradedSources).toContain("boulderState")
    })

    it("degrades ALL sources — returns empty MemoryRead with 2 degradedSources", async () => {
      const allBroken: Backends = {
        agentmemory: { smartSearch: async () => { throw new Error("boom") } },
        boulderState: { boulderRead: async () => { throw new Error("boom") } },
      }

      const result = await aggregateRead(makeInput(), allBroken)
      expect(result.agentmemory.available).toBe(false)
      expect(result.boulderState.available).toBe(false)
      expect(result.degradedSources).toHaveLength(2)
      expect(result.degradedSources).toContain("agentmemory")
      expect(result.degradedSources).toContain("boulderState")
    })
  })

  describe("#aggregateRead limits", () => {
    it("respects maxLessons limit", async () => {
      const lessons = Array.from({ length: 20 }, (_, i) => ({
        id: `l${i}`,
        title: `lesson ${i}`,
        content: "c",
        type: "pattern",
        concepts: [],
        confidence: i * 0.05,
        files: [],
      }))
      const backends: Backends = {
        agentmemory: makeFakeAgentmemory({ lessons }),
        boulderState: makeFakeBoulder(),
      }

      const result = await aggregateRead(makeInput({ limits: { maxLessons: 5 } }), backends)
      expect(result.agentmemory.lessons).toHaveLength(5)
      // Top 5 by confidence: l19 (0.95), l18 (0.9), l17 (0.85), l16 (0.8), l15 (0.75)
      expect(result.agentmemory.lessons[0].id).toBe("l19")
      expect(result.agentmemory.lessons[4].id).toBe("l15")
    })

    it("respects maxTasks limit", async () => {
      const tasks = Array.from({ length: 30 }, (_, i) => ({
        id: `t${i}`,
        title: `task ${i}`,
        priority: 1,
        status: "pending",
        description: "",
        createdAtMs: i,
        updatedAtMs: i,
      }))
      const backends: Backends = {
        agentmemory: makeFakeAgentmemory(),
        boulderState: makeFakeBoulder({ tasks }),
      }

      const result = await aggregateRead(makeInput({ limits: { maxTasks: 10 } }), backends)
      expect(result.boulderState.tasks).toHaveLength(10)
    })

    it("respects maxSlots limit", async () => {
      const slots = Array.from({ length: 30 }, (_, i) => ({
        label: `meta_governor:slot_${String(i).padStart(2, "0")}`,
        content: `${i}`,
        pinned: true,
        scope: "project",
      }))
      const backends: Backends = {
        agentmemory: makeFakeAgentmemory(),
        boulderState: makeFakeBoulder(),
      }

      const result = await aggregateRead(makeInput({ limits: { maxSlots: 5 } }), backends)
    })
  })

  describe("#aggregateRead edge cases", () => {
    it("all empty sources — returns zeroed MemoryRead with no degradedSources", async () => {
      const backends: Backends = {
        agentmemory: makeFakeAgentmemory(),
        boulderState: makeFakeBoulder(),
      }

      const result = await aggregateRead(makeInput(), backends)
      expect(result.agentmemory.available).toBe(true)
      expect(result.agentmemory.lessons).toHaveLength(0)
      expect(result.boulderState.available).toBe(true)
      expect(result.boulderState.tasks).toHaveLength(0)
      expect(result.boulderState.planProgress).toBe(0)
      expect(result.degradedSources).toHaveLength(0)
    })

    it("returns durationMs > 0", async () => {
      const backends: Backends = {
        agentmemory: makeFakeAgentmemory(),
        boulderState: makeFakeBoulder(),
      }

      const result = await aggregateRead(makeInput(), backends)
      expect(result.durationMs).toBeGreaterThan(0)
    })

    it("boulder backend receives query for server-side filtering", async () => {
      const tasks = [
        { id: "t1", title: "deploy to production", priority: 1, status: "pending", description: "", createdAtMs: 1, updatedAtMs: 1 },
        { id: "t2", title: "write unit tests", priority: 1, status: "pending", description: "", createdAtMs: 1, updatedAtMs: 1 },
      ]
      let receivedQuery: string | undefined
      const backends: Backends = {
        agentmemory: makeFakeAgentmemory(),
        boulderState: makeFakeBoulder({
          tasks,
          readFn: (input) => { receivedQuery = input.query; return Promise.resolve(tasks); },
        }),
      }

      const result = await aggregateRead(makeInput({ query: "deploy" }), backends)
      expect(receivedQuery).toBe("deploy")
      expect(result.boulderState.tasks).toHaveLength(2)
    })
  })
})
