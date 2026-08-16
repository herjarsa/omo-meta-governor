export type TuiToastVariant = "info" | "success" | "warning" | "error"

export type TuiToastMessage = {
  title?: string
  message: string
  variant: TuiToastVariant
  duration?: number
}

export interface TuiNotifyTransport {
  fetchImpl?: typeof fetch
  logImpl?: (level: "info" | "warn" | "error", message: string) => void
}

type ShowToastClient = {
  showToast?: (input: { body?: TuiToastMessage }) => unknown
}

const noopLog: NonNullable<TuiNotifyTransport["logImpl"]> = () => {}

export async function notifyTui(
  client: unknown,
  serverUrl: URL | undefined,
  toast: TuiToastMessage,
  transport?: TuiNotifyTransport,
): Promise<void> {
  const log = transport?.logImpl ?? noopLog

  const showToast =
    typeof client === "object" && client !== null
      ? (client as ShowToastClient).showToast
      : undefined

  if (typeof showToast === "function") {
    try {
      const result = showToast({ body: toast })
      if (result instanceof Promise) {
        try {
          await result
        } catch (err) {
          log("warn", `tui_toast: showToast promise rejected: ${String(err)}`)
        }
      }
    } catch (err) {
      log("warn", `tui_toast: showToast threw: ${String(err)}`)
    }
    return
  }

  if (serverUrl) {
    const fetchImpl = transport?.fetchImpl ?? fetch
    try {
      await fetchImpl(new URL("/tui/show-toast", serverUrl).toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toast),
      })
    } catch (err) {
      log("warn", `tui_toast: POST /tui/show-toast failed: ${String(err)}`)
    }
  }
}