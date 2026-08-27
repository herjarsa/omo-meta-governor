import { describe, expect, it, beforeEach } from "bun:test"
import { clearAll } from "./decision-store"

describe("P2-1 rawCliAnything precedence is options > file", () => {
  beforeEach(() => clearAll())

  it("then inline options disabling cliAnything must win over file enabled", async () => {
    const { readFile } = await import("node:fs/promises")
    const { join } = await import("node:path")
    const srcRaw = await readFile(join(import.meta.dir, "plugin.ts"), "utf-8")
    const src = srcRaw.replace(/\r\n/g, "\n")
    const cliBlock = src.slice(src.indexOf("rawCliAnything ="))
    const optsIdx = cliBlock.indexOf("options?.meta_governor")
    const fileIdx = cliBlock.indexOf("fileConfigSource.config")
    const orderIsCorrect = optsIdx >= 0 && fileIdx >= 0 && optsIdx < fileIdx
    expect(orderIsCorrect).toBe(true)
  })
})
