/**
 * Sisyphus Protocol Enforcer Tests.
 *
 * given/when/then style. Covers:
 * - loadProtocol: reads protocol markdown from disk
 * - buildSystemInjection: condenses protocol for system prompt
 * - auditToolCall: detects various protocol violations
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { mkdir, writeFile, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { tmpdir } from "node:os"
import {
  loadProtocol,
  buildSystemInjection,
  auditToolCall,
  DEFAULT_PROTOCOL_PATH,
} from "./protocol-enforcer"
import type { ProtocolViolation } from "./types"

// ─── Helpers ─────────────────────────────────────────────────────

let tempDir = ""

async function createTempProtocol(content: string): Promise<string> {
  const dir = resolve(tmpdir(), `proto-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(dir, { recursive: true })
  const filePath = resolve(dir, "protocol.md")
  await writeFile(filePath, content, "utf-8")
  tempDir = dir
  return filePath
}

async function cleanupTemp(): Promise<void> {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = ""
  }
}

// ─── Tests ───────────────────────────────────────────────────────

describe("protocol-enforcer", () => {
  describe("#given loadProtocol", () => {
    afterEach(async () => {
      await cleanupTemp()
    })

    it("then reads protocol markdown from custom path", async () => {
      // given
      const content = "# Test Protocol\n\nThis is test content."
      const filePath = await createTempProtocol(content)

      // when
      const result = await loadProtocol(filePath)

      // then
      expect(result).toContain("Test Protocol")
      expect(result).toContain("test content")
    })

    it("then reads protocol from default path when no path provided", async () => {
      // given — only works if the default protocol file exists
      // CI runners don't have the sisyphus-mandatory file, so this test
      // gracefully handles ENOENT by skipping the assertions
      let result: string
      try {
        result = await loadProtocol()
      } catch (err) {
        // File doesn't exist in this environment - skip the test
        return
      }

      // then
      expect(result.length).toBeGreaterThan(0)
      expect(result).toContain("Sisyphus")
    })
  })

  describe("#given buildSystemInjection", () => {
    it("then returns condensed markdown with key sections", () => {
      // given
      const protocolText = `# Protocol\n\n## Pre-response\n\nCheck memory first.\n\n## Oracle\n\nInvoke on 3+ changes.`

      // when
      const result = buildSystemInjection(protocolText)

      // then
      expect(result).toContain("Sisyphus Protocol Enforcement")
      expect(result).toContain("Pre-response Memory Check")
      expect(result).toContain("Codebase Graph First")
      expect(result).toContain("Tool Routing Table")
      expect(result).toContain("Self-Check Before Responding")
    })

    it("then includes Oracle section when protocol text mentions oracle", () => {
      // given — protocol with Oracle section
      const protocolWithOracle = `# Protocol\n\n## Post-task Oracle\n\nInvoke oracle when needed.`
      const protocolWithoutOracle = `# Protocol\n\n## Just memory rules\n\nNo mythical gods or entities here.`

      // when
      const withOracle = buildSystemInjection(protocolWithOracle)
      const withoutOracle = buildSystemInjection(protocolWithoutOracle)

      // then
      expect(withOracle).toContain("Post-task Oracle Verification")
      expect(withoutOracle).not.toContain("Post-task Oracle Verification")
    })

    // v0.29.0: Gap G — buildSystemInjection accepts audit state and drops
    // rule 4 once Oracle has verified. Without this, the system prompt
    // re-injects the "invoke Oracle" reminder on every LLM turn.
    it("then skips Oracle section when oracleVerified=true and filesChanged>0", () => {
      const protocolWithOracle = `# Protocol\n\n## Post-task Oracle\n\nInvoke oracle when needed.`
      const result = buildSystemInjection(protocolWithOracle, {
        oracleVerified: true,
        filesChanged: 3,
      })
      expect(result).not.toContain("Post-task Oracle Verification")
    })

    it("then keeps Oracle section when oracleVerified=false even with files>0", () => {
      const protocolWithOracle = `# Protocol\n\n## Post-task Oracle\n\nInvoke oracle when needed.`
      const result = buildSystemInjection(protocolWithOracle, {
        oracleVerified: false,
        filesChanged: 5,
      })
      expect(result).toContain("Post-task Oracle Verification")
    })

    it("then keeps Oracle section when filesChanged=0 even if oracleVerified", () => {
      // Edge case: zero files touched means no work happened yet — the agent
      // still needs the Oracle reminder as a standing instruction.
      const protocolWithOracle = `# Protocol\n\n## Post-task Oracle\n\nInvoke oracle when needed.`
      const result = buildSystemInjection(protocolWithOracle, {
        oracleVerified: true,
        filesChanged: 0,
      })
      expect(result).toContain("Post-task Oracle Verification")
    })

    it("then preserves all other rules when Oracle section is dropped (Gap G)", () => {
      const protocolWithOracle = `# Protocol\n\n## Post-task Oracle\n\nInvoke oracle when needed.`
      const result = buildSystemInjection(protocolWithOracle, {
        oracleVerified: true,
        filesChanged: 3,
      })
      // Other rules remain — only rule 4 (Post-task Oracle) is dropped.
      expect(result).toContain("Pre-response Memory Check")
      expect(result).toContain("Codebase Graph First")
      expect(result).toContain("Parallel Query Rule")
      expect(result).toContain("Hard Rules")
      expect(result).toContain("Self-Check Before Responding")
    })

    // v0.29.0: Gap H — the Oracle rule in auditToolCall fires only on write
    // tools, not on read/grep/edit_block. Previously fired on every tool call
    // once filesChanged>=3 && !oracleInvoked, polluting the context with
    // duplicate reminders during background-task waits.
    it("then does NOT fire Oracle rule on read tools when filesChanged>=3", () => {
      const violations = auditToolCall("read", {}, {
        memoryToolsUsed: [],
        hasCodegraphDir: true,
        hasGraphifyDir: false,
        oracleInvoked: false,
        filesChanged: 5,
        emptyRecall: false,
        escalationAttempted: false,
        recentToolCalls: ["read"],
      })
      const oracleViolations = violations.filter((v) => v.rule === "oracle-verification")
      expect(oracleViolations.length).toBe(0)
    })

    it("then does NOT fire Oracle rule on grep tools when filesChanged>=3", () => {
      const violations = auditToolCall("grep", {}, {
        memoryToolsUsed: [],
        hasCodegraphDir: true,
        hasGraphifyDir: false,
        oracleInvoked: false,
        filesChanged: 5,
        emptyRecall: false,
        escalationAttempted: false,
        recentToolCalls: ["grep"],
      })
      const oracleViolations = violations.filter((v) => v.rule === "oracle-verification")
      expect(oracleViolations.length).toBe(0)
    })

    it("then DOES fire Oracle rule on write tools when filesChanged>=3", () => {
      const violations = auditToolCall("write", { content: "x" }, {
        memoryToolsUsed: [],
        hasCodegraphDir: true,
        hasGraphifyDir: false,
        oracleInvoked: false,
        filesChanged: 5,
        emptyRecall: false,
        escalationAttempted: false,
        recentToolCalls: ["write"],
      })
      const oracleViolations = violations.filter((v) => v.rule === "oracle-verification")
      expect(oracleViolations.length).toBe(1)
    })

    it("then does NOT fire Oracle rule on write tools when oracleInvoked=true", () => {
      // Once Oracle has been consulted, the rule no longer applies regardless
      // of how many files have been touched.
      const violations = auditToolCall("write", { content: "x" }, {
        memoryToolsUsed: [],
        hasCodegraphDir: true,
        hasGraphifyDir: false,
        oracleInvoked: true,
        filesChanged: 10,
        emptyRecall: false,
        escalationAttempted: false,
        recentToolCalls: ["write"],
      })
      const oracleViolations = violations.filter((v) => v.rule === "oracle-verification")
      expect(oracleViolations.length).toBe(0)
    })
  })

  describe("#given auditToolCall with codegraph dir", () => {
    it("then detects grep usage as codebase-graph-first violation", () => {
      // given
      const violations = auditToolCall("grep", {}, {
        memoryToolsUsed: [],
        hasCodegraphDir: true,
        hasGraphifyDir: false,
        oracleInvoked: false,
        filesChanged: 0,
        emptyRecall: false,
        escalationAttempted: false,
      })

      // then
      expect(violations.length).toBe(1)
      expect(violations[0]!.rule).toBe("codebase-graph-first")
      expect(violations[0]!.severity).toBe("media")
      expect(violations[0]!.tool).toBe("grep")
    })

    it("then detects glob usage as codebase-graph-first violation", () => {
      // given
      const violations = auditToolCall("glob", {}, {
        memoryToolsUsed: [],
        hasCodegraphDir: false,
        hasGraphifyDir: true,
        oracleInvoked: false,
        filesChanged: 0,
        emptyRecall: false,
        escalationAttempted: false,
      })

      // then
      expect(violations.length).toBe(1)
      expect(violations[0]!.rule).toBe("codebase-graph-first")
      expect(violations[0]!.severity).toBe("media")
    })

    it("then does NOT flag grep when no graph directory exists", () => {
      // given
      const violations = auditToolCall("grep", {}, {
        memoryToolsUsed: [],
        hasCodegraphDir: false,
        hasGraphifyDir: false,
        oracleInvoked: false,
        filesChanged: 0,
        emptyRecall: false,
        escalationAttempted: false,
      })

      // then
      expect(violations.length).toBe(0)
    })
  })

  describe("#given auditToolCall with memory rules", () => {
    it("then detects asking question without memory usage as memory-first violation", () => {
      // given
      const violations = auditToolCall("ask", {}, {
        memoryToolsUsed: [],
        hasCodegraphDir: false,
        hasGraphifyDir: false,
        oracleInvoked: false,
        filesChanged: 0,
        emptyRecall: false,
        escalationAttempted: false,
      })

      // then
      expect(violations.length).toBe(1)
      expect(violations[0]!.rule).toBe("memory-first")
      expect(violations[0]!.severity).toBe("grave")
    })

    it("then does NOT flag question when memory tools were used", () => {
      // given
      const violations = auditToolCall("ask", {}, {
        memoryToolsUsed: ["agentmemory_memory_recall"],
        hasCodegraphDir: false,
        hasGraphifyDir: false,
        oracleInvoked: false,
        filesChanged: 0,
        emptyRecall: false,
        escalationAttempted: false,
      })

      // then
      expect(violations.length).toBe(0)
    })

    it("then returns empty for clean tools like lsp_diagnostics", () => {
      // given
      const violations = auditToolCall("lsp_diagnostics", {}, {
        memoryToolsUsed: ["agentmemory_memory_recall"],
        hasCodegraphDir: false,
        hasGraphifyDir: false,
        oracleInvoked: false,
        filesChanged: 0,
        emptyRecall: false,
        escalationAttempted: false,
      })

      // then
      expect(violations.length).toBe(0)
    })
  })

  describe("#given auditToolCall with empty recall", () => {
    it("then detects asking question after empty recall without escalation", () => {
      // given
      const violations = auditToolCall("question", {}, {
        memoryToolsUsed: ["agentmemory_memory_recall"],
        hasCodegraphDir: false,
        hasGraphifyDir: false,
        oracleInvoked: false,
        filesChanged: 0,
        emptyRecall: true,
        escalationAttempted: false,
      })

      // then
      expect(violations.length).toBe(1)
      expect(violations[0]!.rule).toBe("empty-result-escalation")
      expect(violations[0]!.severity).toBe("grave")
    })

    it("then does NOT flag escalation when smart_search was attempted", () => {
      // given
      const violations = auditToolCall("question", {}, {
        memoryToolsUsed: ["agentmemory_memory_recall", "agentmemory_memory_smart_search"],
        hasCodegraphDir: false,
        hasGraphifyDir: false,
        oracleInvoked: false,
        filesChanged: 0,
        emptyRecall: true,
        escalationAttempted: true,
      })

      // then
      expect(violations.length).toBe(0)
    })
  })

  describe("#given auditToolCall with file changes", () => {
    it("then flags oracle-verification when files changed >= 3 and oracle not invoked", () => {
      // given
      const violations = auditToolCall("write", {}, {
        memoryToolsUsed: [],
        hasCodegraphDir: false,
        hasGraphifyDir: false,
        oracleInvoked: false,
        filesChanged: 3,
        emptyRecall: false,
        escalationAttempted: false,
      })

      // then
      expect(violations.some((v) => v.rule === "oracle-verification")).toBe(true)
    })

    it("then does NOT flag oracle-verification when oracle was invoked", () => {
      // given
      const violations = auditToolCall("write", {}, {
        memoryToolsUsed: [],
        hasCodegraphDir: false,
        hasGraphifyDir: false,
        oracleInvoked: true,
        filesChanged: 5,
        emptyRecall: false,
        escalationAttempted: false,
      })

      // then
      expect(violations.length).toBe(0)
    })

    it("then does NOT flag oracle-verification when files changed < 3", () => {
      // given
      const violations = auditToolCall("write", {}, {
        memoryToolsUsed: [],
        hasCodegraphDir: false,
        hasGraphifyDir: false,
        oracleInvoked: false,
        filesChanged: 2,
        emptyRecall: false,
        escalationAttempted: false,
      })

      // then
      expect(violations.every((v) => v.rule !== "oracle-verification")).toBe(true)
    })
  })
})
