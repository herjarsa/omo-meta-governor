/**
 * MetaGovernor config loader tests — PR 8 of 8.
 *
 * given/when/then style. Verifies that loadOrchestratorConfig correctly
 * projects the user-facing MetaGovernorPluginConfig into the runtime
 * OrchestratorConfig, applies defaults for missing fields, and respects
 * user overrides.
 */

import { describe, expect, it } from "bun:test"
import type { MetaGovernorPluginConfig } from "./config"
import {
  isMetaGovernorEnabled,
  loadOrchestratorConfig,
} from "./config"

describe("loadOrchestratorConfig", () => {
  describe("#given undefined config", () => {
    const result = loadOrchestratorConfig(undefined)

    it("then enabled is false", () => {
      expect(result.enabled).toBe(false)
    })

    it("then memory.query has the default", () => {
      expect(result.memory.query).toBe("meta_governor_context")
    })

    it("then memory.timeoutMs has the default 2000", () => {
      expect(result.memory.timeoutMs).toBe(2000)
    })

    it("then memory.enabled is true (internal always on)", () => {
      expect(result.memory.enabled).toBe(true)
    })

    it("then tokenPredictor has default thresholds", () => {
      expect(result.tokenPredictor.compactBurnRateThreshold).toBe(500)
      expect(result.tokenPredictor.compactUsageThreshold).toBe(0.85)
      expect(result.tokenPredictor.switchModelUsageThreshold).toBe(0.95)
      expect(result.tokenPredictor.delegateConsecutiveHighBurn).toBe(5)
    })

    it("then scoring has default thresholds", () => {
      expect(result.scoring.continueThreshold).toBe(0.3)
      expect(result.scoring.warnThreshold).toBe(0.3)
      // v0.17.2: thresholds lowered so signals can actually reach action bands
      expect(result.scoring.escalateThreshold).toBe(0.45)
      expect(result.scoring.stopThreshold).toBe(0.55)
    })

    it("then decision has default history limit (50)", () => {
      expect(result.decision.maxHistoryPerSession).toBe(50)
      expect(result.decision.forceContinueAfterStops).toBe(3)
    })

    it("then closedLoop has default enabled + saveDecisions", () => {
      expect(result.closedLoop.enabled).toBe(true)
      expect(result.closedLoop.saveDecisions).toBe(true)
      expect(result.closedLoop.minSeverityToLearn).toBe("media")
      expect(result.closedLoop.maxLessonsPerSession).toBe(20)
    })
  })

  describe("#given enabled config", () => {
    const config: MetaGovernorPluginConfig = { enabled: true }
    const result = loadOrchestratorConfig(config)

    it("then enabled is true", () => {
      expect(result.enabled).toBe(true)
    })
  })

  describe("#given custom memory config", () => {
    const config: MetaGovernorPluginConfig = {
      enabled: true,
      memory: {
        agentmemoryTimeoutMs: 5000,
        query: "custom_query",
      },
    }
    const result = loadOrchestratorConfig(config)

    it("then timeoutMs reflects override", () => {
      expect(result.memory.timeoutMs).toBe(5000)
    })

    it("then query reflects override", () => {
      expect(result.memory.query).toBe("custom_query")
    })
  })

  describe("#given custom scoring config", () => {
    const config: MetaGovernorPluginConfig = {
      enabled: true,
      scoring: {
        stopThreshold: 0.95,
        escalateThreshold: 0.85,
      },
    }
    const result = loadOrchestratorConfig(config)

    it("then stopThreshold reflects override", () => {
      expect(result.scoring.stopThreshold).toBe(0.95)
    })

    it("then escalateThreshold reflects override", () => {
      expect(result.scoring.escalateThreshold).toBe(0.85)
    })

    it("then continueThreshold is default", () => {
      expect(result.scoring.continueThreshold).toBe(0.3)
    })
  })

  describe("#given custom closedLoop config (saveDecisions=false)", () => {
    const config: MetaGovernorPluginConfig = {
      enabled: true,
      closedLoop: { saveDecisions: false },
    }
    const result = loadOrchestratorConfig(config)

    it("then saveDecisions is false", () => {
      expect(result.closedLoop.saveDecisions).toBe(false)
    })

    it("then enabled still defaults to true", () => {
      expect(result.closedLoop.enabled).toBe(true)
    })

    it("then minSeverityToLearn is the default 'media'", () => {
      expect(result.closedLoop.minSeverityToLearn).toBe("media")
    })
  })
})

