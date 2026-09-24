/**
 * V2 hook bridge — registers every V1 hook returned by
 * `createMetaGovernorPlugin(config, deps)` onto the V2
 * (`@opencode/plugin@2.0.16` promise flavour) setup context.
 *
 * Nothing is skipped silently: every V1 hook key is either bridged or logged
 * with a reason via `logToFile` (never `console.*` — that leaks into the TUI).
 * V2 hook callbacks never throw, except the `execute.before` block path which
 * rethrows intentionally (V1 semantics: a throw blocks the tool call).
 */

import type { Hooks } from "@opencode-ai/plugin";
// NOTE: V2 types come from the package root (see src/v2/v1-input.ts).
import type { Plugin as V2PluginNs } from "@opencode/plugin";
import { logToFile } from "../file-logger";

export type V2Context = V2PluginNs.Context;

/** Structural V2 registration (dispose-only); assignable from the real one. */
export interface V2Registration {
  dispose: () => Promise<void>;
}

/** V1 hook keys we explicitly bridge or explicitly skip (with reason). */
const KNOWN_V1_KEYS = new Set<string>([
  "tool.execute.before",
  "tool.execute.after",
  "experimental.chat.system.transform",
  "experimental.chat.messages.transform",
  "experimental.session.compacting",
  "permission.ask",
  "tool.definition",
  "command.execute.before",
  "experimental.provider.small_model",
  "experimental.compaction.autocontinue",
  "event",
  "dispose",
  "tool",
]);

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Extract text from a V2 SystemPart-shaped value; null for non-text parts. */
function systemTextOf(part: unknown): string | null {
  if (part === null || typeof part !== "object") return null;
  const rec = part as { type?: unknown; text?: unknown };
  if (rec.type !== "text" || typeof rec.text !== "string") return null;
  return rec.text;
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const s = JSON.stringify(value);
    return typeof s === "string" ? s : String(value);
  } catch {
    return String(value);
  }
}

/** Extract text lines from V2 message content parts for the V1 view. */
function v2ContentToV1Parts(content: unknown): unknown[] {
  if (!Array.isArray(content)) return [];
  const parts: unknown[] = [];
  for (const c of content) {
    if (c === null || typeof c !== "object") continue;
    const rec = c as { type?: unknown; text?: unknown };
    if (rec.type === "text" && typeof rec.text === "string") {
      parts.push({ type: "text", text: rec.text });
    }
  }
  return parts;
}

/** Flatten V1 text parts back to a single string for V2 injection. */
function v1PartsToText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((p) => {
      if (p === null || typeof p !== "object") return "";
      const rec = p as { type?: unknown; text?: unknown };
      return rec.type === "text" && typeof rec.text === "string"
        ? rec.text
        : "";
    })
    .filter((t) => t.length > 0)
    .join("\n\n");
}

/**
 * Register every V1 hook onto the V2 context.
 * @returns the V2 registrations (caller disposes them on teardown).
 */
