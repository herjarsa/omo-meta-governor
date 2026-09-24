/**
 * v2-tools.ts — V2 (@opencode/plugin@2.0.16 promise flavour) registration of
 * the omo_* custom tools.
 *
 * Standalone-importable: this module does NOT depend on src/plugin.ts. It
 * reuses the V1 builders from ./custom-tools (same builders the V1 factory
 * instantiates) and adapts each built tool to the V2 editor shape:
 *   editor.add({ name, description, input: JSONSchema, execute })
 *
 * Conversion notes:
 * - zod v4 schemas -> JSON Schema via the top-level `z.toJSONSchema()` helper
 *   (same zod instance as the builders, reached through `tool.schema`). The
 *   `$schema` key is stripped; the rest is passed through verbatim.
 * - If `toJSONSchema` is unavailable or throws for a given tool, a minimal
 *   structural converter (string/number/boolean/enum/literal/optional/
 *   default/object/array + describe()) is used; if THAT fails, the tool gets
 *   `{type:"object"}` and a warn is written via logToFile. Registration never
 *   crashes: every tool is built/converted/added inside its own try/catch so
 *   one bad tool cannot block the others.
 * - V2 Tool.Result: @opencode/schema/tool was not resolvable from this repo
 *   (v2 packages are not installed here), so execute() returns best-effort
 *   `{ content: output, metadata }` (string results become
 *   `{ content: <string>, metadata: { tool } }`). execute() never throws:
 *   errors are caught and returned as error content strings.
 * - V1 execute() receives a minimal ToolContext carrying the V2 session id
 *   (`context.sessionID ?? context.sessionId ?? ""`); deliveryRegistry
 *   onDispatch wiring for omo_remember/omo_recall_mcp is preserved because the
 *   same builders (with caller-supplied onDispatch) are reused.
 */

import {
  tool as v1ToolFactory,
  type ToolContext as V1ToolContext,
  type ToolResult as V1ToolResult,
} from "@opencode-ai/plugin";
import {
  buildOmoSearchTool,
  buildOmoRecallTool,
  buildOmoHealthTool,
  buildOmoFindTool,
  buildOmoImpactTool,
  buildOmoRememberTool,
  buildOmoRecallMcpTool,
  buildOmoPathTool,
  buildOmoExplainTool,
  buildOmoFilesTool,
  buildOmoCallersTool,
  buildOmoNodeTool,
  buildOmoContextTool,
  buildOmoAffectedCgTool,
  buildOmoStatusTool,
  buildOmoUnlockTool,
  buildOmoMarkDirtyTool,
  buildOmoSyncIfDirtyTool,
  buildOmoIndexTool,
  buildOmoVisualizeTool,
  buildOmoServeTool,
  buildOmoUninitTool,
  buildOmoDiagnoseTool,
  buildOmoMergeGraphsTool,
  buildOmoSaveResultTool,
  buildOmoExtractTool,
  buildOmoClusterOnlyTool,
  buildOmoLabelTool,
  buildOmoTreeTool,
  buildOmoCloneTool,
  buildOmoAddTool,
  buildOmoCheckUpdateTool,
  buildOmoHookStatusTool,
  buildOmoCliAnythingInstallTool,
  buildOmoCliAnythingListTool,
  buildOmoCliAnythingSearchTool,
  buildOmoCliAnythingInfoTool,
} from "./custom-tools";
import { getDefaultGraphRetrieval, type GraphRetrieval } from "./graph-retrieval";
import { getDefaultSqliteBackend, type SqliteBackend } from "./sqlite-backend";
import { createMetricsCollector, type MetricsCollector } from "./metrics";
import { LOG_PATH, logToFile } from "./file-logger";
import { newPluginPaths } from "./utils/migrate";
import type { ZodType } from "zod";

// Same zod instance the V1 builders use (tool.schema re-exports zod v4).
const z = v1ToolFactory.schema;

// ---------------------------------------------------------------------------
// Public V2 structural types (best-effort: @opencode/plugin v2 types are not
// installed in this repo, so these mirror the documented promise-flavour
// editor shape: editor.add({name, description, input, execute}).
// ---------------------------------------------------------------------------

/** JSON Schema document for a tool's input (structural, no v2 dep). */
export type V2JsonSchema = Record<string, unknown>;

/** Minimal V2 tool definition accepted by the promise-flavour ToolEditor. */
export interface V2ToolDefinition {
  name: string;
  description: string;
  input: V2JsonSchema;
  execute: (input: Record<string, unknown>, context: unknown) => Promise<unknown>;
}

/** Minimal V2 tool editor (structural subset of the promise ToolEditor). */
export interface V2ToolEditor {
  add(tool: V2ToolDefinition): void;
}

