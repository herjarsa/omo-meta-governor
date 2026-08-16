import { describe, expect, it, mock } from "bun:test"
import type { TuiNotifyTransport, TuiToastMessage } from "./tui-notify"
import { notifyTui } from "./tui-notify"

const toast: TuiToastMessage = { message: "hello", variant: "info" }

describe("notifyTui", () => {
  describe("#given client with callable showToast", () => {
    it("then showToast is called once with { body: { message, variant } }", async () => {
      const showToast = mock((input: { body?: TuiToastMessage }) => Promise.resolve(undefined))
      await notifyTui({ showToast }, undefined, toast)
      expect(showToast).toHaveBeenCalledTimes(1)
      expect(showToast).toHaveBeenCalledWith({ body: toast })
    })
  })

  describe("#given client without showToast but with serverUrl", () => {
    it("then fetchImpl posts the toast to /tui/show-toast", async () => {
      const fetchImpl = mock((url: RequestInfo | URL, init?: RequestInit) =>
        Promise.resolve(new Response("{}", { status: 200 })),
      )
      await notifyTui({}, new URL("http://localhost:1234"), toast, { fetchImpl })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      const [url, init] = fetchImpl.mock.calls[0]
      expect(url).toBe("http://localhost:1234/tui/show-toast")
      expect(init?.method).toBe("POST")
      expect(init?.headers).toEqual({ "content-type": "application/json" })
      expect(JSON.parse(String(init?.body))).toEqual({ message: "hello", variant: "info" })
    })
  })

  describe("#given neither client method nor serverUrl", () => {
    it("then neither showToast nor fetchImpl is called", async () => {
      const fetchImpl = mock((url: RequestInfo | URL, init?: RequestInit) =>
        Promise.resolve(new Response("{}", { status: 200 })),
      )
      await notifyTui({}, undefined, toast, { fetchImpl })
      expect(fetchImpl).not.toHaveBeenCalled()
    })
  })

  describe("#given showToast rejects", () => {
    it("then the promise settles and logImpl warns with tui_toast", async () => {
      const logImpl = mock((level: "info" | "warn" | "error", message: string) => {})
      const showToast = mock(() => Promise.reject(new Error("toast boom")))
      await notifyTui({ showToast }, undefined, toast, { logImpl })
      expect(logImpl).toHaveBeenCalledWith("warn", expect.stringContaining("tui_toast"))
    })
  })

  describe("#given showToast throws synchronously", () => {
    it("then it is swallowed and logged, not propagated", async () => {
      const logImpl = mock((level: "info" | "warn" | "error", message: string) => {})
      await notifyTui(
        { showToast: () => { throw new Error("sync boom") } },
        undefined,
        toast,
        { logImpl },
      )
      expect(logImpl).toHaveBeenCalledWith("warn", expect.stringContaining("tui_toast"))
    })
  })

  describe("#given fetchImpl rejects", () => {
    it("then the promise settles and logImpl warns with tui_toast", async () => {
      const logImpl = mock((level: "info" | "warn" | "error", message: string) => {})
      const fetchImpl = mock(() => Promise.reject(new Error("net down")))
      await notifyTui({}, new URL("http://localhost:1234"), toast, { fetchImpl, logImpl })
      expect(logImpl).toHaveBeenCalledWith("warn", expect.stringContaining("tui_toast"))
    })
  })
})