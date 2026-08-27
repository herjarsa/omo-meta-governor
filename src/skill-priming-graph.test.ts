/**
 * skill-priming-graph.test.ts - unit test for buildGraphPrimingMessage.
 */
import { describe, expect, it } from "bun:test"
import { buildGraphPrimingMessage } from "../src/skill-priming"

describe("buildGraphPrimingMessage", () => {
  it("then lists the four core discovery primitives by name", () => {
    const msg = buildGraphPrimingMessage()
    expect(msg).toContain("omo_search")
    expect(msg).toContain("omo_find")
    expect(msg).toContain("omo_impact")
    expect(msg).toContain("omo_path")
    expect(msg).toContain("omo_recall")
    expect(msg).toContain("omo_health")
  })

  it("then starts with a [GRAPH PRIMING] header so it survives grep filters", () => {
    const msg = buildGraphPrimingMessage()
    expect(msg).toContain("[GRAPH PRIMING]")
  })

  it("then names graphify and codegraph as the underlying stores", () => {
    const msg = buildGraphPrimingMessage()
    expect(msg).toContain("graphify")
    expect(msg).toContain("codegraph")
  })
})