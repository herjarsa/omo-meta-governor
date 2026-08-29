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

  // v0.38.3 (G8 audit regression): chokidar on Windows emits EBADF when
  // its polling sees a temp dir that's been cleaned up. Without this filter,
  // bun's test runner reports "Unhandled error between tests". The path
  // pattern must include Windows user temp dirs.
  it("filters EBADF on Windows user temp paths (chokidar post-cleanup)", () => {
    teardown = installGlobalErrorHandler({ logger: mockLogger })
    const err = Object.assign(new Error("EBADF"), {
      code: "EBADF",
      path: "C:\\Users\\herjarsa\\AppData\\Local\\Temp\\omo-v11-LiatLo",
    })
    expect(() => process.emit("uncaughtException", err)).not.toThrow()
    expect(capturedLogs).toHaveLength(1)
    expect(capturedLogs[0]).toMatchObject({ level: "warn", msg: "watcher_scan_blocked" })
    expect(capturedLogs[0].ctx).toMatchObject({ code: "EBADF" })
  })

  it("filters EPERM on Windows user temp paths", () => {
    teardown = installGlobalErrorHandler({ logger: mockLogger })
    const err = Object.assign(new Error("EPERM"), {
      code: "EPERM",
      path: "C:\\Users\\alice\\AppData\\Local\\Temp\\locked-file",
    })
    expect(() => process.emit("uncaughtException", err)).not.toThrow()
    expect(capturedLogs).toHaveLength(1)
  })

  it("does NOT filter EBADF on non-system paths", () => {
    teardown = installGlobalErrorHandler({ logger: mockLogger })
    // User-controlled file under a non-temp directory must NOT be swallowed.
    const err = Object.assign(new Error("EBADF"), {
      code: "EBADF",
      path: "D:\\projects\\myapp\\file.txt",
    })
    process.emit("uncaughtException", err)
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
    // v0.38.5 (CI fix): do NOT call teardown1() here. Tearing down the
    // module-level handler leaves chokidar/readdirp EINVAL errors on
    // D:\DumpStack.log.tmp unhandled — bun:test reports them as
    // "Unhandled error between tests" and exits code 1 even though
    // 0 tests failed. Idempotency is about the RETURN value, not
    // about cleanup; leave the handler installed.
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

  // ─── v0.38.3 (CI test-windows fix) ────────────────────────────────────
  // readdirp's _formatEntry is async (uses `await this._stat(...)`); when its
  // _onError throws because the stream has no 'error' listener, the throw
  // happens inside an async function and becomes an unhandledRejection —
  // NOT an uncaughtException. The v0.38.0 handler only caught
  // uncaughtException, so EINVAL on D:\DumpStack.log.tmp escaped to bun's
  // test runner as "Unhandled error between tests", failing CI run
  // #33243458484 (and the prior 3 runs at 33217903149, 33217532176,
  // 33217143150). These tests mirror the uncaughtException suite above
  // but emit via process.emit("unhandledRejection", ...).

  it("filters EINVAL on Windows system paths via unhandledRejection", () => {
    teardown = installGlobalErrorHandler({ logger: mockLogger })
    const err = Object.assign(new Error("EINVAL"), { code: "EINVAL", path: "D:\\DumpStack.log.tmp" })
    expect(() => process.emit("unhandledRejection", err)).not.toThrow()
    expect(capturedLogs).toHaveLength(1)
    expect(capturedLogs[0]).toMatchObject({ level: "warn", msg: "watcher_scan_blocked" })
    expect(capturedLogs[0].ctx).toMatchObject({ code: "EINVAL" })
  })

  it("filters EBADF on Windows user temp paths via unhandledRejection", () => {
    teardown = installGlobalErrorHandler({ logger: mockLogger })
    const err = Object.assign(new Error("EBADF"), {
      code: "EBADF",
      path: "C:\\Users\\herjarsa\\AppData\\Local\\Temp\\omo-v11-LiatLo",
    })
    expect(() => process.emit("unhandledRejection", err)).not.toThrow()
    expect(capturedLogs).toHaveLength(1)
    expect(capturedLogs[0]).toMatchObject({ level: "warn", msg: "watcher_scan_blocked" })
  })

  it("filters EPERM on Windows user temp paths via unhandledRejection", () => {
    teardown = installGlobalErrorHandler({ logger: mockLogger })
    const err = Object.assign(new Error("EPERM"), {
      code: "EPERM",
      path: "C:\\Users\\alice\\AppData\\Local\\Temp\\locked-file",
    })
    expect(() => process.emit("unhandledRejection", err)).not.toThrow()
    expect(capturedLogs).toHaveLength(1)
  })

  it("does NOT filter non-system paths via unhandledRejection", () => {
    teardown = installGlobalErrorHandler({ logger: mockLogger })
    const err = Object.assign(new Error("EINVAL"), { code: "EINVAL", path: "/tmp/user-controlled-file" })
    process.emit("unhandledRejection", err)
    expect(capturedLogs).toHaveLength(0)
  })

  it("does NOT filter string/number rejection reasons", () => {
    // readdirp emits Error objects, but a non-Error rejection must not crash
    // the filter. handler() checks "code" in reason; string/number don't
    // have that, so they fall through cleanly.
    teardown = installGlobalErrorHandler({ logger: mockLogger })
    expect(() => process.emit("unhandledRejection", "string rejection")).not.toThrow()
    expect(() => process.emit("unhandledRejection", 42)).not.toThrow()
    expect(() => process.emit("unhandledRejection", null)).not.toThrow()
    expect(() => process.emit("unhandledRejection", undefined)).not.toThrow()
    expect(capturedLogs).toHaveLength(0)
  })

  it("teardown removes the unhandledRejection handler", () => {
    const cleanup = installGlobalErrorHandler({ logger: mockLogger })
    cleanup()
    const beforeCount = capturedLogs.length
    const err = Object.assign(new Error("EINVAL"), { code: "EINVAL", path: "D:\\DumpStack.log.tmp" })
    process.emit("unhandledRejection", err)
    expect(capturedLogs.length).toBe(beforeCount)
  })

  it("combined teardown removes BOTH listeners", () => {
    const cleanup = installGlobalErrorHandler({ logger: mockLogger })
    cleanup()
    const beforeCount = capturedLogs.length
    const err = Object.assign(new Error("EINVAL"), { code: "EINVAL", path: "D:\\pagefile.sys" })
    // Neither uncaughtException nor unhandledRejection should fire our handler.
    process.emit("uncaughtException", err)
    process.emit("unhandledRejection", err)
    expect(capturedLogs.length).toBe(beforeCount)
  })
})