export async function bridgeHooks(
  ctx: V2Context,
  hooks: Hooks,
): Promise<V2Registration[]> {
  const registrations: V2Registration[] = [];

  // ── tool.execute.before → ctx.tool.hook("execute.before") ──────────────
  const v1Before = hooks["tool.execute.before"];
  if (v1Before) {
    registrations.push(
      await ctx.tool.hook("execute.before", async (e) => {
        // Live view: V1 mutation of output.args writes back to e.input.
        const outputView = {
          get args(): unknown {
            return e.input;
          },
          set args(v: unknown) {
            e.input = v;
          },
        };
        try {
          await v1Before(
            { tool: e.tool, sessionID: e.sessionID, callID: e.id } as never,
            outputView as never,
          );
        } catch (err: unknown) {
          // Intentional rethrow: V1 semantics treat a before-hook throw
          // (e.g. the skill-priming enforcement gate) as "block the call".
          logToFile("warn", "v2_bridge_before_hook_block", {
            tool: e.tool,
            message: errText(err),
          });
          throw err;
        }
      }),
    );
  } else {
    logToFile("info", "v2_bridge_skip_before", {
      reason: "V1 hook absent (plugin disabled or factory omitted it)",
    });
  }

  // ── tool.execute.after → ctx.tool.hook("execute.after") ────────────────
  const v1After = hooks["tool.execute.after"];
  if (v1After) {
    registrations.push(
      await ctx.tool.hook("execute.after", async (e) => {
        const outputView = {
          title: "",
          output:
            e.status === "completed" ? safeStringify(e.result) : "",
          // Pass the whole V2 event as metadata (read-only reference).
          metadata: e,
        };
        try {
          // V1 hook catches internally and never throws, but guard anyway so
          // a regression can never break the tool-result delivery path.
          await v1After(
            {
              tool: e.tool,
              sessionID: e.sessionID,
              callID: e.id,
              args: e.input,
            } as never,
            outputView as never,
          );
        } catch (err: unknown) {
          logToFile("warn", "v2_bridge_after_hook_failed", {
            tool: e.tool,
            message: errText(err),
          });
        }
      }),
    );
  } else {
    logToFile("info", "v2_bridge_skip_after", {
      reason: "V1 hook absent (plugin disabled or factory omitted it)",
    });
  }

  // ── system.transform + messages.transform → ONE session "context" hook ──
  const v1Sys = hooks["experimental.chat.system.transform"];
  const v1Msg = hooks["experimental.chat.messages.transform"];
  if (v1Sys ?? v1Msg) {
    registrations.push(
      await ctx.session.hook("context", async (e) => {
        if (v1Sys) {
          try {
            // String-backed view over the text SystemParts. Non-text parts
            // are preserved positionally; appended strings are wrapped as
            // { type: "text", text } objects on the way back.
            const textIndices: number[] = [];
            const view: string[] = [];
            e.system.forEach((part, idx) => {
              const t = systemTextOf(part);
              if (t !== null) {
                textIndices.push(idx);
                view.push(t);
              }
            });
            await v1Sys(
              { sessionID: e.sessionID, model: e.model } as never,
              { system: view } as never,
            );
            view.forEach((text, vi) => {
              if (vi < textIndices.length) {
                const ei = textIndices[vi] as number;
                const cur = systemTextOf(e.system[ei]);
                if (cur !== text) {
                  e.system[ei] = { type: "text", text } as never;
                }
              } else {
                e.system.push({ type: "text", text } as never);
              }
            });
          } catch (err: unknown) {
            // Never break the model request because of governance injection.
            logToFile("warn", "v2_bridge_system_transform_failed", {
              message: errText(err),
            });
          }
        }
        if (v1Msg) {
          try {
            // v0.50.0 Oracle B2 fix: V1 derives sessionID from
            // `lastMsg?.info?.sessionID` (plugin.ts) but V2 Message is
            // `{ id?, role, content: ContentPart[], ... }` — no `.info`,
            // so passing e.messages through left the hook permanently
            // short-circuited. Build a V1-shaped VIEW copy carrying the
            // sessionID, and NEVER push V1-shaped objects back into the V2
            // host array: appended V1 synthetic messages are translated to
            // V2 assistant messages instead.
            const view: Array<{ info: unknown; parts: unknown[] }> =
              e.messages.map((m) => ({
                info: {
                  sessionID: e.sessionID,
                  role: (m as { role?: unknown }).role ?? "user",
                },
                parts: v2ContentToV1Parts(
                  (m as { content?: unknown }).content,
                ),
              }));
            const baseLen = view.length;
            await v1Msg({} as never, { messages: view } as never);
            for (let i = baseLen; i < view.length; i++) {
              const text = v1PartsToText(
                (view[i] as { parts?: unknown }).parts,
              );
              if (text) {
                e.messages.push({
                  role: "assistant",
                  content: [{ type: "text", text }],
                } as never);
              }
            }
            if (view.length > baseLen) {
              logToFile("info", "v2_bridge_messages_injected", {
                count: view.length - baseLen,
              });
            }
          } catch (err: unknown) {
            logToFile("warn", "v2_bridge_messages_transform_failed", {
              message: errText(err),
            });
          }
        }
      }),
    );
  } else {
    logToFile("info", "v2_bridge_skip_context", {
      reason: "both V1 chat transforms absent (plugin disabled or omitted)",
    });
  }

  // ── experimental.session.compacting → session "compaction" ──────────────
  const v1Compact = hooks["experimental.session.compacting"];
  if (v1Compact) {
    registrations.push(
      await ctx.session.hook("compaction", async (e) => {
        try {
          const outputView: { context: string[]; prompt?: string } = {
            context: [],
          };
          await v1Compact({ sessionID: e.sessionID } as never, outputView as never);
          // V1 collects lesson lines into output.context; V2 has no context
          // array, so each line becomes a text SystemPart.
          for (const line of outputView.context) {
            if (typeof line === "string" && line.length > 0) {
              e.system.push({ type: "text", text: line } as never);
            }
          }
          if (typeof outputView.prompt === "string" && outputView.prompt.length > 0) {
            // No V2 prompt-replacement field exists; carry it as system text
            // (best-effort) so the content is not silently dropped.
            e.system.push({ type: "text", text: outputView.prompt } as never);
            logToFile("info", "v2_bridge_compaction_prompt_folded_to_system");
          }
        } catch (err: unknown) {
          logToFile("warn", "v2_bridge_compaction_failed", {
            message: errText(err),
          });
        }
      }),
    );
  } else {
    logToFile("info", "v2_bridge_skip_compaction", {
      reason: "V1 hook absent (plugin disabled or factory omitted it)",
    });
  }

  // ── permission.ask → ctx.permission.hook("evaluate") ────────────────────
  const v1Perm = hooks["permission.ask"];
  if (v1Perm) {
    registrations.push(
      await ctx.permission.hook("evaluate", async (e) => {
        try {
          // Best-effort V1 Permission: V1 switches on input.type ("bash" →
          // input.command, "edit" → input.pattern, "webfetch" → input.url),
          // so the first resource is offered under every field name.
          const first =
            e.resources.length > 0 && typeof e.resources[0] === "string"
              ? (e.resources[0] as string)
              : "";
          const v1Input = {
            type: e.action,
            command: first,
            pattern: first,
            url: first,
            resources: e.resources,
            sessionID: e.sessionID,
          };
          let status: "ask" | "deny" | "allow" =
            e.effect === "deny" || e.effect === "ask" || e.effect === "allow"
              ? e.effect
              : "allow";
          const v1Output = {
            get status(): "ask" | "deny" | "allow" {
              return status;
            },
            set status(v: "ask" | "deny" | "allow") {
              status = v;
            },
          };
          await v1Perm(v1Input as never, v1Output as never);
          e.effect = status;
          if (status !== "allow" && e.message === undefined) {
            e.message = `[meta-governor] permission ${status} by governance policy`;
          }
        } catch (err: unknown) {
          // Default allow on error: matches the V1 default when no policy is
          // configured (pure pass-through no-op) — leave e.effect untouched.
          logToFile("warn", "v2_bridge_permission_failed_default_allow", {
            action: e.action,
            message: errText(err),
          });
        }
      }),
    );
  } else {
    logToFile("info", "v2_bridge_skip_permission", {
      reason: "V1 hook absent (plugin disabled or factory omitted it)",
    });
  }

  // ── tool.definition → ctx.tool.transform ────────────────────────────────
  const v1ToolDef = hooks["tool.definition"];
  if (v1ToolDef) {
    await ctx.tool.transform((editor) => {
      // Sync callback: V1 handleToolDefinition is async but contains no
      // awaits, so its mutations land synchronously; the .catch below only
      // guards against a future async regression.
      for (const t of editor.list()) {
        try {
          const schema = (t as unknown as { input?: unknown }).input;
          const parameters =
            schema !== null && typeof schema === "object"
              ? schema
              : { properties: {} };
          const outputView = { description: t.description, parameters };
          void Promise.resolve(
            v1ToolDef({ toolID: t.id } as never, outputView as never),
          ).catch((err: unknown) => {
            logToFile("warn", "v2_bridge_tool_definition_failed", {
              toolID: t.id,
              message: errText(err),
            });
          });
          if (outputView.description !== t.description) {
            const next = outputView.description;
            // Parameter-description mutations apply in place (the live schema
            // object was passed through); only description needs write-back.
            editor.update(t.id, (tool) => {
              (tool as unknown as { description?: unknown }).description =
                next;
            });
          }
        } catch (err: unknown) {
          logToFile("warn", "v2_bridge_tool_definition_failed", {
            toolID: t.id,
            message: errText(err),
          });
        }
      }
    });
  } else {
    logToFile("info", "v2_bridge_skip_tool_definition", {
      reason: "V1 hook absent (plugin disabled or factory omitted it)",
    });
  }

  // ── Explicit skips (no V2 equivalent) ───────────────────────────────────
  if (hooks["command.execute.before"]) {
    logToFile(
      "warn",
      "v2_bridge_skip_command_filter",
      {
        reason:
          "commandFilter governance is V1-only until command transforms are implemented (no direct V2 hook)",
      },
    );
  }
  if (hooks["experimental.provider.small_model"]) {
    logToFile(
      "warn",
      "v2_bridge_skip_small_model",
      {
        reason:
          "no V2 equivalent per the official plugin guide; model transforms are a separate feature",
      },
    );
  }
  if (hooks["experimental.compaction.autocontinue"]) {
    logToFile(
      "warn",
      "v2_bridge_skip_autocontinue",
      {
        reason:
          "no V2 equivalent; overflow loop guard stays V1-only for now",
      },
    );
  }
  if (hooks["event"]) {
    // The V1 event hook only handles "tool.execute.before"/"tool.execute.after",
    // both already bridged above — re-subscribing would double-deliver.
    logToFile("info", "v2_bridge_skip_event", {
      reason: "already covered by the tool execute.before/after bridges; not re-subscribed",
    });
  }

  // ── Sweep: any other function-valued key we did not account for ─────────
  for (const key of Object.keys(hooks)) {
    if (KNOWN_V1_KEYS.has(key)) continue;
    let value: unknown;
    try {
      value = (hooks as unknown as Record<string, unknown>)[key];
    } catch (err: unknown) {
      logToFile("warn", "v2_bridge_sweep_read_failed", {
        key,
        message: errText(err),
      });
      continue;
    }
    if (typeof value === "function") {
      logToFile("warn", "v2_bridge_skip_unmapped_hook", {
        key,
        reason: "no V2 equivalent mapped; left unregistered",
      });
    }
  }

  return registrations;
}
