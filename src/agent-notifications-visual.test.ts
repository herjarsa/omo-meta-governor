/**
 * FASE 10 — Visual differentiation via Markdown frame.
 *
 * Wrap the plugin's directives with a visible Markdown frame (borders,
 * header, footer) so the user can clearly see when something is from the
 * plugin vs the main agent. The LLM still gets the existing HTML markers
 * (DO NOT TREAT AS TASK), but the visual frame is the part that surfaces
 * to the user in OpenCode's TUI.
 */
import { describe, it, expect } from "bun:test";
import { wrapInformational, AGENT_NOTIFICATION_MARKERS } from "./agent-notifications";

describe("FASE 10 wrapInformational visual frame", () => {
  it("wraps the body with horizontal rule borders so the user sees a clear box", () => {
    const wrapped = wrapInformational("body text", { kind: "intervention" });
    expect(wrapped).toMatch(/━{5,}/);
  });

  it("includes a visible '## [omo-meta-governor] AUDITOR — <KIND>' Markdown header", () => {
    const wrapped = wrapInformational("body text", { kind: "intervention" });
    expect(wrapped).toMatch(/## .+ `\[omo-meta-governor\]` AUDITOR — INTERVENTION/);
    expect(wrapped).toContain("##");
  });

  it("includes a kind-specific emoji from KIND_EMOJI", () => {
    expect(wrapInformational("body", { kind: "graph-priming" })).toContain("🔍");
    expect(wrapInformational("body", { kind: "skill-priming" })).toContain("🎯");
    expect(wrapInformational("body", { kind: "intervention" })).toContain("⚠️");
    expect(wrapInformational("body", { kind: "postwave" })).toContain("🌊");
    expect(wrapInformational("body", { kind: "enforcement" })).toContain("🚧");
    expect(wrapInformational("body", { kind: "memory" })).toContain("💭");
  });

  it("includes a footer indicating the message is synthetic (from omo-meta-governor)", () => {
    const wrapped = wrapInformational("body", { kind: "intervention" });
    expect(wrapped.toLowerCase()).toMatch(/synthetic.*omo-meta-governor|omo-meta-governor.*synthetic/);
  });

  it("preserves the original HTML markers so the LLM still gets DO NOT TREAT AS TASK", () => {
    const wrapped = wrapInformational("body text", { kind: "intervention" });
    expect(wrapped).toContain(AGENT_NOTIFICATION_MARKERS.OPEN);
    expect(wrapped).toContain(AGENT_NOTIFICATION_MARKERS.CLOSE);
    expect(wrapped).toContain("DO NOT TREAT AS TASK");
    expect(wrapped).toContain("body text");
  });

  it("OPEN marker still appears before body, CLOSE marker after (regression)", () => {
    const wrapped = wrapInformational("BODY-CONTENT", { kind: "memory" });
    const openIdx = wrapped.indexOf(AGENT_NOTIFICATION_MARKERS.OPEN);
    const bodyIdx = wrapped.indexOf("BODY-CONTENT");
    const closeIdx = wrapped.indexOf(AGENT_NOTIFICATION_MARKERS.CLOSE);
    expect(openIdx).toBeLessThan(bodyIdx);
    expect(bodyIdx).toBeLessThan(closeIdx);
  });

  it("visual frame is between the existing HTML markers (not outside)", () => {
    const wrapped = wrapInformational("body", { kind: "intervention" });
    const openIdx = wrapped.indexOf(AGENT_NOTIFICATION_MARKERS.OPEN);
    const closeIdx = wrapped.indexOf(AGENT_NOTIFICATION_MARKERS.CLOSE);
    // Find any emoji-based header line
    const frameIdx = wrapped.indexOf("## \u26a0\ufe0f `[omo-meta-governor]`");
    expect(openIdx).toBeLessThan(frameIdx);
    expect(frameIdx).toBeLessThan(closeIdx);
  });
});
