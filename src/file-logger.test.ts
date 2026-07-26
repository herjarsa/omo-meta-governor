import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { logToFile } from "./file-logger"
import { readFileSync, rmSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { homedir } from "node:os"

const LOG_PATH = resolve(homedir(), ".config", "opencode", "meta-governor.log")

describe("file-logger", () => {
  afterEach(() => {
    try { rmSync(LOG_PATH, { force: true }) } catch { /* ignore */ }
  })

  it("writes info level entries as JSONL with timestamp", () => {
    logToFile("info", "test message")
    expect(existsSync(LOG_PATH)).toBe(true)
    const content = readFileSync(LOG_PATH, "utf-8")
    expect(content).toContain(`"level":"info"`)
    expect(content).toContain(`"message":"test message"`)
    expect(content).toMatch(/\d{4}-\d{2}-\d{2}T/)  // ISO timestamp
  })

  it("writes warn level entries as JSONL with warn level", () => {
    logToFile("warn", "warning text")
    const content = readFileSync(LOG_PATH, "utf-8")
    expect(content).toContain(`"level":"warn"`)
    expect(content).toContain(`"message":"warning text"`)
  })

  it("writes error level entries as JSONL with error level", () => {
    logToFile("error", "error text")
    const content = readFileSync(LOG_PATH, "utf-8")
    expect(content).toContain(`"level":"error"`)
    expect(content).toContain(`"message":"error text"`)
  })

  it("serializes data payload as JSON", () => {
    logToFile("info", "with data", { foo: "bar", count: 42 })
    const content = readFileSync(LOG_PATH, "utf-8")
    expect(content).toContain("with data")
    expect(content).toContain(`"foo":"bar"`)
    expect(content).toContain(`"count":42`)
  })

  it("appends multiple entries to the same log file", () => {
    logToFile("info", "first")
    logToFile("info", "second")
    logToFile("info", "third")
    const content = readFileSync(LOG_PATH, "utf-8")
    const lineCount = content.split("\n").filter((l) => l.length > 0).length
    expect(lineCount).toBe(3)
  })
})
