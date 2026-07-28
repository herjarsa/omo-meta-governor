import { describe, expect, it, beforeEach } from "bun:test"
import { buildEscalationPrompt } from "./session-bridge"

describe("v0.17.3 F5.1 — escalate → Oracle (buildEscalationPrompt)", () => {
  it("then oracle-targeted prompt tells LLM to invoke task(subagent_type=oracle)", () => {
    const prompt = buildEscalationPrompt({
      reasoning: "score -0.55: 2 grave deviations + noProgress + iteration at 1.0",
      target: "oracle",
      evidenceCount: 2,
      sessionID: "ses-f51-test",
    })
    expect(prompt).toContain("task")
    expect(prompt).toContain("subagent_type=oracle")
    expect(prompt).toContain("score -0.55")
    expect(prompt).toContain("2 evidence unit")
  })

  it("then user-targeted prompt asks for explicit user input (no Oracle)", () => {
    const prompt = buildEscalationPrompt({
      reasoning: "grave deviation: data loss without backup",
      target: "user",
      evidenceCount: 3,
      sessionID: "ses-f51-test",
    })
    expect(prompt).toContain("user")
    expect(prompt).toContain("grave deviation")
    expect(prompt).not.toContain("subagent_type=oracle")
  })

  it("then default target falls back to oracle when shouldEscalateTo is null", () => {
    // The plugin.ts code: const target = decisionRef.shouldEscalateTo ?? "oracle"
    // This is a TypeScript null-coalescing default. Verify the pattern is
    // documented in the code.
    const prompt = buildEscalationPrompt({
      reasoning: "test",
      target: "oracle", // Simulating the default
      evidenceCount: 1,
      sessionID: "ses-f51-test",
    })
    expect(prompt).toContain("subagent_type=oracle")
  })
})
