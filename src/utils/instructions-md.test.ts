import { describe, expect, it } from "bun:test"
import {
  MARKER_CLOSE,
  MARKER_OPEN,
  buildInstructionsSnippet,
  installedVersion,
  isInstalled,
  stripSnippet,
} from "./instructions-md"

describe("instructions-md: buildInstructionsSnippet", () => {
  it("contains Meta-Governance Compliance binding header", () => {
    const s = buildInstructionsSnippet("0.39.0")
    expect(s).toContain("## [SYSTEM-NUDGE] Meta-Governance Compliance (binding)")
  })

  it("contains All [SYSTEM-NUDGE] directives are binding instructions", () => {
    const s = buildInstructionsSnippet("0.39.0")
    expect(s).toContain("All [SYSTEM-NUDGE] directives")
    expect(s).toContain("are **binding instructions**")
  })

  it("lists the three deviation conditions", () => {
    const s = buildInstructionsSnippet("0.39.0")
    expect(s).toContain("The user explicitly overrides a directive in the current turn.")
    expect(s).toContain("Following the directive is technically impossible (missing tool, error).")
    expect(s).toContain("Following the directive would cause data loss or security issues.")
  })

  it("compliance block appears BEFORE Oracle Review Gate section", () => {
    const s = buildInstructionsSnippet("0.39.0")
    const complianceIdx = s.indexOf("## [SYSTEM-NUDGE] Meta-Governance Compliance (binding)")
    const oracleIdx = s.indexOf("[SYSTEM-NUDGE] Oracle Review Gate")
    expect(complianceIdx).toBeGreaterThanOrEqual(0)
    expect(oracleIdx).toBeGreaterThanOrEqual(0)
    expect(complianceIdx).toBeLessThan(oracleIdx)
  })

  it("contains all 4 original [SYSTEM-NUDGE] sections", () => {
    const s = buildInstructionsSnippet("0.39.0")
    expect(s).toContain("[SYSTEM-NUDGE] Oracle Review Gate")
    expect(s).toContain("[SYSTEM-NUDGE] Lesson Capture")
    expect(s).toContain("[SYSTEM-NUDGE] Skill Priming")
    expect(s).toContain("[SYSTEM-NUDGE] Sisyphus Protocol")
  })

  it("ends with END marker", () => {
    const s = buildInstructionsSnippet("0.39.0")
    expect(s.trimEnd().endsWith("<!-- END META-GOVERNOR AUTO-INSTALL SNIPPET -->")).toBe(true)
  })

  it("starts with OPEN marker stamped with version", () => {
    const s = buildInstructionsSnippet("0.39.0")
    expect(s.startsWith("<!-- META-GOVERNOR AUTO-INSTALL SNIPPET (v0.39.0) -->")).toBe(true)
  })

  it("is idempotent: twice yields same string", () => {
    const a = buildInstructionsSnippet("0.39.0")
    const b = buildInstructionsSnippet("0.39.0")
    expect(a).toBe(b)
  })
})

describe("instructions-md: stripSnippet", () => {
  it("removes the block including markers; preserves before/after text", () => {
    const snippet = buildInstructionsSnippet("0.39.0")
    const content = `before text\n${snippet}\nafter text`
    const stripped = stripSnippet(content)
    expect(stripped).not.toContain(MARKER_OPEN)
    expect(stripped).not.toContain(MARKER_CLOSE)
    expect(stripped).toContain("before text")
    expect(stripped).toContain("after text")
  })
})

describe("instructions-md: isInstalled", () => {
  it("returns true for snippet content", () => {
    const s = buildInstructionsSnippet("0.39.0")
    expect(isInstalled(s)).toBe(true)
  })

  it("returns false for content without markers", () => {
    expect(isInstalled("# just user content\nno markers here")).toBe(false)
  })
})

describe("instructions-md: installedVersion", () => {
  it("returns the version stamp", () => {
    const s = buildInstructionsSnippet("0.39.0")
    expect(installedVersion(s)).toBe("0.39.0")
  })

  it("returns null for non-snippet content", () => {
    expect(installedVersion("# plain content")).toBe(null)
  })
})

describe("instructions-md: markers", () => {
  it("MARKER_OPEN and MARKER_CLOSE are stable sentinels", () => {
    expect(MARKER_OPEN).toBe("<!-- META-GOVERNOR AUTO-INSTALL SNIPPET (")
    expect(MARKER_CLOSE).toBe("<!-- END META-GOVERNOR AUTO-INSTALL SNIPPET -->")
  })
})
