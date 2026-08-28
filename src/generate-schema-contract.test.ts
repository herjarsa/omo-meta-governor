import { describe, it, expect } from "bun:test"
import { generateSchema } from "./generate-schema"
import { walkInterfaceKeys } from "./__test-helpers__/interface-walker"

describe("generate-schema contract (inverse drift)", () => {
  it("includes every top-level key from MetaGovernorPluginConfig", () => {
    const schema = generateSchema()
    const interfaceKeys = walkInterfaceKeys("MetaGovernorPluginConfig")
    for (const key of interfaceKeys) {
      expect(schema.properties).toHaveProperty(key)
    }
  })

  it("includes every nested key from intervention block", () => {
    const schema = generateSchema()
    const interventionKeys = walkInterfaceKeys("MetaGovernorPluginConfig", "intervention")
    for (const key of interventionKeys) {
      expect(schema.properties?.intervention?.properties).toHaveProperty(key)
    }
  })

  it("includes every nested key from graphSync block", () => {
    const schema = generateSchema()
    const graphSyncKeys = walkInterfaceKeys("MetaGovernorPluginConfig", "graphSync")
    for (const key of graphSyncKeys) {
      expect(schema.properties?.graphSync?.properties).toHaveProperty(key)
    }
  })
})