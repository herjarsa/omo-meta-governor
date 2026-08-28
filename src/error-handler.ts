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

export function installGlobalErrorHandler(opts: ErrorHandlerOptions = {}): () => void {
  const paths = opts.paths ?? DEFAULT_PATH_PATTERNS
  const errorCodes = opts.errorCodes ?? DEFAULT_ERROR_CODES
  const logger = opts.logger ?? console
  const previousHandler = process.listeners("uncaughtException").at(-1)
  const handler = (err: Error & { code?: string;
  path?: string }) => {
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
      return
    }
    if (previousHandler) {
      ;(previousHandler as (e: Error) => void)(err)
    } else {
      throw err
    }
  }
  process.on("uncaughtException", handler)
  return () => process.off("uncaughtException", handler)
}