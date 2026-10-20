/**
 * agentmemory-client.ts — the plugin's single memory backend (v0.58.0).
 *
 * AgentMemory is the ONLY long-term memory of the plugin. The plugin used to
 * keep a parallel SQLite lesson store with its own auto-capture; that created
 * two memories doing the same job (and two sources of truth). Now:
 *
 *   - READ:  POST /agentmemory/context  (related context for a task)
 *             POST /agentmemory/enrich   (context for files about to change)
 *             POST /agentmemory/smart-search (hybrid recall)
 *   - WRITE: POST /agentmemory/lessons  (validated lessons; duplicates
 *             auto-strengthen, confidence decays over time)
 *             POST /agentmemory/summarize (session summary at close)
 *
 * Design rules:
 * - Every call is timeout-bounded and NEVER throws: a down agentmemory
 *   degrades to "no context", never to a parallel memory store.
 * - `fetch` is injected so tests are hermetic (no network).
 * - Auth resolution mirrors the agentmemory-capture plugin: env first, then
 *   ~/.agentmemory/.env, then ~/.agentmemory/secret.
 *
 * NOTE: POST /agentmemory/remember returns HTTP 500 on agentmemory v0.9.30
 * ("Cannot read properties of undefined (reading 'isLatest')") — the lessons
 * endpoint is the supported write path, so we never call remember.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export type FetchFn = (
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  },
) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
}>

export interface AgentmemoryClientConfig {
  /** Base URL. Default: AGENTMEMORY_URL env or http://localhost:3111. */
  url?: string
  /** Bearer secret. Default: AGENTMEMORY_SECRET env, ~/.agentmemory/.env, ~/.agentmemory/secret. */
  secret?: string
  /** Per-call timeout in ms. Default 3000. */
  timeoutMs?: number
  /** Injected fetch (tests). Default globalThis.fetch. */
  fetch?: FetchFn
}

export interface AgentmemoryLesson {
  id: string
  content: string
  context?: string
  confidence: number
  tags: string[]
  project?: string
  /** v0.59.0: how many times this lesson was re-confirmed. */
  reinforcements?: number
  createdAt?: string
  lastReinforcedAt?: string
}

export interface AgentmemoryContextResult {
  context: string
  tokens: number
  blocks: number
}

export interface AgentmemorySearchResult {
  results: Array<Record<string, unknown>>
  lessons: Array<Record<string, unknown>>
  mode?: string
}

export interface AgentmemorySaveLessonInput {
  content: string
  context?: string
  confidence?: number
  project?: string
  tags?: string[]
}

// ─── Auth + URL resolution ─────────────────────────────────────────

function readAgentmemoryFile(name: string): string {
  try {
    return readFileSync(join(homedir(), ".agentmemory", name), "utf-8")
  } catch {
    return ""
  }
}

function usableSecret(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : ""
  if (!trimmed) return ""
  if (trimmed.startsWith("${") && trimmed.endsWith("}")) return ""
  return trimmed
}

function secretFromEnvFile(): string {
  for (const line of readAgentmemoryFile(".env").split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).replace(/^export\s+/, "").trim()
    if (key !== "AGENTMEMORY_SECRET") continue
    let value = trimmed.slice(eq + 1).trim()
    const quote = value[0]
    const close = quote === '"' || quote === "'" ? value.indexOf(quote, 1) : -1
    if (close > 0) value = value.slice(1, close)
    else if (value.includes(" #")) value = value.slice(0, value.indexOf(" #"))
    const found = usableSecret(value)
    if (found) return found
  }
  return ""
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase()
    return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host)
  } catch {
    return false
  }
}

/**
 * Resolve the secret: explicit > env > ~/.agentmemory/.env > ~/.agentmemory/secret.
 * The file fallback only applies to loopback URLs (never leak a local secret
 * to a remote host).
 */
export function resolveAgentmemorySecret(
  explicit: string | undefined,
  url: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = usableSecret(explicit)
  if (configured) return configured
  const fromEnv = usableSecret(env.AGENTMEMORY_SECRET)
  if (fromEnv) return fromEnv
  if (!isLoopback(url)) return ""
  return secretFromEnvFile() || usableSecret(readAgentmemoryFile("secret"))
}