/** Deps for registerOmoTools. All optional; mirrors plugin.ts factory wiring. */
export interface RegisterOmoToolsDeps {
  graphRetrieval?: GraphRetrieval;
  cwd?: string;
  sqlite?: SqliteBackend;
  metrics?: MetricsCollector;
  logFilePath?: string;
  healthFilePath?: string;
  onDispatch?: (input: {
    sessionID: string;
    mcpTool: string;
    mcpArgs: Record<string, unknown>;
  }) => void;
}

// ---------------------------------------------------------------------------
// Tool names — must match the V1 keys registered in plugin.ts exactly.
// ---------------------------------------------------------------------------

export const OMO_TOOL_NAMES: readonly string[] = [
  "omo_search",
  "omo_recall",
  "omo_health",
  "omo_find",
  "omo_impact",
  "omo_remember",
  "omo_recall_mcp",
  "omo_path",
  "omo_explain",
  "omo_files",
  "omo_callers",
  "omo_node",
  "omo_context",
  "omo_affected_cg",
  "omo_status",
  "omo_unlock",
  "omo_mark_dirty",
  "omo_sync_if_dirty",
  "omo_index",
  "omo_visualize",
  "omo_serve",
  "omo_uninit",
  "omo_diagnose",
  "omo_merge_graphs",
  "omo_save_result",
  "omo_extract",
  "omo_cluster_only",
  "omo_label",
  "omo_tree",
  "omo_clone",
  "omo_add",
  "omo_check_update",
  "omo_hook_status",
  "omo_cli_anything_install",
  "omo_cli_anything_list",
  "omo_cli_anything_search",
  "omo_cli_anything_info",
];

// ---------------------------------------------------------------------------
// Internal: V1 tool structural view.
// execute uses `(args: never)` so every concrete builder signature assigns
// cleanly under strictFunctionTypes (never is assignable to any args type).
// ---------------------------------------------------------------------------

interface V1ToolLike {
  description: string;
  args: Record<string, ZodType>;
  execute: (args: never, ctx: V1ToolContext) => Promise<V1ToolResult>;
}

// ---------------------------------------------------------------------------
// zod v4 -> JSON Schema
// ---------------------------------------------------------------------------

type ZodDefLike = {
  type?: unknown;
  innerType?: unknown;
  element?: unknown;
  entries?: unknown;
  values?: unknown;
};

function readZodDef(schema: unknown): ZodDefLike {
  if (typeof schema !== "object" || schema === null) return {};
  const holder = schema as { _zod?: { def?: ZodDefLike }; def?: ZodDefLike };
  const def = holder._zod?.def ?? holder.def;
  return typeof def === "object" && def !== null ? def : {};
}

function readDescription(schema: unknown): string | undefined {
  if (typeof schema !== "object" || schema === null) return undefined;
  try {
    const meta = (schema as { meta?: () => unknown }).meta?.call(schema);
    if (typeof meta === "object" && meta !== null) {
      const desc = (meta as { description?: unknown }).description;
      if (typeof desc === "string" && desc.length > 0) return desc;
    }
  } catch {
    // best-effort only
  }
  return undefined;
}

function withDescription(out: V2JsonSchema, schema: unknown): V2JsonSchema {
  const desc = readDescription(schema);
  if (desc !== undefined) out.description = desc;
  return out;
}

/**
 * Minimal structural zod->JSON-Schema converter covering the shapes the omo_*
 * builders actually use: string/number/boolean/enum/literal/optional/default/
 * object/array (+ describe). Used only when `z.toJSONSchema()` is unavailable
 * or throws for a given tool.
 */
function structuralZodToJsonSchema(schema: unknown): V2JsonSchema {
  const def = readZodDef(schema);
  const t = typeof def.type === "string" ? def.type : "";
  switch (t) {
    case "string":
      return withDescription({ type: "string" }, schema);
    case "number":
      return withDescription({ type: "number" }, schema);
    case "boolean":
      return withDescription({ type: "boolean" }, schema);
    case "enum": {
      const entries = def.entries;
      const values =
        typeof entries === "object" && entries !== null ? Object.keys(entries) : [];
      return withDescription({ type: "string", enum: values }, schema);
    }
    case "literal": {
      const values = Array.isArray(def.values) ? def.values : [];
      return withDescription({ enum: values }, schema);
    }
    case "array": {
      const items =
        def.element !== undefined
          ? structuralZodToJsonSchema(def.element)
          : {};
      return withDescription({ type: "array", items }, schema);
    }
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "catch":
    case "readonly":
    case "nonoptional":
    case "success":
      if (def.innerType !== undefined) {
        return structuralZodToJsonSchema(def.innerType);
      }
      return withDescription({}, schema);
    case "object": {
      const shape = (schema as { _zod?: { def?: { shape?: unknown } } })._zod?.def
        ?.shape as Record<string, unknown> | undefined;
      const properties: Record<string, V2JsonSchema> = {};
      const required: string[] = [];
      if (shape && typeof shape === "object") {
        for (const [key, field] of Object.entries(shape)) {
          properties[key] = structuralZodToJsonSchema(field);
          const fieldType = readZodDef(field).type;
          if (fieldType !== "optional" && fieldType !== "default") {
            required.push(key);
          }
        }
      }
      const out: V2JsonSchema = { type: "object", properties };
      if (required.length > 0) out.required = required;
      return withDescription(out, schema);
    }
    default:
      return withDescription({}, schema);
  }
}

