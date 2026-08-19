/**
 * Tests for cli-anything.ts (v0.28.0).
 * Strategy: pure CLI wrappers take a `runner` DI seam so we never spawn
 * real pip/npx in hermetic tests. Each test injects a fake runner that
 * returns a canned stdout for a specific command pattern.
 */
import { describe, expect, it } from "bun:test"
import {
  getInstalledCliHubVersion,
  fetchCliHubLatestVersion,
  installCliHub,
  upgradeCliHub,
  listClis,
  searchClis,
  infoCli,
  installCli,
  installCliHubMetaSkill,
  upgradeCliHubMetaSkill,
  isCliHubMetaSkillInstalled,
  compareSemver,
} from "./cli-anything"

// Helper: build a runner that responds to specific command patterns.
function makeRunner(map: Record<string, string>, errorOn?: string): (cmd: string) => string {
  return (cmd: string) => {
    if (errorOn && cmd.startsWith(errorOn)) {
      throw new Error(`unexpected command: ${cmd}`)
    }
    for (const [pattern, response] of Object.entries(map)) {
      if (cmd.startsWith(pattern)) return response
    }
    throw new Error(`unhandled command: ${cmd}`)
  }
}

describe("compareSemver", () => {
  it("returns 0 for identical versions", () => {
    expect(compareSemver("0.4.1", "0.4.1")).toBe(0)
  })
  it("returns -1 when a < b", () => {
    expect(compareSemver("0.4.1", "0.5.0")).toBe(-1)
    expect(compareSemver("1.0.0", "1.0.1")).toBe(-1)
  })
  it("returns 1 when a > b", () => {
    expect(compareSemver("0.5.0", "0.4.1")).toBe(1)
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1)
  })
  it("treats empty as older", () => {
    expect(compareSemver("", "0.4.1")).toBe(-1)
    expect(compareSemver("0.4.1", "")).toBe(1)
  })
})

describe("getInstalledCliHubVersion", () => {
  it("returns the parsed version when pip show succeeds", () => {
    const runner = makeRunner({
      "pip show cli-anything-hub":
        "Name: cli-anything-hub\nVersion: 0.4.1\nLocation: /usr/lib/python3.12/site-packages\n",
    })
    expect(getInstalledCliHubVersion(runner)).toBe("0.4.1")
  })

  it("falls back to pip3 when pip fails", () => {
    const runner = (cmd: string) => {
      if (cmd.startsWith("pip show")) throw new Error("pip not found")
      if (cmd.startsWith("pip3 show"))
        return "Name: cli-anything-hub\nVersion: 0.4.0\n"
      throw new Error(`unexpected: ${cmd}`)
    }
    expect(getInstalledCliHubVersion(runner)).toBe("0.4.0")
  })

  it("falls back to python -m pip when pip3 fails", () => {
    const runner = (cmd: string) => {
      if (cmd.startsWith("pip ")) throw new Error("no pip")
      if (cmd.startsWith("pip3 ")) throw new Error("no pip3")
      if (cmd.startsWith("python -m pip"))
        return "Name: cli-anything-hub\nVersion: 0.3.9\n"
      throw new Error(`unexpected: ${cmd}`)
    }
    expect(getInstalledCliHubVersion(runner)).toBe("0.3.9")
  })

  it("returns null when all probes fail (not installed)", () => {
    const runner = () => {
      throw new Error("not installed")
    }
    expect(getInstalledCliHubVersion(runner)).toBeNull()
  })
})

describe("fetchCliHubLatestVersion", () => {
  it("parses pip index versions output", () => {
    const runner = makeRunner({
      "pip index versions cli-anything-hub":
        "cli-anything-hub (0.4.1)\nAvailable versions: 0.4.1, 0.4.0, 0.3.9\n",
    })
    expect(fetchCliHubLatestVersion(runner)).toBe("0.4.1")
  })

  it("returns null on failure", () => {
    expect(fetchCliHubLatestVersion(() => { throw new Error("no pip") })).toBeNull()
  })
})

describe("installCliHub", () => {
  it("succeeds on the first attempt (uv tool install)", () => {
    const runner = makeRunner({
      "uv tool install": "Installed cli-anything-hub-0.4.1",
    })
    const result = installCliHub(runner)
    expect(result.ok).toBe(true)
    expect(result.code).toBe("cli-anything-install-succeeded")
  })

  it("falls back to pip install --user after uv tool install fails", () => {
    const runner = (cmd: string) => {
      if (cmd.startsWith("uv tool install")) throw new Error("no uv")
      if (cmd.startsWith("uv pip install")) throw new Error("no uv")
      if (cmd.startsWith("pip install --user")) return "Successfully installed"
      throw new Error(`unexpected: ${cmd}`)
    }
    const result = installCliHub(runner)
    expect(result.ok).toBe(true)
    expect(result.code).toBe("cli-anything-install-succeeded")
  })

  it("returns failure when every tier fails", () => {
    const runner = () => {
      throw new Error("no pip, no uv, no nothing")
    }
    const result = installCliHub(runner)
    expect(result.ok).toBe(false)
    expect(result.code).toBe("cli-anything-install-failed")
    expect(result.stderr).toContain("no pip, no uv")
  })
})

