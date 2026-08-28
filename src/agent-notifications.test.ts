import { describe, it, expect } from "bun:test"
import { wrapInformational, buildUserStatus, AGENT_NOTIFICATION_MARKERS } from "./agent-notifications"

describe("wrapInformational (v0.38.2)", () => {
  it("adds 'DO NOT TREAT AS TASK' marker", () => {
    const wrapped = wrapInformational("body text", { kind: "graph-priming" })
    expect(wrapped).toContain("DO NOT TREAT AS TASK")
  })

  it("includes version in marker", () => {
    const wrapped = wrapInformational("body", { kind: "graph-priming" })
    expect(wrapped).toContain(AGENT_NOTIFICATION_MARKERS.VERSION)
    expect(wrapped).toMatch(/v\d+\.\d+\.\d+/)
  })

  it("includes kind label", () => {
    const wrapped = wrapInformational("body", { kind: "skill-priming" })
    expect(wrapped).toContain("kind: skill-priming")
  })

  it("includes optional context label", () => {
    const wrapped = wrapInformational("body", { kind: "skill-priming", context: "router=both" })
    expect(wrapped).toContain("kind: skill-priming (router=both)")
  })

  it("preserves the original body text", () => {
    const body = "[GRAPH PRIMING] query omo_search for architecture"
    const wrapped = wrapInformational(body, { kind: "graph-priming" })
    expect(wrapped).toContain(body)
  })

  it("has both open and close markers", () => {
    const wrapped = wrapInformational("body", { kind: "graph-priming" })
    expect(wrapped).toContain(AGENT_NOTIFICATION_MARKERS.OPEN)
    expect(wrapped).toContain(AGENT_NOTIFICATION_MARKERS.CLOSE)
  })

  it("OPEN marker appears before body, CLOSE marker after", () => {
    const wrapped = wrapInformational("BODY-CONTENT", { kind: "memory" })
    const openIdx = wrapped.indexOf(AGENT_NOTIFICATION_MARKERS.OPEN)
    const bodyIdx = wrapped.indexOf("BODY-CONTENT")
    const closeIdx = wrapped.indexOf(AGENT_NOTIFICATION_MARKERS.CLOSE)
    expect(openIdx).toBeLessThan(bodyIdx)
    expect(bodyIdx).toBeLessThan(closeIdx)
  })
})

describe("buildUserStatus (v0.38.2)", () => {
  it("starts with kind-specific emoji", () => {
    expect(buildUserStatus("graph-priming", "test summary")).toMatch(/^🔍/)
    expect(buildUserStatus("skill-priming", "test summary")).toMatch(/^🎯/)
    expect(buildUserStatus("intervention", "test summary")).toMatch(/^⚠️/)
    expect(buildUserStatus("postwave", "test summary")).toMatch(/^🌊/)
    expect(buildUserStatus("enforcement", "test summary")).toMatch(/^🚧/)
    expect(buildUserStatus("memory", "test summary")).toMatch(/^💭/)
  })

  it("includes the summary text", () => {
    expect(buildUserStatus("graph-priming", "use omo_search")).toContain("use omo_search")
  })

  it("does NOT include 'DO NOT TREAT AS TASK' marker (that's for agent only)", () => {
    const status = buildUserStatus("graph-priming", "test")
    expect(status).not.toContain("DO NOT TREAT AS TASK")
    expect(status).not.toContain("META-GOVERNOR INFORMATIONAL")
  })

  it("is brief (less than 200 chars for typical summary)", () => {
    const status = buildUserStatus("graph-priming", "test summary here")
    expect(status.length).toBeLessThan(200)
  })
})

describe("AGENT_NOTIFICATION_MARKERS constants", () => {
  it("OPEN and CLOSE are non-empty", () => {
    expect(AGENT_NOTIFICATION_MARKERS.OPEN.length).toBeGreaterThan(0)
    expect(AGENT_NOTIFICATION_MARKERS.CLOSE.length).toBeGreaterThan(0)
  })

  it("VERSION is a semver-like string", () => {
    expect(AGENT_NOTIFICATION_MARKERS.VERSION).toMatch(/^v\d+\.\d+\.\d+/)
  })

  it("KIND_EMOJI has entries for all 6 kinds", () => {
    expect(Object.keys(AGENT_NOTIFICATION_MARKERS.KIND_EMOJI)).toHaveLength(6)
  })
})

describe("separation contract (v0.38.2 regression)", () => {
  it("agent and user outputs are visually distinct", () => {
    const agent = wrapInformational("instruction text", { kind: "graph-priming" })
    const user = buildUserStatus("graph-priming", "instruction text")
    // Agent has marker, user doesn't
    expect(agent).toContain("DO NOT TREAT AS TASK")
    expect(user).not.toContain("DO NOT TREAT AS TASK")
    // Both can have the body content, but only the agent has markers around it
    expect(agent).toContain("instruction text")
    expect(user).toContain("instruction text")
  })
})
