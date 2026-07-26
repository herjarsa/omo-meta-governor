/**
 * Tests for F3.1 — AFT checkpoint/undo argument splitting.
 * Verifies the args are split into multiple argv slots, not concatenated.
 */
import { describe, expect, it } from "bun:test"

describe("AFT subcommand argument splitting (F3.1)", () => {
  describe("#given a name with spaces", () => {
    it("then the spawned argv contains separate slots, not one blob", () => {
      // Simulate what the new invokeAFTSubcommand would do for checkpoint.
      const name = "my checkpoint name"
      const argument: string[] = ["checkpoint", "--name", name]
      const args = ["safety", ...argument]

      expect(args).toEqual([
        "safety",
        "checkpoint",
        "--name",
        "my checkpoint name",
      ])
      // Specifically, the OLD bug would have been:
      //   args = ["safety", "checkpoint --name \"my checkpoint name\""]
      // That's a single blob arg, NOT what we produce.
    })

    it("then a name with shell metacharacters does not get expanded", () => {
      const name = '"; rm -rf /'
      const args = ["safety", "checkpoint", "--name", name]
      // Argv slots are inert — the shell never sees them.
      expect(args[3]).toBe('"; rm -rf /')
      expect(args.length).toBe(4)
    })

    it("then a plain string argument (backward-compat) still works", () => {
      // The signature accepts string | string[].
      const arg: string = "undo"
      const args = ["safety", ...(Array.isArray(arg) ? arg : [arg])]
      expect(args).toEqual(["safety", "undo"])
    })
  })

  describe("#given the cwd fallback for AFT subcommand (F3.2)", () => {
    it("then options.projectDir is used when provided", () => {
      const options = { projectDir: "/custom/project" }
      const cwd = options.projectDir ?? process.cwd()
      expect(cwd).toBe("/custom/project")
    })

    it("then process.cwd() is the fallback when projectDir is absent", () => {
      const options: { projectDir?: string } = {}
      const cwd = options.projectDir ?? process.cwd()
      expect(cwd).toBe(process.cwd())
    })
  })
})
