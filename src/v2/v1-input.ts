/**
 * V2 input builder — adapts an `@opencode/plugin@2.0.16` (promise flavour)
 * setup `Context` into the V1 `PluginInput` shape expected by
 * `createMetaGovernorPlugin(config, deps)` in `src/plugin.ts`.
 *
 * V1 `PluginInput` fields:
 * - `client`: documented as **null by design**. V2 no longer exposes the V1
 *   SDK client (`ReturnType<typeof createOpencodeClient>`); session delivery
 *   in V2 goes through the `V2SessionClient` adapter (`src/v2/session-client.ts`),
 *   which is installed via `setSessionClient()` in `src/v2/setup.ts` AFTER the
 *   factory resolves. The factory itself treats a null client as "skip
 *   hydration" (see the `safeClient` guard in `src/plugin.ts`).
 * - `project`: taken from `ctx.location.project` when present, with a
 *   defensive fallback to the directory.
 * - `directory` / `worktree`: both resolve to `ctx.location.directory`
 *   (V2 no longer distinguishes worktree from directory at this layer).
 * - `experimental_workspace`: V1 expects `{ register(type, adapter) }`; V2 has
 *   no equivalent registry surface at setup time, so we provide a no-op
 *   `register()` that satisfies the shape without side effects.
 * - `serverUrl`: V1 only uses this for diagnostics; V2 exposes no server URL,
 *   so we pass a loopback placeholder.
 * - `$`: the V1 Bun shell handle; unused by the factory paths we bridge, so
 *   null (boundary-cast with comment at the call site).
 */

import type { PluginInput, PluginOptions } from "@opencode-ai/plugin";
// NOTE: V2 types come from the package root (the "./*" exports wildcard does
// not map subpath ".js" → ".d.ts" under tsc bundler resolution). The root
// re-exports `* as Plugin` from the promise flavour (package.json ".").
import type { Plugin as V2PluginNs } from "@opencode/plugin";

export type V2Context = V2PluginNs.Context;

function readLocation(ctx: V2Context): { project: unknown; directory: string } {
  const loc = (ctx as unknown as { location?: unknown }).location as
    | { project?: unknown; directory?: unknown }
    | undefined;
  const directory =
    typeof loc?.directory === "string" && loc.directory.length > 0
      ? loc.directory
      : process.cwd();
  return { project: loc?.project ?? null, directory };
}

/**
 * Build the V1 `PluginInput` for the given V2 setup context.
 * Never throws: every field has a fallback.
 */
export function buildV1Input(ctx: V2Context): PluginInput {
  const { project, directory } = readLocation(ctx);
  const input = {
    // V2 has no V1 SDK client — session delivery goes via V2SessionClient
    // (installed with setSessionClient after the factory resolves).
    client: null,
    project,
    directory,
    worktree: directory,
    experimental_workspace: {
      register(): void {
        // No-op: V2 exposes no V1 workspace registry at setup time.
      },
    },
    serverUrl: new URL("http://localhost"),
    // V1 Bun shell handle; unused on the bridged factory paths.
    $: null,
  };
  // Boundary cast: the nulls above are intentional (documented) and the
  // factory narrows them at runtime (safeClient guard in src/plugin.ts).
  return input as unknown as PluginInput;
}

/**
 * Resolve the V1 `PluginOptions` (`{ meta_governor: {...} }`) from the V2
 * `ctx.options`, supporting both shapes:
 * - `{ meta_governor: {...} }` (V1 inline-options style, highest precedence)
 * - top-level `{ enabled, ... }` (V2 plugin-config style)
 *
 * When both are present they are merged with `meta_governor` winning on
 * overlapping keys — mirroring the V1 factory precedence (inline > file).
 */
export function resolveV1Options(ctx: V2Context): PluginOptions {
  const raw = ((): Record<string, unknown> => {
    const opts = (ctx as unknown as { options?: unknown }).options;
    if (opts !== null && typeof opts === "object" && !Array.isArray(opts)) {
      return opts as Record<string, unknown>;
    }
    return {};
  })();
  const nested = raw["meta_governor"];
  const nestedObj =
    nested !== null && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : {};
  const { meta_governor: _ignored, ...topLevel } = raw;
  void _ignored;
  return { meta_governor: { ...topLevel, ...nestedObj } };
}
