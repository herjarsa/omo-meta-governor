// Local minimal Logger interface (v0.38.0: error-handler doesn't depend on src/logger.ts to avoid pulling in plugin logger implementation).
interface Logger {
  warn?: (msg: string, ctx?: unknown) => void
  error?: (msg: string, ctx?: unknown) => void
  info?: (msg: string, ctx?: unknown) => void
  debug?: (msg: string, ctx?: unknown) => void
}

export const DEFAULT_PATH_PATTERNS: RegExp[] = [
  /^[A-Z]:\\(pagefile\.sys|DumpStack\.log\.tmp)/i,           // Windows system
  /^\/(var|private\/var)\/folders\//,                        // macOS temp
  /^\/snap\//,                                               // Linux snap
]

export const DEFAULT_ERROR_CODES = new Set(["EINVAL", "ENOENT", "EACCES"])

export interface ErrorHandlerOptions {
  logger?: Logger
  paths?: RegExp[]
  errorCodes?: Set<string>
}

// v0.38.0 idempotency guard: only one default-options handler at a time.
// The plugin factory is called many times per test suite; without this guard
// we'd stack dozens of duplicate handlers. Custom opts always install fresh.
let defaultTeardown: (() => void) | null = null

export function installGlobalErrorHandler(opts: ErrorHandlerOptions = {}): () => void {
  // Idempotency for default opts (the common case from createMetaGovernorPlugin).
  const isDefault = Object.keys(opts).length === 0
  if (isDefault && defaultTeardown) return defaultTeardown

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
  if (isDefault) defaultTeardown = teardown
  return teardown
}