describe("isMetaGovernorEnabled", () => {
  it("#given undefined config then returns false", () => {
    expect(isMetaGovernorEnabled(undefined)).toBe(false)
  })

  it("#given disabled config then returns false", () => {
    const config: MetaGovernorPluginConfig = { enabled: false }
    expect(isMetaGovernorEnabled(config)).toBe(false)
  })

  it("#given enabled config then returns true", () => {
    const config: MetaGovernorPluginConfig = { enabled: true }
    expect(isMetaGovernorEnabled(config)).toBe(true)
  })
})

describe("loadOrchestratorConfig — intervention", () => {
  describe("#given undefined intervention config", () => {
    const config: MetaGovernorPluginConfig = { enabled: true }
    const result = loadOrchestratorConfig(config)

    it("then intervention.mode defaults to silent", () => {
      expect(result.intervention.mode).toBe("silent")
    })

    it("then intervention.includeDecisionHistory defaults to true", () => {
      expect(result.intervention.includeDecisionHistory).toBe(true)
    })

    it("then intervention.maxHistoryMessages defaults to 5", () => {
      expect(result.intervention.maxHistoryMessages).toBe(5)
    })

    it("then intervention.minActionForMessage defaults to 'stop' (v0.10.0)", () => {
      expect(result.intervention.minActionForMessage).toBe("stop")
    })
    })
  })

  describe("#given custom intervention config", () => {
    const config: MetaGovernorPluginConfig = {
      enabled: true,
      intervention: {
        mode: "message",
        includeDecisionHistory: false,
        maxHistoryMessages: 10,
        minActionForMessage: "stop",
      },
    }
    const result = loadOrchestratorConfig(config)

    it("then intervention.mode reflects override", () => {
      expect(result.intervention.mode).toBe("message")
    })

    it("then intervention.includeDecisionHistory reflects override", () => {
      expect(result.intervention.includeDecisionHistory).toBe(false)
    })

    it("then intervention.maxHistoryMessages reflects override", () => {
      expect(result.intervention.maxHistoryMessages).toBe(10)
    })

    it("then intervention.minActionForMessage reflects override", () => {
      expect(result.intervention.minActionForMessage).toBe("stop")
    })
  })

  describe("#given partial intervention config", () => {
    const config: MetaGovernorPluginConfig = {
      enabled: true,
      intervention: { mode: "system" },
    }
    const result = loadOrchestratorConfig(config)

    it("then intervention.mode reflects override", () => {
      expect(result.intervention.mode).toBe("system")
    })

    it("then intervention.includeDecisionHistory defaults to true", () => {
      expect(result.intervention.includeDecisionHistory).toBe(true)
    })

    it("then intervention.maxHistoryMessages defaults to 5", () => {
      expect(result.intervention.maxHistoryMessages).toBe(5)
    })

    it("then intervention.minActionForMessage defaults to 'stop' (v0.10.0)", () => {
      expect(result.intervention.minActionForMessage).toBe("stop")
    })
})

describe("loadOrchestratorConfig — protocolEnforcement", () => {
  describe("#given undefined protocolEnforcement config", () => {
    const config: MetaGovernorPluginConfig = { enabled: true }
    const result = loadOrchestratorConfig(config)

    it("then protocolEnforcement.enabled defaults to false", () => {
      expect(result.protocolEnforcement.enabled).toBe(false)
    })

    it("then protocolEnforcement.injectIntoSystem defaults to false", () => {
      expect(result.protocolEnforcement.injectIntoSystem).toBe(false)
    })

    it("then protocolEnforcement.auditToolCalls defaults to false", () => {
      expect(result.protocolEnforcement.auditToolCalls).toBe(false)
    })

    it("then protocolEnforcement.path is undefined", () => {
      expect(result.protocolEnforcement.path).toBeUndefined()
    })
  })

  describe("#given custom protocolEnforcement config", () => {
    const config: MetaGovernorPluginConfig = {
      enabled: true,
      protocolEnforcement: {
        enabled: true,
        path: "/custom/path.md",
        injectIntoSystem: true,
        auditToolCalls: true,
      },
    }
    const result = loadOrchestratorConfig(config)

    it("then protocolEnforcement.enabled reflects override", () => {
      expect(result.protocolEnforcement.enabled).toBe(true)
    })

    it("then protocolEnforcement.path reflects override", () => {
      expect(result.protocolEnforcement.path).toBe("/custom/path.md")
    })

    it("then protocolEnforcement.injectIntoSystem reflects override", () => {
      expect(result.protocolEnforcement.injectIntoSystem).toBe(true)
    })

    it("then protocolEnforcement.auditToolCalls reflects override", () => {
      expect(result.protocolEnforcement.auditToolCalls).toBe(true)
    })
  })

  describe("#given partial protocolEnforcement config", () => {
    const config: MetaGovernorPluginConfig = {
      enabled: true,
      protocolEnforcement: { injectIntoSystem: true },
    }
    const result = loadOrchestratorConfig(config)

    it("then protocolEnforcement.enabled defaults to false", () => {
      expect(result.protocolEnforcement.enabled).toBe(false)
    })

    it("then injectIntoSystem reflects override", () => {
      expect(result.protocolEnforcement.injectIntoSystem).toBe(true)
    })

    it("then auditToolCalls defaults to false", () => {
      expect(result.protocolEnforcement.auditToolCalls).toBe(false)
    })

    it("then path is undefined", () => {
      expect(result.protocolEnforcement.path).toBeUndefined()
    })
  })
})