function convertV1ArgsToJsonSchema(
  toolName: string,
  args: Record<string, ZodType>,
): { schema: V2JsonSchema; usedFallback: boolean } {
  try {
    const toJSONSchema = (
      z as unknown as { toJSONSchema?: (s: unknown) => unknown }
    ).toJSONSchema;
    if (typeof toJSONSchema === "function") {
      const raw = toJSONSchema(z.object(args));
      if (typeof raw === "object" && raw !== null) {
        const { $schema: _dropped, ...rest } = raw as Record<string, unknown>;
        void _dropped;
        if (typeof rest.type === "string") {
          return { schema: rest, usedFallback: false };
        }
        return { schema: { type: "object", ...rest }, usedFallback: false };
      }
    }
  } catch (err) {
    logToFile("warn", `v2-tools ${toolName}: toJSONSchema failed, trying structural fallback`, {
      message: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    return {
      schema: structuralZodToJsonSchema(z.object(args)),
      usedFallback: true,
    };
  } catch (err) {
    logToFile("warn", `v2-tools ${toolName}: schema conversion failed, using {type:object}`, {
      message: err instanceof Error ? err.message : String(err),
    });
    return { schema: { type: "object" }, usedFallback: true };
  }
}

// ---------------------------------------------------------------------------
// execute adapter
// ---------------------------------------------------------------------------

function extractSessionID(context: unknown): string {
  if (typeof context === "object" && context !== null) {
    const c = context as { sessionID?: unknown; sessionId?: unknown };
    if (typeof c.sessionID === "string" && c.sessionID.length > 0) return c.sessionID;
    if (typeof c.sessionId === "string" && c.sessionId.length > 0) return c.sessionId;
  }
  return "";
}

/**
 * Map a V1 ToolResult (string | {title, output, metadata}) to the V2
 * best-effort shape {content, metadata}. See module docstring for why this is
 * best-effort.
 */
function v1ResultToV2(name: string, result: V1ToolResult): unknown {
  if (typeof result === "string") {
    return { content: result, metadata: { tool: name } };
  }
  return {
    content: result.output,
    metadata: result.metadata ?? { tool: name },
  };
}

function adaptExecute(
  name: string,
  v1: V1ToolLike,
  cwd: string,
): (input: Record<string, unknown>, context: unknown) => Promise<unknown> {
  return async (input, context): Promise<unknown> => {
    try {
      const sessionID = extractSessionID(context);
      const v1ctx: V1ToolContext = {
        sessionID,
        messageID: "",
        agent: "",
        directory: cwd,
        worktree: cwd,
        abort: new AbortController().signal,
        metadata: () => {},
        ask: async () => {},
      };
      const result = await v1.execute(input as never, v1ctx);
      return v1ResultToV2(name, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logToFile("warn", `v2-tools ${name}: execute failed`, { message });
      return {
        content: `${name} failed: ${message}`,
        metadata: { tool: name, ok: false },
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Build all omo_* V1 tools and register them on a V2 promise-flavour tool
 * editor. Returns the names successfully registered. One bad tool never
 * blocks the others: build, schema conversion, and add are each guarded.
 */
export function registerOmoTools(
  editor: V2ToolEditor,
  deps: RegisterOmoToolsDeps = {},
): string[] {
  const cwd = deps.cwd ?? process.cwd();
  const graphRetrieval = deps.graphRetrieval ?? getDefaultGraphRetrieval();
  const sqlite = deps.sqlite ?? getDefaultSqliteBackend();
  const metrics = deps.metrics ?? createMetricsCollector({ sessionID: "__v2_tools__" });
  const logFilePath = deps.logFilePath ?? LOG_PATH;
  const healthFilePath = deps.healthFilePath ?? newPluginPaths().health;
  const onDispatch = deps.onDispatch;

  const specs: Array<{ name: string; build: () => V1ToolLike }> = [
    { name: "omo_search", build: () => buildOmoSearchTool({ graphRetrieval, cwd }) },
    { name: "omo_recall", build: () => buildOmoRecallTool({ sqlite }) },
    {
      name: "omo_health",
      build: () => buildOmoHealthTool({ metrics, logFilePath, healthFilePath }),
    },
    { name: "omo_find", build: () => buildOmoFindTool({ cwd }) },
    { name: "omo_impact", build: () => buildOmoImpactTool({ cwd }) },
    { name: "omo_remember", build: () => buildOmoRememberTool({ onDispatch }) },
    { name: "omo_recall_mcp", build: () => buildOmoRecallMcpTool({ onDispatch }) },
    { name: "omo_path", build: () => buildOmoPathTool({ cwd }) },
    { name: "omo_explain", build: () => buildOmoExplainTool({ cwd }) },
    { name: "omo_files", build: () => buildOmoFilesTool({ graphRetrieval, cwd }) },
    { name: "omo_callers", build: () => buildOmoCallersTool({ graphRetrieval, cwd }) },
    { name: "omo_node", build: () => buildOmoNodeTool({ graphRetrieval, cwd }) },
    { name: "omo_context", build: () => buildOmoContextTool({ graphRetrieval, cwd }) },
    { name: "omo_affected_cg", build: () => buildOmoAffectedCgTool({ graphRetrieval, cwd }) },
    { name: "omo_status", build: () => buildOmoStatusTool({ graphRetrieval, cwd }) },
    { name: "omo_unlock", build: () => buildOmoUnlockTool({ graphRetrieval, cwd }) },
    { name: "omo_mark_dirty", build: () => buildOmoMarkDirtyTool({ graphRetrieval, cwd }) },
    { name: "omo_sync_if_dirty", build: () => buildOmoSyncIfDirtyTool({ graphRetrieval, cwd }) },
    { name: "omo_index", build: () => buildOmoIndexTool({ graphRetrieval, cwd }) },
    { name: "omo_visualize", build: () => buildOmoVisualizeTool({ graphRetrieval, cwd }) },
    { name: "omo_serve", build: () => buildOmoServeTool({ graphRetrieval, cwd }) },
    { name: "omo_uninit", build: () => buildOmoUninitTool({ graphRetrieval, cwd }) },
    { name: "omo_diagnose", build: () => buildOmoDiagnoseTool({ graphRetrieval, cwd }) },
    { name: "omo_merge_graphs", build: () => buildOmoMergeGraphsTool({ graphRetrieval, cwd }) },
    { name: "omo_save_result", build: () => buildOmoSaveResultTool({ graphRetrieval, cwd }) },
    { name: "omo_extract", build: () => buildOmoExtractTool({ graphRetrieval, cwd }) },
    { name: "omo_cluster_only", build: () => buildOmoClusterOnlyTool({ graphRetrieval, cwd }) },
    { name: "omo_label", build: () => buildOmoLabelTool({ graphRetrieval, cwd }) },
    { name: "omo_tree", build: () => buildOmoTreeTool({ graphRetrieval, cwd }) },
    { name: "omo_clone", build: () => buildOmoCloneTool({ graphRetrieval, cwd }) },
    { name: "omo_add", build: () => buildOmoAddTool({ graphRetrieval, cwd }) },
    { name: "omo_check_update", build: () => buildOmoCheckUpdateTool({ graphRetrieval, cwd }) },
    { name: "omo_hook_status", build: () => buildOmoHookStatusTool({ cwd }) },
    { name: "omo_cli_anything_install", build: () => buildOmoCliAnythingInstallTool({ cwd }) },
    { name: "omo_cli_anything_list", build: () => buildOmoCliAnythingListTool({ cwd }) },
    { name: "omo_cli_anything_search", build: () => buildOmoCliAnythingSearchTool({ cwd }) },
    { name: "omo_cli_anything_info", build: () => buildOmoCliAnythingInfoTool({ cwd }) },
  ];

  const registered: string[] = [];
  for (const spec of specs) {
    try {
      const built = spec.build();
      const { schema, usedFallback } = convertV1ArgsToJsonSchema(spec.name, built.args);
      if (usedFallback) {
        logToFile("warn", `v2-tools ${spec.name}: registered with fallback JSON schema`, {
          tool: spec.name,
        });
      }
      const def: V2ToolDefinition = {
        name: spec.name,
        description: built.description,
        input: schema,
        execute: adaptExecute(spec.name, built, cwd),
      };
      editor.add(def);
      registered.push(spec.name);
    } catch (err) {
      logToFile("warn", `v2-tools: skipped ${spec.name}`, {
        tool: spec.name,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return registered;
}
