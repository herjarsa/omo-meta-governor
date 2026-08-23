/**
 * EmbedClient (v0.32.0 F2a) — OpenAI-compatible /v1/embeddings wrapper.
 *
 * DI seam: injected `fetch` (defaults to global fetch) so tests can pass a
 * mock without network. Cold-start: 30s per-attempt timeout + 1 retry on
 * 503 or timeout. Empty input short-circuits without network.
 */

export class EmbedTimeoutError extends Error {
  override name = "EmbedTimeoutError"
  constructor(message: string) {
    super(message)
  }
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

export interface EmbedClientOptions {
  baseUrl: string
  model: string
  fetch: FetchFn
  timeoutMs?: number
  retries?: number
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")
}

function timeoutPromise(ms: number): Promise<never> {
  return new Promise<never>((_, reject) => {
    setTimeout(() => reject(new EmbedTimeoutError(`Embed request timed out after ${ms}ms`)), ms)
  })
}

export class EmbedClient {
  private readonly baseUrl: string
  private readonly model: string
  private readonly fetchFn: FetchFn
  private readonly timeoutMs: number
  private readonly retries: number

  constructor(opts: EmbedClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "")
    this.model = opts.model
    this.fetchFn = opts.fetch
    this.timeoutMs = opts.timeoutMs ?? 30000
    this.retries = opts.retries ?? 1
  }

  async embed(input: string): Promise<number[][]> {
    if (input.trim().length === 0) return []
    return this.embedBatch([input])
  }

  async embedBatch(inputs: readonly string[]): Promise<number[][]> {
    const filtered = inputs.filter((s) => s.trim().length > 0)
    if (filtered.length === 0) return []

    const url = `${this.baseUrl}/embeddings`
    const body = JSON.stringify({ model: this.model, input: filtered })

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const result = await Promise.race([
          (async (): Promise<number[][]> => {
            const res = await this.fetchFn(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body,
              signal: AbortSignal.timeout(this.timeoutMs),
            })
            if (res.status === 503) {
              const err = new Error(`Embed 503 cold-start`) as Error & { retryable?: boolean }
              err.retryable = true
              throw err
            }
            if (!res.ok) {
              throw new Error(`Embed failed: ${res.status}`)
            }
            const json = (await Promise.race([res.json(), timeoutPromise(this.timeoutMs)])) as {
              data: Array<{ embedding: number[] }>
            }
            return json.data.map((d) => d.embedding)
          })(),
          timeoutPromise(this.timeoutMs),
        ])
        return result
      } catch (err) {
        const retryable503 =
          err instanceof Error && (err as Error & { retryable?: boolean }).retryable === true
        const isTimeout = err instanceof EmbedTimeoutError || isAbortError(err)
        const shouldRetry = (retryable503 || isTimeout) && attempt < this.retries
        if (shouldRetry) continue
        if (isTimeout && !(err instanceof EmbedTimeoutError)) {
          throw new EmbedTimeoutError(`Embed request timed out after ${this.timeoutMs}ms`)
        }
        throw err
      }
    }
    throw new EmbedTimeoutError(`Embed request timed out after ${this.timeoutMs}ms`)
  }
}