describe("loadOrchestratorConfig — graphRetrieval", () => {
  describe("#given undefined graphRetrieval config", () => {
    const config: MetaGovernorPluginConfig = { enabled: true }
    const result = loadOrchestratorConfig(config)

    it("then graphRetrieval.preferredTool defaults to 'auto'", () => {
      expect(result.graphRetrieval.preferredTool).toBe("auto")
    })
  })

  describe("#given custom graphRetrieval config", () => {
    const config: MetaGovernorPluginConfig = {
      enabled: true,
      graphRetrieval: { preferredTool: "graphify" },
    }
    const result = loadOrchestratorConfig(config)

    it("then graphRetrieval.preferredTool reflects override", () => {
      expect(result.graphRetrieval.preferredTool).toBe("graphify")
    })
  })
})

describe("loadOrchestratorConfig — skillPriming (v0.33.1 defaults)", () => {
  describe("#given undefined skillPriming config", () => {
    const config: MetaGovernorPluginConfig = { enabled: true }
    const result = loadOrchestratorConfig(config)

    it("then skillPriming.enabled defaults to true (v0.33.1)", () => {
      expect(result.skillPriming.enabled).toBe(true)
    })

    it("then skillPriming.trigger defaults to 'firstImplement'", () => {
      expect(result.skillPriming.trigger).toBe("firstImplement")
    })

    it("then skillPriming.router defaults to 'registry' (v0.33.1; AAS retired)", () => {
      expect(result.skillPriming.router).toBe("registry")
    })
  })

  describe("#given custom skillPriming config", () => {
    const config: MetaGovernorPluginConfig = {
      enabled: true,
      skillPriming: { enabled: true, trigger: "sessionStart", router: "aas" },
    }
    const result = loadOrchestratorConfig(config)

    it("then all three overrides are reflected", () => {
      expect(result.skillPriming.enabled).toBe(true)
      expect(result.skillPriming.trigger).toBe("sessionStart")
      expect(result.skillPriming.router).toBe("aas")
    })
  })

  describe("#given partial skillPriming config", () => {
    const config: MetaGovernorPluginConfig = {
      enabled: true,
      skillPriming: { enabled: true },
    }
    const result = loadOrchestratorConfig(config)

    it("then trigger and router keep defaults (firstImplement / registry)", () => {
      expect(result.skillPriming.enabled).toBe(true)
      expect(result.skillPriming.trigger).toBe("firstImplement")
      expect(result.skillPriming.router).toBe("registry")
    })
  })
})

describe("loadOrchestratorConfig — graphSync (v0.25.1 reindexOnFetch)", () => {
describe("#given undefined graphSync reindexOnFetch", () => {
const config: MetaGovernorPluginConfig = { enabled: true }
const result = loadOrchestratorConfig(config)

it("then graphSync.reindexOnFetch defaults to true", () => {
expect(result.graphSync.reindexOnFetch).toBe(true)
})

it("then graphSync.fetchBranch defaults to 'main'", () => {
expect(result.graphSync.fetchBranch).toBe("main")
})
})
})

describe("loadOrchestratorConfig #given skillHub (v0.32.0)", () => {
  it("then absent skillHub projects full defaults", () => {
    const result = loadOrchestratorConfig(undefined)
    expect(result.skillHub.enabled).toBe(false)
    expect(result.skillHub.syncIntervalMs).toBe(86400000)
    expect(result.skillHub.embedBaseUrl).toBe("http://127.0.0.1:3114/v1")
    expect(result.skillHub.embedModel).toBe("bge-m3")
    expect(result.skillHub.minInstalls).toBe(0)
    expect(result.skillHub.filterDuplicates).toBe(true)
    expect(result.skillHub.depsCheck).toBe(true)
  })

  it("then partial override merges over defaults", () => {
    const result = loadOrchestratorConfig({
      skillHub: { enabled: true, minInstalls: 50 },
    } as MetaGovernorPluginConfig)
    expect(result.skillHub.enabled).toBe(true)
    expect(result.skillHub.minInstalls).toBe(50)
    expect(result.skillHub.syncIntervalMs).toBe(86400000)
    expect(result.skillHub.embedModel).toBe("bge-m3")
  })
})
