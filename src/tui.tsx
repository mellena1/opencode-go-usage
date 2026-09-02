/** @jsxImportSource @opentui/solid */
import { For, type JSX } from "solid-js";
import { Plugin } from "@opencode-ai/plugin/tui";
import type { Context } from "@opencode-ai/plugin/tui/context";
import type { ResolvedTheme } from "@opencode-ai/theme/tui";
import {
  DEFAULT_TIMEOUT_MS,
  UsageError,
  clampPercent,
  fetchUsage,
  resolveApiKey,
  type GoUsage,
  type UsageWindow,
} from "./usage.js";
import { formatCountdown, progressBar } from "./format.js";

const BAR_WIDTH = 12;
const DEFAULT_REFRESH_SECONDS = 300; // 5 minutes
const MIN_REFRESH_SECONDS = 30;
const WATCHDOG_MS = 10_000; // how often the refresh watchdog re-checks
const WATCHDOG_SLACK_MS = 5_000; // grace beyond the fetch deadline before a refresh is declared wedged

const WINDOW_KEYS: ReadonlyArray<{ key: keyof GoUsage; label: string }> = [
  { key: "rolling", label: "5h" },
  { key: "weekly", label: "wk" },
  { key: "monthly", label: "mo" },
];

const NOT_CONFIGURED_HINT =
  "opencode-go not configured — set options.apiKey, export OPENCODE_API_KEY, or opencode auth login";

type Level = "none" | "ok" | "warning" | "error";

type WidgetStatus = "loading" | "ok" | "no-key" | "error";

interface WidgetState {
  status: WidgetStatus;
  usage?: GoUsage;
  error?: string;
}

/**
 * Registers the refresh command for the whole TUI lifetime. It exists only to
 * own the keymap layer: `keymap.layer` must be called from inside the TUI
 * component tree (setup runs outside it, and the Keymap.Provider is
 * unavailable there). The `app` slot is the root boundary, mounted for as long
 * as the TUI is up. Note that on betas where the host cannot repaint plugin
 * signals (anomalyco/opencode#39986) the layer may never become active — the
 * refresh still happens through the timer-driven remount in `setup`.
 */
function CommandHost(props: {
  keymap: Pick<Context["keymap"], "layer">;
  refreshKey: string | false;
  refresh: () => void;
}): JSX.Element {
  props.keymap.layer(() => ({
    mode: "base",
    commands: [
      {
        id: "go-usage.refresh",
        title: "Refresh OpenCode Go usage",
        group: "Go usage",
        palette: true,
        bind: props.refreshKey,
        run: () => {
          props.refresh();
        },
      },
    ],
  }));
  // Renders nothing; just keeps the layer registered.
  return <box />;
}

/**
 * Usage widget rendered into the session sidebar.
 *
 * Deliberately stateless: every value is derived once, at mount time, from an
 * immutable `state` snapshot. On the packaged CLI the host repaints a plugin's
 * initial frame but not its later signal updates (the plugin and host run
 * separate reactive graphs — anomalyco/opencode#39986), so this plugin never
 * *relies* on reactive updates: `setup` remounts the claim with a fresh
 * snapshot whenever data changes instead. Remounting is a fresh initial paint,
 * which always works.
 *
 * To keep the sidebar layout stable, the widget always renders the same
 * structure — header, three window rows, and a status line — regardless of
 * state, so a remount never changes its footprint.
 */
function UsageWidget(props: {
  state: WidgetState;
  theme: ResolvedTheme;
}): JSX.Element {
  const theme = props.theme;
  const s = props.state;
  const usage = s.usage;

  const maxPercent = (() => {
    if (!usage) return undefined;
    const percents = [usage.rolling?.percent, usage.weekly?.percent, usage.monthly?.percent]
      .filter((value): value is number => typeof value === "number");
    return percents.length > 0 ? Math.max(...percents) : undefined;
  })();

  const level: Level = (() => {
    const max = maxPercent;
    if (max === undefined) return "none";
    if (max >= 90) return "error";
    if (max >= 70) return "warning";
    return "ok";
  })();

  const dot = (() => {
    if (s.status === "loading") return theme.text.subdued;
    if (s.status === "no-key") return theme.text.subdued;
    if (s.status === "error" && !usage) return theme.text.feedback.error.default;
    switch (level) {
      case "ok":
        return theme.text.feedback.success.default;
      case "warning":
        return theme.text.feedback.warning.default;
      case "error":
        return theme.text.feedback.error.default;
      default:
        return theme.text.subdued;
    }
  })();

  // The bottom status line: a hint, the failure reason, or nothing at all.
  const statusLine = (() => {
    if (s.status === "no-key") return NOT_CONFIGURED_HINT;
    if (s.status === "loading") return "Loading…";
    if (s.status === "error") return s.error ?? "Unavailable";
    return "";
  })();

  return (
    <box>
      <box flexDirection="row" gap={1}>
        <text fg={dot}>●</text>
        <text fg={theme.text.default}>
          <b>Go usage</b>
        </text>
      </box>
      <For each={WINDOW_KEYS}>
        {(window) => <WindowRow label={window.label} window={usage?.[window.key]} theme={theme} />}
      </For>
      {statusLine !== "" ? (
        <text fg={theme.text.subdued} wrapMode="none">
          {statusLine}
        </text>
      ) : null}
    </box>
  );
}

