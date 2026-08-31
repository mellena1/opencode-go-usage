import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_BASE_URL,
  UsageError,
  clampPercent,
  fetchUsage,
  resolveApiKey,
} from "../src/usage.js";

const originalFetch = globalThis.fetch;

type FetchHandler = (url: unknown, init?: RequestInit) => Promise<Response> | Response;

/** Replace the global fetch for one test; restored in `afterEach`. */
function installFetch(handler: FetchHandler): void {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) =>
    handler(url, init)) as unknown as typeof fetch;
}

let tempDir: string | undefined;

async function withAuthFile(contents: object | string): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "opencode-go-usage-"));
  const file = join(tempDir, "auth.json");
  const body = typeof contents === "string" ? contents : JSON.stringify(contents);
  await writeFile(file, body);
  process.env.OPENCODE_AUTH_JSON = file;
  return file;
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  delete process.env.OPENCODE_API_KEY;
  delete process.env.OPENCODE_AUTH_JSON;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("clampPercent", () => {
  test("passes through in-range values", () => {
    expect(clampPercent(0)).toBe(0);
    expect(clampPercent(12.5)).toBe(12.5);
    expect(clampPercent(100)).toBe(100);
  });

  test("clamps below 0 and above 100", () => {
    expect(clampPercent(-4)).toBe(0);
    expect(clampPercent(150)).toBe(100);
  });

  test("maps non-finite values to 0", () => {
    expect(clampPercent(Number.NaN)).toBe(0);
    expect(clampPercent(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampPercent(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe("resolveApiKey", () => {
  test("prefers the explicit plugin option", async () => {
    const resolved = await resolveApiKey({ apiKey: "  from-option  " });
    expect(resolved).toEqual({ apiKey: "from-option", source: "option" });
  });

  test("ignores a non-string option and falls through", async () => {
    process.env.OPENCODE_API_KEY = "from-env";
    const resolved = await resolveApiKey({ apiKey: 42 });
    expect(resolved).toEqual({ apiKey: "from-env", source: "env" });
  });

  test("reads the OPENCODE_API_KEY environment variable", async () => {
    process.env.OPENCODE_API_KEY = "  from-env ";
    const resolved = await resolveApiKey();
    expect(resolved).toEqual({ apiKey: "from-env", source: "env" });
  });

  test("prefers the opencode-go entry over the legacy opencode entry", async () => {
    await withAuthFile({
      "opencode-go": { key: "go-key" },
      opencode: { key: "legacy-key" },
    });
    const resolved = await resolveApiKey();
    expect(resolved).toEqual({ apiKey: "go-key", source: "auth" });
  });

  test("falls back to the legacy opencode auth entry", async () => {
    await withAuthFile({ opencode: { key: "legacy-key" } });
    const resolved = await resolveApiKey();
    expect(resolved).toEqual({ apiKey: "legacy-key", source: "auth" });
  });

  test("accepts the apiKey field name in auth entries", async () => {
    await withAuthFile({ opencode: { apiKey: "legacy-key" } });
    const resolved = await resolveApiKey();
    expect(resolved).toEqual({ apiKey: "legacy-key", source: "auth" });
  });

  test("returns undefined when no key exists anywhere", async () => {
    await withAuthFile({});
    expect(await resolveApiKey()).toBeUndefined();
  });

  test("returns undefined for a malformed auth file", async () => {
    await withAuthFile("not json");
    expect(await resolveApiKey()).toBeUndefined();
  });

  test("returns undefined when an auth entry has no key", async () => {
    await withAuthFile({ opencode: { type: "Bearer" } });
    expect(await resolveApiKey()).toBeUndefined();
  });

  test("ignores whitespace-only keys", async () => {
    process.env.OPENCODE_API_KEY = "   ";
    await withAuthFile({ opencode: { key: "   " } });
    expect(await resolveApiKey()).toBeUndefined();
  });

  test("returns undefined when the auth file does not exist", async () => {
    process.env.OPENCODE_AUTH_JSON = join(tmpdir(), "no-such-auth.json");
    expect(await resolveApiKey()).toBeUndefined();
  });
});

describe("fetchUsage", () => {
  test("requests the usage endpoint with a bearer token and parses windows", async () => {
    let requestedUrl = "";
    let authHeader = "";
    installFetch((url, init) => {
      requestedUrl = String(url);
      authHeader = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
      return new Response(usageBody({ rolling: 12, weekly: 78, monthly: 94 }), { status: 200 });
    });

    const usage = await fetchUsage("test-key");

    expect(requestedUrl).toBe(`${DEFAULT_BASE_URL}/v1/usage`);
    expect(authHeader).toBe("Bearer test-key");
    expect(usage.rolling?.percent).toBe(12);
    expect(usage.weekly?.percent).toBe(78);
    expect(usage.monthly?.percent).toBe(94);
    expect(usage.rolling?.resetsAt).toBe("2026-09-01T00:00:00Z");
  });

  test("strips trailing slashes from a custom base URL", async () => {
    let requestedUrl = "";
    installFetch((url) => {
      requestedUrl = String(url);
      return new Response(usageBody({ rolling: 1 }), { status: 200 });
    });

    await fetchUsage("test-key", { baseUrl: "https://example.com/go///" });
    expect(requestedUrl).toBe("https://example.com/go/v1/usage");
  });

  test("clamps percent values to 0..100", async () => {
    installFetch(() => new Response(usageBody({ rolling: 150, weekly: -5 }), { status: 200 }));

    const usage = await fetchUsage("test-key");
    expect(usage.rolling?.percent).toBe(100);
    expect(usage.weekly?.percent).toBe(0);
  });

  test("drops an unparseable resetsAt", async () => {
    installFetch(() =>
      new Response(
        JSON.stringify({ usage: { rolling: { status: "ok", percent: 12, resetsAt: "nonsense" } } }),
        { status: 200 },
      ),
    );

    const usage = await fetchUsage("test-key");
    expect(usage.rolling?.percent).toBe(12);
    expect(usage.rolling?.resetsAt).toBeUndefined();
  });

  test("rejects with unauthorized on HTTP 401", async () => {
    installFetch(() => new Response("{}", { status: 401 }));
    const error = await fetchFailure();

    expect(error).toBeInstanceOf(UsageError);
    expect(error.kind).toBe("unauthorized");
  });

  test("rejects with no-subscription on HTTP 403", async () => {
    installFetch(() => new Response("{}", { status: 403 }));

    expect((await fetchFailure()).kind).toBe("no-subscription");
  });

  test("rejects as http for other error statuses and keeps the status", async () => {
    installFetch(() => new Response("{}", { status: 500 }));

    const error = await fetchFailure();
    expect(error.kind).toBe("http");
    expect(error.status).toBe(500);
  });

  test("rejects with bad-response for non-JSON bodies", async () => {
    installFetch(() => new Response("not json", { status: 200 }));

    expect((await fetchFailure()).kind).toBe("bad-response");
  });

  test("rejects with bad-response for unexpected shapes", async () => {
    installFetch(() => new Response(JSON.stringify({ hello: "world" }), { status: 200 }));

    expect((await fetchFailure()).kind).toBe("bad-response");
  });

  test("rejects as network when the request itself throws", async () => {
    installFetch(() => {
      throw new TypeError("boom");
    });

    expect((await fetchFailure()).kind).toBe("network");
  });
});

async function fetchFailure(): Promise<UsageError> {
  try {
    await fetchUsage("test-key");
  } catch (error) {
    if (error instanceof UsageError) return error;
    throw error;
  }
  throw new Error("fetchUsage unexpectedly succeeded");
}

function usageBody(percents: Record<string, number>): string {
  const windows: Record<string, unknown> = {};
  for (const [key, percent] of Object.entries(percents)) {
    windows[key] = { status: "ok", percent, resetsAt: "2026-09-01T00:00:00Z" };
  }
  return JSON.stringify({ usage: windows });
}