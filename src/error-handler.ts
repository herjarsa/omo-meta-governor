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
  // Implementation in Task 3
  return () => {}
}