describe("upgradeCliHub", () => {
  it("succeeds with uv tool upgrade", () => {
    const runner = makeRunner({
      "uv tool upgrade": "Upgraded cli-anything-hub",
    })
    const result = upgradeCliHub(runner)
    expect(result.ok).toBe(true)
    expect(result.code).toBe("cli-anything-upgrade-succeeded")
  })
})

describe("listClis", () => {
  it("returns parsed JSON array of CLIs", () => {
    const json = JSON.stringify([
      { name: "gimp", display_name: "GIMP", version: "1.0.0", description: "raster", requires: null, homepage: null, install_cmd: null, entry_point: "cli-anything-gimp", category: "image", _source: "harness" },
    ])
    const runner = makeRunner({
      "cli-hub list --json": json,
    })
    const result = listClis({}, runner, 10_000, "cli-hub")
    expect(result.ok).toBe(true)
    expect(result.data?.[0].name).toBe("gimp")
    expect(result.data?.[0].category).toBe("image")
  })

  it("supports category and source filters", () => {
    const runner = (cmd: string) => {
      if (cmd.includes("--category image") && cmd.includes("--source harness"))
        return JSON.stringify([{ name: "gimp", category: "image" }])
      throw new Error(`unexpected: ${cmd}`)
    }
    const result = listClis({ category: "image", source: "harness" }, runner, 10_000, "cli-hub")
    expect(result.ok).toBe(true)
    expect(result.data?.[0].name).toBe("gimp")
  })
})

describe("searchClis", () => {
  it("returns matching CLIs", () => {
    const runner = makeRunner({
      'cli-hub search "cad" --json':
        JSON.stringify([
          { name: "freecad", display_name: "FreeCAD", version: "0.5.0", description: "CAD", requires: null, homepage: null, install_cmd: null, entry_point: "cli-anything-freecad", category: "3d", _source: "harness" },
        ]),
    })
    const result = searchClis("cad", runner, 10_000, "cli-hub")
    expect(result.ok).toBe(true)
    expect(result.data?.[0].name).toBe("freecad")
  })

  it("rejects empty queries", () => {
    const result = searchClis("", () => "", 10_000, "cli-hub")
    expect(result.ok).toBe(false)
    expect(result.code).toBe("cli-hub-search-failed")
  })
})

describe("infoCli", () => {
  it("returns the human-readable info block", () => {
    const runner = makeRunner({
      'cli-hub info "gimp"': "  GIMP\n  Raster image processing via gimp -i -b\n",
    })
    const result = infoCli("gimp", runner, 10_000, "cli-hub")
    expect(result.ok).toBe(true)
    expect(result.data).toContain("GIMP")
  })
})

describe("installCli", () => {
  it("returns success when cli-hub install exits 0", () => {
    const runner = makeRunner({
      'cli-hub install "gimp"': "Installed cli-anything-gimp",
    })
    const result = installCli("gimp", runner, 10_000, "cli-hub")
    expect(result.ok).toBe(true)
    expect(result.code).toBe("cli-hub-install-succeeded")
  })
})

describe("installCliHubMetaSkill", () => {
  it("invokes `npx skills add HKUDS/CLI-Anything --skill cli-hub-meta-skill -g -y`", () => {
    let captured = ""
    const runner = (cmd: string) => {
      captured = cmd
      return "skill installed"
    }
    const result = installCliHubMetaSkill("global", runner, 10_000, "npx skills")
    expect(result.ok).toBe(true)
    expect(captured).toContain("npx skills add HKUDS/CLI-Anything")
    expect(captured).toContain("--skill cli-hub-meta-skill")
    expect(captured).toContain("-g")
    expect(captured).toContain("-y")
  })

  it("uses -p for project scope", () => {
    let captured = ""
    const runner = (cmd: string) => {
      captured = cmd
      return "skill installed"
    }
    installCliHubMetaSkill("project", runner, 10_000, "npx skills")
    expect(captured).toContain("-p")
    expect(captured).not.toContain("-g ")
  })
})

describe("upgradeCliHubMetaSkill", () => {
  it("invokes `npx skills update cli-hub-meta-skill -g -y`", () => {
    let captured = ""
    const runner = (cmd: string) => {
      captured = cmd
      return "skill updated"
    }
    const result = upgradeCliHubMetaSkill("global", runner, 10_000, "npx skills")
    expect(result.ok).toBe(true)
    expect(captured).toContain("npx skills update cli-hub-meta-skill")
  })
})

describe("isCliHubMetaSkillInstalled", () => {
  it("returns true when the skill appears in `npx skills list`", () => {
    const runner = makeRunner({
      "npx skills list -g":
        "cli-hub-meta-skill  HKUDS/CLI-Anything  1.0.0  global\nsome-other-skill  x/y  0.1.0  global\n",
    })
    expect(isCliHubMetaSkillInstalled("global", runner, 10_000, "npx skills")).toBe(true)
  })

  it("returns false when the skill is missing", () => {
    const runner = makeRunner({
      "npx skills list -g": "some-other-skill  x/y  0.1.0  global\n",
    })
    expect(isCliHubMetaSkillInstalled("global", runner, 10_000, "npx skills")).toBe(false)
  })
})