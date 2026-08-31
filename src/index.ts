import { Plugin } from "@opencode-ai/plugin";

/**
 * This plugin's functionality is TUI-only — see `./tui.tsx`, which renders the
 * OpenCode Go usage widget in the session sidebar.
 *
 * This no-op server entry exists so the opencode **server** can resolve the
 * package cleanly when it is referenced from config (by path or from npm). It
 * registers nothing and performs no work.
 */

type ServerPlugin = Parameters<typeof Plugin.define>[0] & { readonly tui: boolean };

const plugin: ServerPlugin = {
  id: "opencode-go-usage",
  tui: true,
  setup: () => {},
};

export default Plugin.define(plugin);