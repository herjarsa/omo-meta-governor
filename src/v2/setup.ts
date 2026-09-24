/**
 * V2 setup — builds the `@opencode/plugin@2.0.16` (promise flavour) plugin
 * object that bridges the V1 factory `createMetaGovernorPlugin(config, deps)`
 * from `src/plugin.ts`.
 *
 * Order of operations inside `setup(ctx)`:
 * 1. Build the V1 input (`buildV1Input`) and options (`resolveV1Options`).
 *    The V1 `client` is null by design (V2 exposes no V1 SDK client); the
 *    factory skips hydration and session delivery is provided by the V2
 *    session adapter installed in step 3.
 * 2. Call the V1 factory and await the resolved V1 `Hooks`.
 * 3. Override the (null) session client via
 *    `setSessionClient(new V2SessionClient(ctx))` so `promptAgent()` /
 *    `persistSessionMessage()` route through `ctx.session.prompt`.
 * 4. `bridgeHooks(ctx, hooks)` — register every V1 hook onto V2.
 * 5. Return a cleanup that disposes the V2 registrations first, then calls
 *    the V1 `hooks.dispose` (which sweeps child processes, watchers, …).
 *
 * NOTE: the V1 `tool` map (`omo_*` custom tools) is registered on V2 via
 * `registerOmoTools` (src/v2-tools.ts: zod→JSON Schema + execute adapter)
 * inside `ctx.tool.transform` — see step 4b below.
 */

import type { Plugin as V2PluginNs } from "@opencode/plugin";
import { createMetaGovernorPlugin } from "../plugin";
import type { MetaGovernorPluginDeps } from "../plugin";
import type { MetaGovernorPluginConfig } from "../config";
import { setSessionClient } from "../session-bridge";
import { logToFile } from "../file-logger";
import { buildV1Input, resolveV1Options } from "./v1-input";
import type { V2Context } from "./v1-input";
import { V2SessionClient } from "./session-client";
import { bridgeHooks } from "./hook-bridge";
import type { V2Registration } from "./hook-bridge";
import { registerOmoTools } from "../v2-tools";

/**
 * Create the V2 plugin object. `config`/`deps` are forwarded to the V1
 * factory (file config + inline options still merge inside the factory with
 * inline > file > factory-arg precedence).
 */
export function createV2Setup(
  config: MetaGovernorPluginConfig = {},
  deps: MetaGovernorPluginDeps = {},
): V2PluginNs.Plugin {
  return {
    id: "omo-meta-governor",
    setup: async (ctx: V2Context): Promise<V2PluginNs.Cleanup | void> => {
      const v1Input = buildV1Input(ctx);
      const v1Options = resolveV1Options(ctx);
      const factory = createMetaGovernorPlugin(config, deps);
      const hooks = await factory(v1Input, v1Options);

      // Step 3: install the V2 session adapter (overrides the null client the
      // factory saw — the factory's own setSessionClient(null) is a no-op for
      // delivery; last writer wins).
      try {
        setSessionClient(new V2SessionClient(ctx));
      } catch (err: unknown) {
        logToFile("warn", "v2_setup_session_client_failed", {
          message: err instanceof Error ? err.message : String(err),
        });
      }

      // Step 4: bridge every V1 hook onto V2.
      let registrations: V2Registration[] = [];
      try {
        registrations = await bridgeHooks(ctx, hooks);
      } catch (err: unknown) {
        logToFile("warn", "v2_setup_bridge_failed", {
          message: err instanceof Error ? err.message : String(err),
        });
      }

      // Step 4b: register the omo_* custom tools via the V2 tool editor.
      // transform() is sync — registerOmoTools never throws per-tool (each
      // registration is individually guarded), but guard the whole call too.
      try {
        await ctx.tool.transform((editor) => {
          try {
            const names = registerOmoTools(
              editor as unknown as Parameters<typeof registerOmoTools>[0],
            );
            logToFile("info", `v2_setup_tools_registered: ${names.length} omo_* tools`);
          } catch (err: unknown) {
            logToFile("warn", "v2_setup_tools_failed", {
              message: err instanceof Error ? err.message : String(err),
            });
          }
        });
      } catch (err: unknown) {
        logToFile("warn", "v2_setup_tool_transform_failed", {
          message: err instanceof Error ? err.message : String(err),
        });
      }

      // Step 5: teardown — V2 registrations first, then the V1 dispose hook.
      return async (): Promise<void> => {
        for (const reg of registrations) {
          try {
            await reg.dispose();
          } catch (err: unknown) {
            logToFile("warn", "v2_setup_registration_dispose_failed", {
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
        try {
          await hooks.dispose?.();
        } catch (err: unknown) {
          logToFile("warn", "v2_setup_v1_dispose_failed", {
            message: err instanceof Error ? err.message : String(err),
          });
        }
      };
    },
  };
}
