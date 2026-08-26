import { describe, expect, test } from "bun:test"
import { shouldSendReminder, formatReminder } from "./skills-tier3-reminder.js"

describe("shouldSendReminder", () => {
  test("returns true on first call for a query", () => {
    const state = { sent: new Map(), maxPerSession: 3, cooldownMs: 0 }
    expect(shouldSendReminder("foo", state)).toBe(true)
  })

  test("returns false after reminder already sent for same query in session", () => {
    const state = { sent: new Map([["foo", 1]]), maxPerSession: 3, cooldownMs: 0 }
    expect(shouldSendReminder("foo", state)).toBe(false)
  })

  test("returns false after 3 reminders sent (circuit breaker)", () => {
    const state = {
      sent: new Map([["a", 1], ["b", 1], ["c", 1]]),
      maxPerSession: 3, cooldownMs: 0,
    }
    expect(shouldSendReminder("d", state)).toBe(false)
  })
})

describe("formatReminder", () => {
  test("mentions writing-skills", () => {
    const r = formatReminder()
    expect(r).toContain("writing-skills")
  })
})
