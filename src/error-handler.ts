// Local minimal Logger interface (v0.38.0: error-handler doesn't depend on src/logger.ts to avoid pulling in plugin logger implementation).
interface Logger {
  warn?: (msg: string, ctx?: unknown) => void
  error?: (msg: string, ctx?: unknown) => void
  info?: (msg: string, ctx?: unknown) => void
  debug?: (msg: string, ctx?: unknown) => void
}

export const DEFAULT_PATH_PATTERNS: RegExp[] = [
  /^[A-Z]:[\\/](pagefile\.sys|DumpStack\.log\.tmp)/i,        // Windows system
  // v0.38.3 (G8): chokidar normalizes paths to forward slashes on all platforms,
  // so the regex must accept both `C:\Users\...\Temp\` (Node fs) and
  // `C:/Users/.../Temp/` (chokidar). Tests create temp dirs with prefix `omo-`.
  /^[A-Z]:[\\/](Users|home)[\\/][^\\/]+[\\/]AppData[\\/]Local[\\/]Temp[\\/]/i, // Windows user temp
  /^\/(var|private\/var)\/folders\//,                        // macOS temp
  /^\/snap\//,                                               // Linux snap
]

export const DEFAULT_ERROR_CODES = new Set([
  "EINVAL",
  "ENOENT",
  "EACCES",
  "EBADF",  // v0.38.3 (G8 audit fix): chokidar emits EBADF on Windows when
             // polling a temp dir that was cleaned up mid-scan. Without this,
             // bun's test runner reports it as "Unhandled error between tests".
  "EPERM",  // v0.38.3 (G8): same root cause as EBADF; chokidar on locked files.
])

export interface ErrorHandlerOptions {
  logger?: Logger
  paths?: RegExp[]
  errorCodes?: Set<string>
}

// v0.38.5 (CI fix): idempotency guard that RE-INSTALLS the handler if the
// previous one was torn down. The previous implementation (v0.38.0–v0.38.4)
// cached the teardown function and returned it forever — so once any test
// called cleanup(), the module-level handler stayed dead for the rest of
// the process. chokidar/readdirp EINVAL on D:\DumpStack.log.tmp then
// escaped to bun:test's "Unhandled error between tests" and CI failed with
// exit code 1 even though 0 tests failed.
//
// The new guard checks process.listenerCount — if a default-opts handler is
// still registered, return the cached teardown; otherwise install fresh.
// Custom opts always install fresh (no caching).
let defaultTeardown: (() => void) | null = null

export function installGlobalErrorHandler(opts: ErrorHandlerOptions = {}): () => void {
  // Idempotency for default opts (the common case from createMetaGovernorPlugin).
  const isDefault = Object.keys(opts).length === 0
  if (isDefault && defaultTeardown && process.listenerCount("uncaughtException") > 0) {
    return defaultTeardown
  }

  const paths = opts.paths ?? DEFAULT_PATH_PATTERNS
  const errorCodes = opts.errorCodes ?? DEFAULT_ERROR_CODES
  const logger = opts.logger ?? console
  const handler = (err: Error & { code?: string; path?: string }) => {
    const isWatcherError =
      err && typeof err === "object" && "code" in err && err.code
        ? errorCodes.has(err.code)
        : false
    const isSystemPath = !!(err?.path && paths.some((p) => p.test(err.path!)))
    if (isWatcherError && isSystemPath) {
      logger.warn?.("watcher_scan_blocked", {
        path: err.path,
        code: err.code,
        message: err.message,
      })
      return // swallow — Node's emit loop continues with other listeners
    }
    // Unfiltered: do nothing. Node's emit loop will invoke other listeners
    // or rethrow if this is the only one. We do NOT manually chain to a
    // previous handler (that caused double-invocation in CRITICAL-1).
  }
  process.on("uncaughtException", handler)
  const teardown = () => process.off("uncaughtException", handler)
  // v0.38.3: register the SAME filter for unhandledRejection. readdirp's
  // _formatEntry is async (uses `await this._stat(...)`); when its _onError
  // throws because the stream has no 'error' listener, the throw happens
  // inside an async function and becomes an unhandledRejection — NOT an
  // uncaughtException. The previous v0.38.0 handler only caught
  // uncaughtException, so EINVAL on D:\DumpStack.log.tmp escaped to
  // bun's test runner as "Unhandled error between tests", failing CI.
  //
  // The rejection handler unwraps the Error from the rejection reason
  // (typically the Error object itself, but sometimes a string/number)
  // and applies the same filter. Same logger output ("watcher_scan_blocked")
  // so the rejection and exception paths are indistinguishable to operators.
  const onRejection = (reason: unknown) => {
    if (reason && typeof reason === "object" && "code" in reason) {
      handler(reason as Error & { code?: string; path?: string })
    }
  }
  process.on("unhandledRejection", onRejection)
  const rejectionTeardown = () => process.off("unhandledRejection", onRejection)
  const combinedTeardown = () => {
    teardown()
    rejectionTeardown()
    // Note: do NOT null defaultTeardown here. The idempotency guard at the
    // top of the function checks process.listenerCount to decide whether
    // the previous handler is still registered — so the cached reference
    // is harmless even after the listeners are removed. If a test calls
    // cleanup() and then installGlobalErrorHandler() is called again (e.g.
    // by module-load on the next test file), the guard sees listenerCount
    // dropped below the threshold and installs a fresh handler.
  }
  if (isDefault) defaultTeardown = combinedTeardown
  return combinedTeardown
}
