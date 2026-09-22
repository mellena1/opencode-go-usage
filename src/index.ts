import { Plugin } from "@opencode/plugin";

/**
 * This plugin's functionality is TUI-only — see `./tui.tsx`, which renders the
 * OpenCode Go usage widget in the session sidebar.
 *
 * This no-op server entry exists so the opencode **server** can resolve the
 * package cleanly when it is referenced from config (by path or from npm). It
 * registers nothing and performs no work. The TUI badge (`./tui` entrypoint)
 * is loaded automatically via the `./tui` export in package.json.
 */

export default Plugin.define({
  id: "opencode-go-usage",
  setup: () => {},
});