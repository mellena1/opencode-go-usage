# opencode-go-usage

An OpenCode v2 **TUI plugin** that shows your **OpenCode Go** subscription usage
in the session sidebar: the 5-hour, weekly, and monthly quota windows with used
percentage, reset countdown, and a warning color once you approach a limit.

Power is a sidebar widget — it reads the official Go usage endpoint and never
scrapes the dashboard or manages credentials beyond what you already have.

## What it looks like

In the session sidebar (right column) the widget appears in the content area —
at the bottom, below the built-in Context / Modified-files sections:

```
● Go usage just now
5h  12%  █░░░░░░░░░░░ 2m
wk  78%  █████████░░░ 1h
mo  94%  ███████████░ 3d
```

- The leading dot and rows are green under 70%, yellow from 70–89%, and red at
  90%+ (relative to the **highest** of the three windows).
- When a refresh fails the last known values stay visible, with a short note
  and one toast per failure episode.
- If OpenCode Go isn't configured on this machine (no key in `options`, the
  `OPENCODE_API_KEY` env var, or auth.json), the widget **hides itself**
  entirely instead of showing an error.
- `Go usage · refresh` command (command palette, default binding
  `ctrl+alt+g`) forces an immediate refresh.

## How it works

OpenCode Go exposes an official quota endpoint — the same one the web console
is built on:

```
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <your Go API key>
```

It returns the three subscription windows as used percentages with reset times:

```json
{
  "usage": {
    "rolling": { "status": "ok", "percent": 12, "resetsAt": "…" },
    "weekly":  { "status": "ok", "percent": 78, "resetsAt": "…" },
    "monthly": { "status": "ok", "percent": 94, "resetsAt": "…" }
  }
}
```

The plugin fetches this on load and then on an interval, and renders the
windows in the sidebar's `sidebar.content` slot.

### API key resolution

The plugin finds your Go key in the same order opencode does:

1. `options.apiKey` (explicit plugin option — always wins)
2. `OPENCODE_API_KEY` environment variable
3. `~/.local/share/opencode/auth.json` (or the platform equivalent) — the file
   `opencode auth login` writes; the `opencode-go` entry is preferred over the
   legacy `opencode` entry

`HTTP 401` means the key was rejected; `HTTP 403 EntitlementError` means the
key is valid but has no Go subscription. Both are surfaced in the widget. When
no key can be found at all, the widget renders nothing.

## Install

Add the plugin to the `plugins` list in your `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "@mellena1/opencode-go-usage" }
  ]
}
```

> This is a **TUI-only** plugin: the server side only loads a no-op entry so it
> resolves cleanly; all functionality lives in the TUI. If your sidebar is
> hidden (session `sidebar: "hide"`), the widget simply isn't visible.

### Options

| Option | Type | Default | Description |
| ------ | ---- | ------- | ----------- |
| `apiKey` | `string` | auto-detected | Go API key override. Rarely needed — the key opencode already uses is found automatically. |
| `refreshSeconds` | `number` | `300` | Refresh interval (clamped to a 30s minimum). |
| `baseUrl` | `string` | `https://opencode.ai/zen/go` | Usage API base; `/v1/usage` is appended. Mostly for local testing — HTTP is allowed only for localhost/loopback, everything else must be `https:` so the API key is never sent in cleartext. |
| `keybinds.refresh` | `string \| false` | `ctrl+alt+g` | Keybinding for the refresh command (`false` disables the binding). |

Example with a custom cadence:

```jsonc
{
  "plugins": [
    {
      "package": "@mellena1/opencode-go-usage",
      "options": {
        "refreshSeconds": 120,
        "keybinds": { "refresh": "ctrl+alt+r" }
      }
    }
  ]
}
```

## Local development

```sh
bun install
bun run typecheck
bun test
```

`src/` is what gets published — the `exports` map in `package.json` points
straight at the TypeScript sources, so there is no build step.

## Files

| File | Purpose |
|------|---------|
| `src/tui.tsx` | TUI plugin: `sidebar.content` widget, refresh command/keybinding, polling loop, and state handling |
| `src/index.ts` | No-op server plugin (with `tui: true`) so the host resolves the package and auto-loads `src/tui.tsx` |
| `src/usage.ts` | Usage API client (`/zen/go/v1/usage`) and Go API-key resolution (option → env → auth.json) |
| `src/format.ts` | Terse formatting helpers: reset countdowns, relative times, and the progress bar |
| `test/` | `bun test` unit tests for `usage.ts` and `format.ts` (parsing, key resolution, formatters) |

## Limitations

- **Sidebar visibility**: the widget lives in the session sidebar; if the
  sidebar is hidden or the TUI layout doesn't show it, the widget is not
  rendered.
- **Reflects the whole account**: the percentage is account-wide (the same
  numbers as the web console), not per-machine.
- **Unofficial endpoint**: `/zen/go/v1/usage` is not (yet) in the public Go
  docs. It is the endpoint the console uses, but if opencode changes it the
  plugin will need a small update.