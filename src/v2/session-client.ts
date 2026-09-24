/**
 * V2 session client — implements the `OpencodeClientLike` surface from
 * `src/session-bridge.ts` (`{ session: { prompt({path:{id},body:{parts}}) } }`)
 * by delegating to the V2 `ctx.session.prompt`.
 *
 * v0.50.0 Oracle B1 fix: the V2 wire shape is flat
 * `prompt({ sessionID: string, text: string, ... })` per
 * `@opencode/client` `SessionPromptInput`, and it resolves to
 * `SessionInboxUser = { id, sessionID, ... }` (NOT the V1
 * `{ data: { info: { id } } }` envelope). The previous path/body + parts
 * attempts could never succeed — delivery was 100% dead. Now the primary
 * path is the real V2 shape; the legacy attempts are kept only as
 * last-resort fallbacks for hosts that deviate.
 *
 * Never throws: `prompt()` always resolves. All failures are caught, logged
 * via `logToFile` (never `console.*` — that leaks into the TUI).
 */

import type { Plugin as V2PluginNs } from "@opencode/plugin";
import type { OpencodeClientLike } from "../session-bridge";
import { logToFile } from "../file-logger";

type PromptPart = { type: string; text?: string; [k: string]: unknown };

interface PromptWireShape {
  path: { id: string };
  body: { parts: PromptPart[] };
}

function partsToText(parts: PromptPart[]): string {
  return parts
    .map((p) =>
      typeof p?.text === "string" ? p.text : JSON.stringify(p ?? null),
    )
    .join("\n\n");
}

function extractMessageId(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  // V2: SessionInboxUser = { id, sessionID, ... } (flat).
  if (typeof rec.id === "string") return rec.id;
  // V1 envelope (kept for fallback paths): { data: { info: { id } } }.
  const data = rec.data;
  if (data !== null && typeof data === "object") {
    const info = (data as Record<string, unknown>).info;
    if (info !== null && typeof info === "object") {
      const id = (info as Record<string, unknown>).id;
      if (typeof id === "string") return id;
    }
  }
  return null;
}

function asCallable(fn: unknown): ((arg: unknown) => Promise<unknown>) | null {
  return typeof fn === "function"
    ? (fn as (arg: unknown) => Promise<unknown>)
    : null;
}

export class V2SessionClient implements OpencodeClientLike {
  readonly session: OpencodeClientLike["session"];

  constructor(ctx: V2PluginNs.Context) {
    // Capture the session domain (not the whole ctx) so the adapter stays
    // valid even if the setup context object is later mutated.
    const session = (ctx as unknown as { session?: unknown }).session;
    this.session = {
      prompt: async (
        input: PromptWireShape,
      ): Promise<{ data?: { info?: { id?: string } } | null } | null> => {
        const parts: PromptPart[] = Array.isArray(input?.body?.parts)
          ? input.body.parts
          : [];
        const sessionID: string = input?.path?.id ?? "";
        if (!sessionID) {
          logToFile("warn", "v2_session_client_missing_session_id");
          return null;
        }
        const promptFn = asCallable(
          (session as { prompt?: unknown } | null | undefined)?.prompt,
        );
        if (!promptFn) {
          logToFile("warn", "v2_session_client_no_prompt_fn");
          return null;
        }
        const bound = promptFn.bind(session);
        const text = partsToText(parts);
        // Attempt 1 (primary): real V2 shape — flat { sessionID, text }.
        try {
          const res = await bound({ sessionID, text });
          const id = extractMessageId(res);
          // Normalize to the V1 envelope the bridge expects downstream.
          return id ? { data: { info: { id } } } : null;
        } catch (err1: unknown) {
          logToFile("warn", "v2_session_client_flat_shape_failed", {
            message: err1 instanceof Error ? err1.message : String(err1),
          });
        }
        // Attempt 2 (legacy fallback): V1 wire shape.
        try {
          const res = await bound({ path: { id: sessionID }, body: { parts } });
          const id = extractMessageId(res);
          return id ? { data: { info: { id } } } : null;
        } catch (err2: unknown) {
          logToFile("warn", "v2_session_client_prompt_failed", {
            message: err2 instanceof Error ? err2.message : String(err2),
          });
          return null;
        }
      },
    };
  }
}