function WindowRow(props: {
  label: string;
  window: UsageWindow | undefined;
  theme: ResolvedTheme;
}): JSX.Element {
  const theme = props.theme;

  const raw = props.window?.percent;
  const percent = typeof raw === "number" ? Math.round(clampPercent(raw)) : undefined;
  const level: Level =
    percent === undefined
      ? "none"
      : percent >= 90
        ? "error"
        : percent >= 70
          ? "warning"
          : "ok";
  const color =
    level === "ok"
      ? theme.text.feedback.success.default
      : level === "warning"
        ? theme.text.feedback.warning.default
        : level === "error"
          ? theme.text.feedback.error.default
          : theme.text.subdued;

  return (
    <box flexDirection="row" gap={1}>
      <text fg={theme.text.subdued} width={3} wrapMode="none">
        {props.label}
      </text>
      <text fg={color} width={4} wrapMode="none">
        {percent === undefined ? "—" : `${percent}%`}
      </text>
      <text fg={color} wrapMode="none">
        {percent === undefined ? "" : progressBar(percent, BAR_WIDTH)}
      </text>
      <text fg={theme.text.subdued} wrapMode="none">
        {formatCountdown(Date.now(), props.window?.resetsAt)}
      </text>
    </box>
  );
}

function refreshIntervalMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_REFRESH_SECONDS * 1000;
  }
  return Math.max(MIN_REFRESH_SECONDS, Math.round(value)) * 1000;
}

export default Plugin.define({
  id: "opencode-go-usage",
  setup: (ctx) => {
    const options = ctx.options as Readonly<Record<string, any>>;
    const baseUrl =
      typeof options.baseUrl === "string" && options.baseUrl.trim()
        ? options.baseUrl.trim()
        : undefined;
    const refreshMs = refreshIntervalMs(options.refreshSeconds);
    const keybinds = (options.keybinds as Record<string, unknown> | undefined) ?? {};
    const refreshKey: string | false =
      typeof keybinds.refresh === "string" && keybinds.refresh.trim()
        ? keybinds.refresh.trim()
        : keybinds.refresh === false
          ? false
          : "ctrl+alt+g";

    /**
     * The widget's state lives here, outside Solid: snapshots are passed to
     * the slot claim by value and the claim is remounted whenever anything
     * changes. Reactive signal writes do not repaint on the packaged CLI
     * (anomalyco/opencode#39986), but mount-time JSX evaluation and host
     * claim mounting do — so this plugin paints by remounting.
     *
     * Remounts are deliberately rare — only when data actually changes (a
     * completed refresh, a watchdog hit, a status transition), roughly once
     * per refresh interval — so the sidebar layout stays put.
     */
    let last: WidgetState | null = null;
    let disposeWidget: (() => void) | null = null;

    function renderWidget(): void {
      disposeWidget?.();
      disposeWidget = null;
      if (last === null) {
        // Nothing fetched yet — show the loading placeholder so the sidebar
        // doesn't start out empty.
        disposeWidget = ctx.ui.slot({
          append: "sidebar.content",
          render: () => <UsageWidget state={{ status: "loading" }} theme={ctx.theme} />,
        });
        return;
      }
      if (last.status === "no-key") return; // not configurable — hide entirely
      const state = last;
      disposeWidget = ctx.ui.slot({
        append: "sidebar.content",
        render: () => <UsageWidget state={state} theme={ctx.theme} />,
      });
    }

    // `generation` guards against out-of-order results: a slow fetch finishing
    // after a newer one (or after cleanup) is discarded.
    let generation = 0;
    let notified: string | null = null;
    /** Start time of the newest refresh, used by the watchdog below. */
    let refreshStartedAt = 0;

    function notify(message: string): void {
      if (notified === message) return;
      notified = message;
      ctx.ui.toast.show({
        variant: "error",
        title: "Go usage",
        message,
        duration: 6000,
      });
    }

    async function refresh(): Promise<void> {
      const current = ++generation;
      refreshStartedAt = Date.now();

      let key: Awaited<ReturnType<typeof resolveApiKey>>;
      try {
        key = await resolveApiKey(options);
      } catch {
        key = undefined;
      }
      if (current !== generation) return;

      if (!key) {
        // Not an operational error — just nothing to show until Go is set up.
        refreshStartedAt = 0;
        last = { status: "no-key" };
        renderWidget();
        return;
      }

      try {
        const usage = await fetchUsage(key.apiKey, { baseUrl });
        if (current !== generation) return;
        notified = null;
        refreshStartedAt = 0;
        last = { status: "ok", usage };
        renderWidget();
      } catch (error) {
        if (current !== generation) return;
        const message =
          error instanceof UsageError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        notify(message);
        // Keep showing the last known values when a refresh fails.
        refreshStartedAt = 0;
        last = { status: "error", error: message, usage: last?.usage };
        renderWidget();
      }
    }

    // The refresh command lives on its own `app`-slot claim (mounted for the
    // whole TUI lifetime), not inside the sidebar widget.
    const disposeCommands = ctx.ui.slot({
      append: "app",
      render: () => (
        <CommandHost
          keymap={ctx.keymap}
          refreshKey={refreshKey}
          refresh={() => void refresh()}
        />
      ),
    });

    renderWidget();
    void refresh();
    const timer = setInterval(() => void refresh(), refreshMs);

    // Last-resort safety net: if a refresh ever fails to settle (a pathological
    // runtime stall beyond the fetch deadline), force the widget out of the
    // "Loading…" state instead of leaving it stuck forever.
    const watchdog = setInterval(() => {
      if (refreshStartedAt === 0) return;
      if (Date.now() - refreshStartedAt <= DEFAULT_TIMEOUT_MS + WATCHDOG_SLACK_MS) return;
      generation++; // discard the wedged refresh's late completion
      refreshStartedAt = 0;
      const message = "OpenCode Go usage refresh timed out";
      notify(message);
      last = { status: "error", error: message, usage: last?.usage };
      renderWidget();
    }, WATCHDOG_MS);

    return () => {
      generation++;
      clearInterval(timer);
      clearInterval(watchdog);
      disposeWidget?.();
      disposeCommands();
    };
  },
});