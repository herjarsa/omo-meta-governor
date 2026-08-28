import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { installGlobalErrorHandler } from "./error-handler"

describe("installGlobalErrorHandler", () => {
  let teardown: (() => void) | undefined
  const capturedLogs: Array<{ level: string; msg: string; ctx: unknown }> = []
  const mockLogger = {
    warn: (msg: string, ctx: unknown) => capturedLogs.push({ level: "warn", msg, ctx }),
    error: (msg: string, ctx: unknown) => capturedLogs.push({ level: "error", msg, ctx }),
  }

  beforeEach(() => { capturedLogs.length = 0 })
  afterEach(() => { teardown?.(); teardown = undefined })

  it("filters EINVAL on Windows system paths", () => {
    teardown = installGlobalErrorHandler({ logger: mockLogger })
    const err = Object.assign(new Error("EINVAL"), { code: "EINVAL", path: "D:\\pagefile.sys" })
    expect(() => process.emit("uncaughtException", err)).not.toThrow()
    expect(capturedLogs).toHaveLength(1)
    expect(capturedLogs[0]).toMatchObject({ level: "warn", msg: "watcher_scan_blocked" })
  })

  it("filters EINVAL on macOS temp paths", () => {
    teardown = installGlobalErrorHandler({ logger: mockLogger })
    const err = Object.assign(new Error("EINVAL"), { code: "EINVAL", path: "/var/folders/abc/T/xyz" })
    expect(() => process.emit("uncaughtException", err)).not.toThrow()
    expect(capturedLogs).toHaveLength(1)
  })

  it("re-throws unknown errors", () => {
    teardown = installGlobalErrorHandler({ logger: mockLogger })
    const err = new Error("something else")
    expect(() => process.emit("uncaughtException", err)).toThrow()
  })

  it("re-throws known codes on non-system paths", () => {
    teardown = installGlobalErrorHandler({ logger: mockLogger })
    const err = Object.assign(new Error("EINVAL"), { code: "EINVAL", path: "/tmp/user-controlled-file" })
    expect(() => process.emit("uncaughtException", err)).toThrow()
  })

  it("respects custom path patterns", () => {
    teardown = installGlobalErrorHandler({ logger: mockLogger, paths: [/^\/custom\/path\//] })
    const err = Object.assign(new Error("EINVAL"), { code: "EINVAL", path: "/custom/path/file" })
    expect(() => process.emit("uncaughtException", err)).not.toThrow()
  })

  it("teardown removes the handler", () => {
    const cleanup = installGlobalErrorHandler({ logger: mockLogger })
    cleanup()
    const err = Object.assign(new Error("EINVAL"), { code: "EINVAL", path: "D:\\pagefile.sys" })
    expect(() => process.emit("uncaughtException", err)).toThrow()
  })
})