import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { installGlobalErrorHandler } from "./error-handler"

// v0.38.0 NOTE: The handler does NOT manually throw or chain to previousHandler.
// It either swallows (filter match) or lets Node's emit loop continue to the next
// listener. Bun's test runner registers its own uncaughtException listener which
// catches the unhandled cases — that's why we no longer see throws.

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

  it("does NOT filter unknown errors (logger is not called)", () => {
    teardown = installGlobalErrorHandler({ logger: mockLogger })
    const err = new Error("something else")
    process.emit("uncaughtException", err)
    // Unknown errors fall through (Node's emit loop / bun's test handler).
    expect(capturedLogs).toHaveLength(0)
  })

  it("does NOT filter known codes on non-system paths", () => {
    teardown = installGlobalErrorHandler({ logger: mockLogger })
    const err = Object.assign(new Error("EINVAL"), { code: "EINVAL", path: "/tmp/user-controlled-file" })
    process.emit("uncaughtException", err)
    // Non-system paths fall through — we don't swallow user errors.
    expect(capturedLogs).toHaveLength(0)
  })

  it("respects custom path patterns", () => {
    teardown = installGlobalErrorHandler({ logger: mockLogger, paths: [/^\/custom\/path\//] })
    const err = Object.assign(new Error("EINVAL"), { code: "EINVAL", path: "/custom/path/file" })
    expect(() => process.emit("uncaughtException", err)).not.toThrow()
    expect(capturedLogs).toHaveLength(1)
    expect(capturedLogs[0]).toMatchObject({ level: "warn", msg: "watcher_scan_blocked" })
  })

  it("is idempotent — same default opts returns same teardown (no handler stacking)", () => {
    // Simulate plugin factory being called multiple times with no args.
    // All calls share the same default opts (the empty-object key), so
    // idempotency kicks in and we don't stack handlers.
    const teardown1 = installGlobalErrorHandler()
    const teardown2 = installGlobalErrorHandler()
    expect(teardown2).toBe(teardown1)
    teardown1()
  })

  it("teardown removes the handler", () => {
    const cleanup = installGlobalErrorHandler({ logger: mockLogger })
    cleanup()
    // After teardown, our filter handler should be gone.
    const beforeCount = capturedLogs.length
    const err = Object.assign(new Error("EINVAL"), { code: "EINVAL", path: "D:\\pagefile.sys" })
    process.emit("uncaughtException", err)
    expect(capturedLogs.length).toBe(beforeCount)
  })
})