import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * OpenCode Go quota client.
 *
 * Go exposes an official (undocumented) usage endpoint that the web dashboard
 * is built on: `GET https://opencode.ai/zen/go/v1/usage` authenticated with the
 * regular Go API key (`Authorization: Bearer <key>`). It reports the used
 * percentage and reset time for each of the three subscription windows
 * (rolling 5h / weekly / monthly) as the same numbers the dashboard shows.
 */

/** One quota window as reported by the usage endpoint. */
export interface UsageWindow {
  status?: string;
  percent?: number;
  resetsAt?: string;
}

/** The three OpenCode Go subscription quota windows. */
export interface GoUsage {
  rolling?: UsageWindow;
  weekly?: UsageWindow;
  monthly?: UsageWindow;
}

export const DEFAULT_BASE_URL = "https://opencode.ai/zen/go";

/** Hard deadline for one usage request, covering both the request and the response body read. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** A resolved API key plus where it came from (for diagnostics). */
export interface ResolvedKey {
  apiKey: string;
  source: "option" | "env" | "auth";
}

export type UsageErrorKind =
  | "no-key"
  | "config"
  | "unauthorized"
  | "no-subscription"
  | "bad-response"
  | "network"
  | "http";

export class UsageError extends Error {
  readonly kind: UsageErrorKind;
  readonly status?: number;

  constructor(kind: UsageErrorKind, message: string, status?: number) {
    super(message);
    this.name = "UsageError";
    this.kind = kind;
    this.status = status;
  }
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/**
 * Resolve the OpenCode Go API key, mirroring opencode's own resolution order:
 * plugin option → `OPENCODE_API_KEY` env → auth.json (`opencode-go`, then
 * `opencode` fallback).
 */
export async function resolveApiKey(
  options: Readonly<Record<string, any>> = {},
): Promise<ResolvedKey | undefined> {
  const fromOption = options.apiKey;
  if (typeof fromOption === "string" && fromOption.trim()) {
    return { apiKey: fromOption.trim(), source: "option" };
  }

  const fromEnv = process.env.OPENCODE_API_KEY;
  if (fromEnv && fromEnv.trim()) {
    return { apiKey: fromEnv.trim(), source: "env" };
  }

  const auth = await readAuthFile();
  if (auth) {
    // Both keys are Go-compatible; the dedicated `opencode-go` entry wins.
    for (const provider of ["opencode-go", "opencode"] as const) {
      const entry = auth[provider];
      if (!entry || typeof entry !== "object") continue;
      const key =
        typeof entry.key === "string"
          ? entry.key
          : typeof entry.apiKey === "string"
            ? entry.apiKey
            : undefined;
      if (key && key.trim()) return { apiKey: key.trim(), source: "auth" };
    }
  }

  return undefined;
}

/**
 * Fetch the usage windows for the current subscription.
 *
 * The whole exchange — request and body read — is bounded by `timeoutMs`, so
 * this never hangs: a response whose body stalls after the headers arrive is
 * abandoned like any other network failure.
 */
export async function fetchUsage(
  apiKey: string,
  options: { baseUrl?: string; timeoutMs?: number } = {},
): Promise<GoUsage> {
  const baseUrl = assertSecureBaseUrl(
    stripTrailingSlashes(
      (options.baseUrl ?? DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL,
    ),
  );
  const url = `${baseUrl}/v1/usage`;

  const timeoutMs =
    typeof options.timeoutMs === "number" &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  // One deadline for both phases of the exchange, enforced with a plain timer:
  // `AbortSignal.timeout` listeners do not reliably fire inside the TUI's
  // embedded runtime when a fetch stalls, which wedged 0.1.0's "Loading…"
  // state, so settlement must not depend on signal dispatch. The abort signal
  // still frees the socket where the runtime supports it.
  const deadline = AbortSignal.timeout(timeoutMs);
  const timeoutMessage = `OpenCode Go usage request did not respond within ${timeoutMs}ms`;

  let response: globalThis.Response;
  try {
    response = await withTimeout(
      fetch(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        // Never follow a redirect with the bearer token attached; if the host
        // ever replies 3xx (e.g. after a compromise or DNS hijack), fail closed.
        redirect: "error",
        signal: deadline,
      }),
      timeoutMs,
      timeoutMessage,
    );
  } catch (error) {
    if (error instanceof UsageError) throw error; // the deadline fired
    // The deadline may have fired just as the fetch's own AbortError landed,
    // so report a timeout when the deadline is over, a plain network failure
    // otherwise.
    throw new UsageError("network", deadline.aborted ? timeoutMessage : `Could not reach ${url}`);
  }

  // Go rejects unknown keys with an SPA-free 401 JSON body like
  // `{ "type":"error", "error":{ "type":"AuthError", ... } }`.
  if (response.status === 401) {
    throw new UsageError("unauthorized", "OpenCode Go API key was rejected (HTTP 401)");
  }
  // A valid key without a Go subscription returns 403 EntitlementError.
  if (response.status === 403) {
    throw new UsageError("no-subscription", "No OpenCode Go subscription on this key (HTTP 403)");
  }
  if (!response.ok) {
    throw new UsageError(
      "http",
      `OpenCode Go usage endpoint returned HTTP ${response.status}`,
      response.status,
    );
  }

  let body: unknown;
  try {
    body = await withTimeout(response.json(), timeoutMs, timeoutMessage);
  } catch (error) {
    if (error instanceof UsageError) throw error; // the deadline fired mid-body
    throw new UsageError("bad-response", "OpenCode Go usage response was not valid JSON");
  }

  const usage = parseUsage(body);
  if (!usage) {
    throw new UsageError(
      "bad-response",
      "OpenCode Go usage response did not match the expected shape",
    );
  }
  return usage;
}

/**
 * Settle `task` no later than `timeoutMs`, rejecting with a "network"
 * `UsageError` carrying `timeoutMessage` if the timer fires first. The timer is
 * cleared once the task settles. A plain `setTimeout` is used instead of an
 * `AbortSignal` listener because signal dispatch does not reliably fire inside
 * the TUI's embedded runtime on a stalled fetch — a hung call must still
 * settle so the widget can never stay on "Loading…".
 */
function withTimeout<T>(task: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new UsageError("network", timeoutMessage)), timeoutMs);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function parseUsage(body: unknown): GoUsage | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const usage = (body as Record<string, unknown>).usage;
  if (typeof usage !== "object" || usage === null) return undefined;

  const record = usage as Record<string, unknown>;
  const result: GoUsage = {};
  let found = false;
  for (const key of ["rolling", "weekly", "monthly"] as const) {
    const raw = record[key];
    if (typeof raw !== "object" || raw === null) continue;
    const window = raw as Record<string, unknown>;
    const percent = typeof window.percent === "number" ? clampPercent(window.percent) : undefined;
    const resetsAt =
      typeof window.resetsAt === "string" &&
      !Number.isNaN(Date.parse(window.resetsAt))
        ? window.resetsAt
        : undefined;
    result[key] = {
      status: typeof window.status === "string" ? window.status : undefined,
      percent,
      resetsAt,
    };
    found = true;
  }

  return found ? result : undefined;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * The API key is a credential, so it must only ever be sent over TLS. `http://`
 * is tolerated solely for localhost/loopback, which the `baseUrl` option exists
 * for (local testing against a mock server, for example).
 */
function assertSecureBaseUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new UsageError("config", `Invalid baseUrl: "${baseUrl}"`);
  }
  if (parsed.protocol === "https:") return baseUrl;
  if (parsed.protocol === "http:") {
    const host = parsed.hostname.toLowerCase();
    const isLoopback =
      host === "localhost" ||
      host === "::1" ||
      /^127(?:\.\d{1,3}){3}$/.test(host);
    if (isLoopback) return baseUrl;
  }
  throw new UsageError(
    "config",
    "baseUrl must use https; http is only allowed for localhost/loopback",
  );
}

type AuthEntry = { key?: unknown; apiKey?: unknown; [key: string]: unknown };
type AuthFile = Record<string, AuthEntry>;

/**
 * The credential file opencode's `auth login` writes to:
 * `~/.local/share/opencode/auth.json` (Linux), `~/Library/Application
 * Support/opencode/auth.json` (macOS), `%LOCALAPPDATA%\opencode\auth.json`
 * (Windows), or `$OPENCODE_AUTH_JSON` when set.
 */
function authFilePath(): string | undefined {
  if (process.env.OPENCODE_AUTH_JSON?.trim()) {
    return process.env.OPENCODE_AUTH_JSON.trim();
  }
  const home = homedir();
  switch (process.platform) {
    case "win32":
      return join(
        process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
        "opencode",
        "auth.json",
      );
    case "darwin":
      return join(home, "Library", "Application Support", "opencode", "auth.json");
    default:
      return join(
        process.env.XDG_DATA_HOME?.trim() || join(home, ".local", "share"),
        "opencode",
        "auth.json",
      );
  }
}

async function readAuthFile(): Promise<AuthFile | undefined> {
  const file = authFilePath();
  if (!file) return undefined;
  try {
    const raw = await readFile(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as AuthFile;
  } catch {
    return undefined;
  }
}