/** Resolve the base URL: explicit > env > default loopback. */
export function resolveAgentmemoryUrl(
  explicit: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = (explicit ?? env.AGENTMEMORY_URL ?? "").trim()
  const url = configured.length > 0 ? configured : "http://localhost:3111"
  return url.replace(/\/+$/, "")
}

// ─── Client ────────────────────────────────────────────────────────

export class AgentmemoryClient {
  private readonly url: string
  private readonly secret: string
  private readonly timeoutMs: number
  private readonly fetchFn: FetchFn

  constructor(config: AgentmemoryClientConfig = {}) {
    this.url = resolveAgentmemoryUrl(config.url)
    this.secret = resolveAgentmemorySecret(config.secret, this.url)
    this.timeoutMs = config.timeoutMs ?? 3000
    this.fetchFn =
      config.fetch ?? ((input, init) => (globalThis.fetch as unknown as FetchFn)(input, init))
  }

  /** True when a secret is available (auth required by agentmemory). */
  get hasAuth(): boolean {
    return this.secret.length > 0
  }

  get baseUrl(): string {
    return this.url
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (this.secret) headers["Authorization"] = `Bearer ${this.secret}`
    return headers
  }

  /** POST to /agentmemory/<path>. Returns parsed JSON or null on any failure. */
  async post<T = unknown>(path: string, body: Record<string, unknown>): Promise<T | null> {
    return this.request<T>("POST", path, body)
  }

