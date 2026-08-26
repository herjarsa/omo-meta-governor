/**
 * MetaGovernor v0.13.0 Multi-Phase DONE Semantics — RED→GREEN tests.
 *
 * The gap (user-reported): v0.10.0's `respectDoneSignal` latches
 * `interventionDisabled=true` for the whole session after `<promise>DONE</promise>`
 * + Oracle verification. Multi-phase plans (Phase 1 → Phase 2) lose
 * governance at Phase 2 because the latch never resets.
 *
 * v0.13.0 fix introduces:
 *   - New marker `<promise>PLAN-COMPLETE</promise>` — terminal signal that
 *     always latches intervention when Oracle has verified.
 *   - New config flag `phaseAwareDoneSignal?: boolean` (default: false in
 *     v0.13.0 to preserve v0.10.0 backwards compat).
 *     When true: `<promise>DONE</promise>` and `<promise>PHASE-N-COMPLETE</promise>`
 *     are per-phase hints and do NOT latch intervention. Only PLAN-COMPLETE
 *     latches.
 *     When false (legacy): DONE latches as in v0.10.0.
 *
 * Migration: users with multi-phase plans set `phaseAwareDoneSignal: true`
 * and emit `<promise>PLAN-COMPLETE</promise>` only when the entire plan is
 * done.
 */

import { describe, expect, it } from "bun:test"
import {
  detectPhaseCompleteSignal,
  detectPlanCompleteSignal,
  detectDoneSignal,
} from "./plugin"
import { createHermeticPlugin } from "./__test-helpers__/hermetic-plugin"

describe("v0.13.0 plan-complete regex detector", () => {
  it("accepts <promise>PLAN-COMPLETE</promise>", () => {
    expect(detectPlanCompleteSignal("<promise>PLAN-COMPLETE</promise>")).toBe(true)
  })
  it("accepts case-insensitive variants", () => {
    expect(detectPlanCompleteSignal("<promise>plan-complete</promise>")).toBe(true)
    expect(detectPlanCompleteSignal("<promise>Plan-Complete</promise>")).toBe(true)
  })
  it("accepts optional whitespace", () => {
    expect(detectPlanCompleteSignal("<promise>\n  PLAN-COMPLETE  \n</promise>")).toBe(true)
  })
  it("rejects unrelated markers", () => {
    expect(detectPlanCompleteSignal("<promise>DONE</promise>")).toBe(false)
    expect(detectPlanCompleteSignal("<promise>PHASE-2-COMPLETE</promise>")).toBe(false)
    expect(detectPlanCompleteSignal("PLAN-COMPLETE")).toBe(false)
    expect(detectPlanCompleteSignal("")).toBe(false)
    expect(detectPlanCompleteSignal(undefined)).toBe(false)
    expect(detectPlanCompleteSignal(null)).toBe(false)
  })
})

describe("v0.13.0 phase-complete regex detector", () => {
  it("accepts <promise>DONE</promise> (backward compat)", () => {
    expect(detectPhaseCompleteSignal("<promise>DONE</promise>")).toBe(true)
  })
  it("accepts <promise>PHASE-N-COMPLETE</promise>", () => {
    expect(detectPhaseCompleteSignal("<promise>PHASE-1-COMPLETE</promise>")).toBe(true)
    expect(detectPhaseCompleteSignal("<promise>PHASE-42-COMPLETE</promise>")).toBe(true)
  })
  it("accepts case-insensitive variants", () => {
    expect(detectPhaseCompleteSignal("<promise>done</promise>")).toBe(true)
    expect(detectPhaseCompleteSignal("<promise>phase-2-complete</promise>")).toBe(true)
  })
  it("rejects unrelated markers", () => {
    expect(detectPhaseCompleteSignal("<promise>PLAN-COMPLETE</promise>")).toBe(false)
    expect(detectPhaseCompleteSignal("<promise>NEXT-PHASE</promise>")).toBe(false)
    expect(detectPhaseCompleteSignal("")).toBe(false)
    expect(detectPhaseCompleteSignal(undefined)).toBe(false)
    expect(detectPhaseCompleteSignal(null)).toBe(false)
  })
})

describe("v0.13.0 legacy detector still works for v0.10.0 compat", () => {
  it("detectDoneSignal returns true for v0.10.0 markers only", () => {
    expect(detectDoneSignal("<promise>DONE</promise>")).toBe(true)
    expect(detectDoneSignal("<promise>DONE!</promise>")).toBe(true)
    // Should NOT match the new PHASE marker or PLAN-COMPLETE — those are new semantics
    expect(detectDoneSignal("<promise>PHASE-1-COMPLETE</promise>")).toBe(false)
    expect(detectDoneSignal("<promise>PLAN-COMPLETE</promise>")).toBe(false)
  })
})
