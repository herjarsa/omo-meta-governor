/**
 * EmbedClient tests (v0.32.0 F2a).
 *
 * Validates the OpenAI-compatible /v1/embeddings client with injected fetch
 * (DI seam — no network in CI). Covers happy path, retry-on-503, cold-start
 * timeout+retry failure, and empty-batch edge case.
 */

import { describe, expect, it, mock } from "bun:test"
import { EmbedClient, EmbedTimeoutError } from "./embed-client"

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

function jsonResp(embedding: number[]): Response {
  return new Response(JSON.stringify({ data: [{ embedding }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

/** Response whose body never settles — simulates a hung cold-start. */
class HangingResponse extends Response {
  constructor() {
    super(new Uint8Array(), { status: 200 })
  }
  override text(): Promise<string> {
    return new Promise<string>(() => {})
  }
  override json(): Promise<unknown> {
    return new Promise<unknown>(() => {})
  }
}

describe("EmbedClient #RED F2a", () => {
  describe("#embed", () => {
    it("then returns normalized vectors on 200", async () => {
      const fetch = mock<(input: string, init?: RequestInit) => Promise<Response>>()
      fetch.mockResolvedValue(jsonResp([0.1, 0.2, 0.3]))
      const ec = new EmbedClient({ baseUrl: "http://127.0.0.1:3114/v1", model: "bge-m3", fetch, timeoutMs: 1000 })
      const v = await ec.embed("hello world")
      expect(v).toEqual([[0.1, 0.2, 0.3]])
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    it("then empty input returns [] without calling fetch", async () => {
      const fetch = mock<(input: string, init?: RequestInit) => Promise<Response>>()
      fetch.mockResolvedValue(jsonResp([]))
      const ec = new EmbedClient({ baseUrl: "http://127.0.0.1:3114/v1", model: "bge-m3", fetch, timeoutMs: 1000 })
      expect(await ec.embed("")).toEqual([])
      expect(fetch).toHaveBeenCalledTimes(0)
    })
  })

  describe("#cold-start retry on 503", () => {
    it("then retries once and succeeds", async () => {
      const fetch = mock<(input: string, init?: RequestInit) => Promise<Response>>()
      fetch.mockResolvedValueOnce(new Response(null, { status: 503 }))
      fetch.mockResolvedValueOnce(jsonResp([0.5, 0.5]))
      const ec = new EmbedClient({ baseUrl: "http://127.0.0.1:3114/v1", model: "bge-m3", fetch, timeoutMs: 1000, retries: 1 })
      const v = await ec.embed("retry me")
      expect(v).toEqual([[0.5, 0.5]])
      expect(fetch).toHaveBeenCalledTimes(2)
    })
  })

  describe("#cold-start timeout", () => {
    it("then throws EmbedTimeoutError after retries exhausted", async () => {
      const fetch = mock<(input: string, init?: RequestInit) => Promise<Response>>()
      fetch.mockResolvedValue(new HangingResponse())
      const ec = new EmbedClient({ baseUrl: "http://127.0.0.1:3114/v1", model: "bge-m3", fetch, timeoutMs: 50, retries: 1 })
      await expect(ec.embed("hangs forever")).rejects.toThrow(EmbedTimeoutError)
      // 1 initial + 1 retry = 2 attempts
      expect(fetch).toHaveBeenCalledTimes(2)
    })
  })
})