  /** GET /agentmemory/<path> with optional query string. */
  async get<T = unknown>(path: string, query?: Record<string, string | number | undefined>): Promise<T | null> {
    return this.request<T>("GET", path, undefined, query)
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
    query?: Record<string, string | number | undefined>,
  ): Promise<T | null> {
    let url = `${this.url}/agentmemory${path}`
    if (query) {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === "") continue
        params.set(key, String(value))
      }
      const qs = params.toString()
      if (qs) url += `?${qs}`
    }
    try {
      const res = await this.fetchFn(url, {
        method,
        headers: this.headers(),
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!res.ok) return null
      return (await res.json()) as T
    } catch {
      // Degrade silently: agentmemory down = no context, never a throw.
      return null
    }
  }

  // ─── Lifecycle ───────────────────────────────────────────────────

  async startSession(input: {
    sessionId: string
    project: string
    cwd: string
  }): Promise<boolean> {
    const res = await this.post<{ session?: unknown }>("/session/start", {
      sessionId: input.sessionId,
      project: input.project,
      cwd: input.cwd,
    })
    return res !== null
  }

  async endSession(sessionId: string): Promise<boolean> {
    const res = await this.post<{ ended?: boolean }>("/session/end", { sessionId })
    return res?.ended === true
  }

  // ─── Read ────────────────────────────────────────────────────────

  /** Related context for a task (session + optional files). */
  async context(input: {
    sessionId: string
    project?: string
    files?: string[]
  }): Promise<AgentmemoryContextResult> {
    const res = await this.post<{ context?: string; tokens?: number; blocks?: number }>(
      "/context",
      {
        sessionId: input.sessionId,
        ...(input.project ? { project: input.project } : {}),
        ...(input.files && input.files.length > 0 ? { files: input.files } : {}),
      },
    )
    return {
      context: typeof res?.context === "string" ? res.context : "",
      tokens: typeof res?.tokens === "number" ? res.tokens : 0,
      blocks: typeof res?.blocks === "number" ? res.blocks : 0,
    }
  }

  /** Context for the files the agent is about to change. */
  async enrich(input: {
    sessionId: string
    files: string[]
    toolName?: string
  }): Promise<string> {
    const res = await this.post<{ context?: string }>("/enrich", {
      sessionId: input.sessionId,
      files: input.files,
      ...(input.toolName ? { toolName: input.toolName } : {}),
    })
    return typeof res?.context === "string" ? res.context : ""
  }

  /** Hybrid semantic+keyword search. */
  async search(input: { query: string; limit?: number }): Promise<AgentmemorySearchResult> {
    const res = await this.post<{
      results?: Array<Record<string, unknown>>
      lessons?: Array<Record<string, unknown>>
      mode?: string
    }>("/smart-search", { query: input.query, limit: input.limit ?? 5 })
    return {
      results: Array.isArray(res?.results) ? res.results : [],
      lessons: Array.isArray(res?.lessons) ? res.lessons : [],
      mode: res?.mode,
    }
  }

  async listLessons(input: { project?: string; limit?: number }): Promise<AgentmemoryLesson[]> {
    const res = await this.get<{ lessons?: AgentmemoryLesson[] }>("/lessons", {
      project: input.project,
      limit: input.limit ?? 20,
    })
    return Array.isArray(res?.lessons) ? res.lessons : []
  }

  async profile(project: string): Promise<Record<string, unknown> | null> {
    return this.get<Record<string, unknown>>("/profile", { project })
  }

  async patterns(project: string): Promise<Record<string, unknown> | null> {
    return this.get<Record<string, unknown>>("/patterns", { project })
  }

  async insights(project: string): Promise<Array<Record<string, unknown>>> {
    const res = await this.get<{ insights?: Array<Record<string, unknown>> }>("/insights", { project })
    return Array.isArray(res?.insights) ? res.insights : []
  }

  async counts(): Promise<Record<string, number> | null> {
    const res = await this.get<{ counts?: Record<string, number> }>("/counts")
    return res?.counts ?? null
  }

  // ─── Write ───────────────────────────────────────────────────────

  /**
   * Save a lesson. Duplicates auto-strengthen (confidence += 0.03) instead of
   * creating a new row — agentmemory owns the dedupe, so the plugin must not
   * pre-dedupe by itself.
   */
  async saveLesson(input: AgentmemorySaveLessonInput): Promise<{
    saved: boolean
    action?: string
    id?: string
    confidence?: number
  }> {
    const res = await this.post<{
      success?: boolean
      action?: string
      lesson?: { id?: string; confidence?: number }
    }>("/lessons", {
      content: input.content,
      ...(input.context ? { context: input.context } : {}),
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      ...(input.project ? { project: input.project } : {}),
      ...(input.tags && input.tags.length > 0 ? { tags: input.tags.join(",") } : {}),
    })
    if (!res || res.success !== true) return { saved: false }
    return {
      saved: true,
      action: res.action,
      id: res.lesson?.id,
      confidence: res.lesson?.confidence,
    }
  }

  /**
   * Soft-delete a lesson (agentmemory v0.9.30: POST /lessons/delete).
   * Deleted lessons are excluded from recall and list.
   */
  async deleteLesson(lessonId: string): Promise<boolean> {
    if (!lessonId || lessonId.trim().length === 0) return false
    const res = await this.post<{ success?: boolean; lesson?: { deleted?: boolean } }>(
      "/lessons/delete",
      { lessonId },
    )
    return res?.success === true || res?.lesson?.deleted === true
  }

  /** Session summary at close. */
  async summarize(sessionId: string): Promise<boolean> {
    const res = await this.post<{ success?: boolean }>("/summarize", { sessionId })
    return res?.success === true
  }
}

/**
 * A client that never touches the network. Used in test environments
 * (Bun sets NODE_ENV=test) so hermetic suites do not depend on a running
 * agentmemory server, and as the degraded default when the user has no
 * agentmemory configured.
 */
export class NullAgentmemoryClient extends AgentmemoryClient {
  constructor() {
    super({
      url: "http://localhost:0",
      secret: "",
      fetch: async () => {
        throw new Error("agentmemory disabled")
      },
    })
  }
}

/** True when running under a test runner (Bun/Jest set NODE_ENV=test). */
export function isTestEnvironment(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === "test" || env.BUN_TEST === "1"
}

let _singleton: AgentmemoryClient | null = null

/** Process-wide client (created lazily). */
export function getAgentmemoryClient(): AgentmemoryClient {
  if (!_singleton) _singleton = new AgentmemoryClient()
  return _singleton
}

/** Reset the singleton (test-only). */
export function resetAgentmemoryClient(): void {
  _singleton = null
}
