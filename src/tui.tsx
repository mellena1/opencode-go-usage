/** @jsxImportSource @opentui/solid */
import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
import { Plugin } from "@opencode-ai/plugin/tui";
import type { Context } from "@opencode-ai/plugin/tui/context";
import type { ResolvedTheme } from "@opencode-ai/theme/tui";
import {
  UsageError,
  clampPercent,
  fetchUsage,
  resolveApiKey,
  type GoUsage,
  type UsageWindow,
} from "./usage.js";
import { formatCountdown, formatRelative, progressBar } from "./format.js";

const BAR_WIDTH = 12;
const DEFAULT_REFRESH_SECONDS = 300; // 5 minutes
const MIN_REFRESH_SECONDS = 30;
const TICK_MS = 30_000; // countdown/relative time refresh granularity
const FETCH_TIMEOUT_MS = 15_000;

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
  /** Timestamp of the last successful fetch. */
  at?: number;
}

/** Live usage widget rendered into the session sidebar. */
function UsageWidget(props: {
  widget: () => WidgetState;
  now: () => number;
  theme: ResolvedTheme;
  keymap: Pick<Context["keymap"], "layer">;
  refreshKey: string | false;
  refresh: () => void;
}): JSX.Element {
  const theme = props.theme;

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

  const state = createMemo(() => props.widget());
  const now = createMemo(() => props.now());

  const rows = createMemo(() => {
    const usage = state().usage;
    if (!usage) return undefined;
    return WINDOW_KEYS.map((window) => ({
      label: window.label,
      window: usage[window.key],
    }));
  });

  const maxPercent = createMemo(() => {
    const usage = state().usage;
    if (!usage) return undefined;
    const percents = [usage.rolling?.percent, usage.weekly?.percent, usage.monthly?.percent]
      .filter((value): value is number => typeof value === "number");
    return percents.length > 0 ? Math.max(...percents) : undefined;
  });

  const level = createMemo((): Level => {
    const max = maxPercent();
    if (max === undefined) return "none";
    if (max >= 90) return "error";
    if (max >= 70) return "warning";
    return "ok";
  });

  const dot = createMemo(() => {
    const s = state();
    if (s.status === "loading") return theme.text.subdued;
    if (s.status === "no-key") return theme.text.subdued;
    if (s.status === "error" && !s.usage) return theme.text.feedback.error.default;
    switch (level()) {
      case "ok":
        return theme.text.feedback.success.default;
      case "warning":
        return theme.text.feedback.warning.default;
      case "error":
        return theme.text.feedback.error.default;
      default:
        return theme.text.subdued;
    }
  });

  const relative = createMemo(() => {
    const at = state().at;
    return at !== undefined ? formatRelative(now(), at) : "";
  });

  const fallback = createMemo(() => {
    const s = state();
    if (s.status === "loading") return "Loading…";
    if (s.status === "no-key") return NOT_CONFIGURED_HINT;
    return s.error ?? "Unavailable";
  });

  // A muted note shown alongside (or in place of) the usage rows when the
  // provider is not configured or a refresh failed after prior success.
  const note = createMemo(() => {
    const s = state();
    if (s.status === "no-key") return NOT_CONFIGURED_HINT;
    if (s.status === "error" && s.usage) return s.error ?? "";
    return "";
  });

  return (
    <Show when={state().status !== "no-key"}>
      <box>
        <box flexDirection="row" gap={1}>
          <text fg={dot()}>●</text>
          <text fg={theme.text.default}>
            <b>Go usage</b>
          </text>
          <text fg={theme.text.subdued}>{relative()}</text>
        </box>
        <Show
          when={rows() !== undefined}
          fallback={
            <text fg={theme.text.subdued} wrapMode="none">
              {fallback()}
            </text>
          }
        >
          <For each={rows()}>
            {(row) => (
              <WindowRow label={row.label} window={row.window} now={now} theme={theme} />
            )}
          </For>
        </Show>
        {note() !== "" ? (
          <text fg={theme.text.subdued} wrapMode="none">
            {note()}
          </text>
        ) : null}
      </box>
    </Show>
  );
}

function WindowRow(props: {
  label: string;
  window: UsageWindow | undefined;
  now: () => number;
  theme: ResolvedTheme;
}): JSX.Element {
  const theme = props.theme;

  const view = createMemo(() => {
    const raw = props.window?.percent;
    const percent =
      typeof raw === "number" ? Math.round(clampPercent(raw)) : undefined;
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
    return {
      percent,
      color,
      bar: percent === undefined ? "" : progressBar(percent, BAR_WIDTH),
    };
  });

  const countdown = createMemo(() =>
    formatCountdown(props.now(), props.window?.resetsAt),
  );

  return (
    <box flexDirection="row" gap={1}>
      <text fg={theme.text.subdued} width={3} wrapMode="none">
        {props.label}
      </text>
      <text fg={view().color} width={4} wrapMode="none">
        {view().percent === undefined ? "—" : `${view().percent}%`}
      </text>
      <text fg={view().color} wrapMode="none">
        {view().bar}
      </text>
      <text fg={theme.text.subdued} wrapMode="none">
        {countdown()}
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

    const [widget, setWidget] = createSignal<WidgetState>({ status: "loading" });
    const [nowMs, setNow] = createSignal(Date.now());

    // `generation` guards against out-of-order results: a slow fetch finishing
    // after a newer one (or after cleanup) is discarded.
    let generation = 0;
    let notified: string | null = null;

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

      let key: Awaited<ReturnType<typeof resolveApiKey>>;
      try {
        key = await resolveApiKey(options);
      } catch {
        key = undefined;
      }
      if (current !== generation) return;

      if (!key) {
        // Not an operational error — just nothing to show until Go is set up.
        setWidget((prev) => ({
          status: "no-key",
          usage: prev.usage,
          at: prev.at,
        }));
        return;
      }

      try {
        const usage = await fetchUsage(key.apiKey, {
          baseUrl,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (current !== generation) return;
        notified = null;
        setWidget({
          status: "ok",
          usage,
          at: Date.now(),
        });
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
        setWidget((prev) => ({
          status: "error",
          error: message,
          usage: prev.usage,
          at: prev.at,
        }));
      }
    }

    void refresh();
    const timer = setInterval(() => void refresh(), refreshMs);
    const tick = setInterval(() => setNow(Date.now()), TICK_MS);

    const dispose = ctx.ui.slot({
      append: "sidebar.content",
      render: () => (
        <UsageWidget
          widget={widget}
          now={nowMs}
          theme={ctx.theme}
          keymap={ctx.keymap}
          refreshKey={refreshKey}
          refresh={() => void refresh()}
        />
      ),
    });

    return () => {
      generation++;
      clearInterval(timer);
      clearInterval(tick);
      dispose();
    };
  },
});