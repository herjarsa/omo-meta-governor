/**
 * routing-matrix.test.ts - canon routing matrix tests.
 *
 * Why these tests: the matrix is the single source for 5 duplicated
 * sites. Each test pins one contract from the task so drift is caught
 * immediately - recommendedTools mapping, priming body, digest verbatim,
 * bullet vs numbered lines, and existing-test patterns still present.
 */
import { describe, expect, it } from "bun:test"
import {
  ROUTING_MATRIX,
  recommendedTools,
  formatGraphPrimingBody,
  formatRoutingMatrixLines,
  formatDigestRouting,
  formatGraphRoutingBulletsES
} from "./routing-matrix"
import { buildGraphPrimingMessage } from "./skill-priming"
import { buildSkillPrimingRule } from "./enforcement-resources"
import { buildSystemInjection } from "./protocol-enforcer"

describe("recommendedTools", () => {
  it("arquitectura -> omo_search", () => {
    const hits = recommendedTools("arquitectura del sistema")
    expect(hits.some((e) => e.tools.includes("omo_search"))).toBe(true)
  })
  it("simbolo -> omo_find", () => {
    const hits = recommendedTools("definicion del simbolo foo")
    expect(hits.some((e) => e.tools.includes("omo_find"))).toBe(true)
  })
  it("impacto -> omo_impact", () => {
    const hits = recommendedTools("impacto antes de modificar")
    expect(hits.some((e) => e.tools.includes("omo_impact"))).toBe(true)
  })
  it("lecciones -> omo_recall", () => {
    const hits = recommendedTools("lecciones y decisiones previas")
    expect(hits.some((e) => e.tools.includes("omo_recall"))).toBe(true)
  })
  it("literal -> grep", () => {
    const hits = recommendedTools("literal byte patterns fallback")
    expect(hits.some((e) => e.tools.includes("grep"))).toBe(true)
  })
  it("desconocida -> []", () => {
    const hits = recommendedTools("zxqv wjkl qwerty unknown")
    expect(hits.length).toBe(0)
  })
})
describe("formatGraphPrimingBody", () => {
  it("contiene los 6 tool names + header + stores", () => {
    const body = formatGraphPrimingBody()
    expect(body).toContain("[GRAPH PRIMING]")
    expect(body).toContain("omo_search")
    expect(body).toContain("omo_find")
    expect(body).toContain("omo_impact")
    expect(body).toContain("omo_path")
    expect(body).toContain("omo_recall")
    expect(body).toContain("omo_health")
    expect(body).toContain("graphify")
    expect(body).toContain("codegraph")
  })
  it("site lo usa igual (skill-priming)", () => {
    const msg = buildGraphPrimingMessage()
    const body = formatGraphPrimingBody()
    expect(msg).toContain(body)
    expect(msg).toContain("[GRAPH PRIMING]")
  })
})
describe("formatDigestRouting", () => {
  it("igual al string historico", () => {
    const expected = "GRAPH ROUTING (codegraph/graphify ready):\nSymbols/definitions/callers/impact => CODEGRAPH (omo_find, omo_impact, omo_search).\nConcepts/architecture/connections => GRAPHIFY (omo_path, omo_explain).\nRepo overview => graphify-out/GRAPH_REPORT.md."
    expect(formatDigestRouting()).toBe(expected)
  })
})
describe("formatRoutingMatrixLines", () => {
  it("bullet vs numerado", () => {
    const bullet = formatRoutingMatrixLines({ bullet: true })
    const numbered = formatRoutingMatrixLines()
    const numberedExplicit = formatRoutingMatrixLines({ bullet: false })
    expect(bullet.split("\n").length).toBe(10)
    expect(numbered.split("\n").length).toBe(10)
    expect(bullet.split("\n")[0]?.startsWith("- ")).toBe(true)
    expect(numbered.split("\n")[0]?.startsWith("1. ")).toBe(true)
    expect(numbered).toBe(numberedExplicit)
    expect(bullet).toContain("omo_search")
    expect(numbered).toContain("omo_search")
  })
})
describe("formatGraphRoutingBulletsES", () => {
  it("3 lineas ASCII con ambos backends", () => {
    const es = formatGraphRoutingBulletsES()
    const lines = es.split("\n")
    expect(lines.length).toBe(3)
    expect(es).toContain("CODEGRAPH")
    expect(es).toContain("GRAPHIFY")
    expect(es).toContain("omo_path")
    expect(es).toContain("omo_explain")
    expect(es).toContain("omo_search")
    expect(es).toContain("GRAPH_REPORT.md")
    expect(es).toContain("->")
  })
})
describe("patrones de tests existentes siguen presentes", () => {
  it("skill-priming-graph patterns", () => {
    const msg = buildGraphPrimingMessage()
    expect(msg).toContain("omo_search")
    expect(msg).toContain("omo_find")
    expect(msg).toContain("omo_impact")
    expect(msg).toContain("omo_path")
    expect(msg).toContain("omo_recall")
    expect(msg).toContain("omo_health")
    expect(msg).toContain("[GRAPH PRIMING]")
    expect(msg).toContain("graphify")
    expect(msg).toContain("codegraph")
  })
  it("enforcement-resources omo_skill_find", () => {
    const text = buildSkillPrimingRule()
    expect(text).toContain("omo_skill_find")
    expect(text).toContain("codegraph")
    expect(text).toContain("graphify")
  })
  it("protocol-enforcer Tool Routing Table", () => {
    const out = buildSystemInjection("# Protocol\n\n## Oracle\n\nInvoke oracle when needed.")
    expect(out).toContain("Tool Routing Table")
  })
  it("matrix tiene decision order", () => {
    expect(ROUTING_MATRIX.length).toBeGreaterThanOrEqual(10)
    expect(ROUTING_MATRIX[0]?.tools).toContain("omo_search")
  })
})
