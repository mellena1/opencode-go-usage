import { Plugin } from "@opencode/plugin";
import { UsageError, fetchUsage, resolveApiKey } from "./usage.js";
import { GoUsageRpc } from "./rpc.js";

/**
 * Server entry: resolves the live `opencode-go` credential through the plugin
 * SDK (`ctx.integration.connection.active` + `resolve`) and serves usage over
 * RPC so the TUI never reads the legacy auth.json file directly. That file can
 * hold a stale key while inference already uses the live one from
 * `opencode auth export`, which previously surfaced as HTTP 401 in the widget.
 */
export default Plugin.define({
  id: "opencode-go-usage",
  setup: async (ctx) => {
    const options = ctx.options as Readonly<Record<string, any>>;

    const registration = await ctx.rpc.register(GoUsageRpc, {
      // JSON-schema RPC handlers are untyped (unknown); narrow at the boundary.
      getUsage: async (input: any, context: any) => {
        const parsed = (input ?? {}) as { baseUrl?: unknown };
        const rawBaseUrl =
          typeof parsed.baseUrl === "string" && parsed.baseUrl.trim()
            ? parsed.baseUrl.trim()
            : typeof options.baseUrl === "string" && options.baseUrl.trim()
              ? options.baseUrl.trim()
              : undefined;

        let apiKey: string | undefined;

        const fromOption = options.apiKey;
        if (typeof fromOption === "string" && fromOption.trim()) {
          apiKey = fromOption.trim();
        }

        if (!apiKey) {
          try {
            const connection = await ctx.integration.connection.active("opencode-go");
            if (connection) {
              const credential = await ctx.integration.connection.resolve(connection);
              if (credential?.type === "key" && credential.key.trim()) {
                apiKey = credential.key.trim();
              }
            }
          } catch {
            apiKey = undefined;
          }
        }

        if (!apiKey) {
          const fallback = await resolveApiKey(options).catch(() => undefined);
          apiKey = fallback?.apiKey;
        }

        if (!apiKey) {
          return context.error("no-key", "No OpenCode Go API key found", {
            message: "No OpenCode Go API key found",
          });
        }

        try {
          const usage = await fetchUsage(apiKey, { baseUrl: rawBaseUrl });
          return usage;
        } catch (error) {
          if (error instanceof UsageError) {
            return context.error(error.kind, error.message, {
              message: error.message,
              ...(typeof error.status === "number" ? { status: error.status } : {}),
            });
          }
          const message = error instanceof Error ? error.message : String(error);
          return context.error("network", message, { message });
        }
      },
    });

    return () => registration.dispose();
  },
});
