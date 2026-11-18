import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_BASE_URL,
  UsageError,
  clampPercent,
  fetchUsage,
  resolveExplicitApiKey,
} from "../src/usage.js";

const originalFetch = globalThis.fetch;

type FetchHandler = (url: unknown, init?: RequestInit) => Promise<Response> | Response;

/** Replace the global fetch for one test; restored in `afterEach`. */
function installFetch(handler: FetchHandler): void {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) =>
    handler(url, init)) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.OPENCODE_API_KEY;
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

describe("resolveExplicitApiKey", () => {
  test("prefers the explicit plugin option", () => {
    expect(resolveExplicitApiKey({ apiKey: "  from-option  " })).toEqual({
      apiKey: "from-option",
      source: "option",
    });
  });

  test("ignores a non-string option and falls through to the env var", () => {
    process.env.OPENCODE_API_KEY = "from-env";
    expect(resolveExplicitApiKey({ apiKey: 42 })).toEqual({
      apiKey: "from-env",
      source: "env",
    });
  });

  test("reads the OPENCODE_API_KEY environment variable", () => {
    process.env.OPENCODE_API_KEY = "  from-env ";
    expect(resolveExplicitApiKey()).toEqual({ apiKey: "from-env", source: "env" });
  });

  test("returns undefined when no key is configured", () => {
    expect(resolveExplicitApiKey()).toBeUndefined();
  });

  test("ignores whitespace-only keys", () => {
    process.env.OPENCODE_API_KEY = "   ";
    expect(resolveExplicitApiKey()).toBeUndefined();
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

  test("refuses a plain-http base URL so the key is never sent in cleartext", async () => {
    const error = await fetchUsage("test-key", {
      baseUrl: "http://usage.example.com",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).kind).toBe("config");
  });

  test("allows http only for localhost and loopback addresses", async () => {
    for (const baseUrl of ["http://localhost:8787", "http://127.0.0.1:8787"]) {
      let requestedUrl = "";
      installFetch((url) => {
        requestedUrl = String(url);
        return new Response(usageBody({ rolling: 1 }), { status: 200 });
      });
      await fetchUsage("test-key", { baseUrl });
      expect(requestedUrl).toBe(`${baseUrl}/v1/usage`);
    }
  });

  test("rejects an unparseable base URL", async () => {
    const error = await fetchUsage("test-key", { baseUrl: "not a url" }).catch(
      (caught: unknown) => caught,
    );

    expect((error as UsageError).kind).toBe("config");
  });

  test("does not follow redirects, so the bearer token is never forwarded", async () => {
    let redirectSetting: string | undefined;
    installFetch((_url, init) => {
      redirectSetting = init?.redirect;
      return new Response(usageBody({ rolling: 1 }), { status: 200 });
    });

    await fetchUsage("test-key");
    expect(redirectSetting).toBe("error");
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

  test("abandons a request that never responds, instead of hanging", async () => {
    // Simulates a connect/DNS/keep-alive stall: fetch itself never settles.
    installFetch(() => new Promise<Response>(() => {}));

    const started = Date.now();
    const error = await fetchFailure({ timeoutMs: 250 });
    const elapsed = Date.now() - started;

    expect(error.kind).toBe("network");
    expect(error.message).toMatch(/did not respond within 250ms/);
    expect(elapsed).toBeLessThan(5_000);
  });

  test("abandons a response body that never finishes, instead of hanging", async () => {
    // Headers arrive, but the body stream never closes: `response.json()`
    // would wait forever without the deadline.
    installFetch(() => new Response(stalledBody(), { status: 200 }));

    const started = Date.now();
    const error = await fetchFailure({ timeoutMs: 250 });
    const elapsed = Date.now() - started;

    expect(error.kind).toBe("network");
    expect(error.message).toMatch(/did not respond within 250ms/);
    expect(elapsed).toBeLessThan(5_000);
  });

  test("falls back to the default timeout for non-positive timeoutMs", async () => {
    let requestedUrl = "";
    installFetch((url) => {
      requestedUrl = String(url);
      return new Response(usageBody({ rolling: 1 }), { status: 200 });
    });

    const usage = await fetchUsage("test-key", { timeoutMs: -5 });
    expect(usage.rolling?.percent).toBe(1);
    expect(requestedUrl).toBe(`${DEFAULT_BASE_URL}/v1/usage`);
  });
});

async function fetchFailure(
  options: Parameters<typeof fetchUsage>[1] = {},
): Promise<UsageError> {
  try {
    await fetchUsage("test-key", options);
  } catch (error) {
    if (error instanceof UsageError) return error;
    throw error;
  }
  throw new Error("fetchUsage unexpectedly succeeded");
}

/** A response body that sends a partial chunk and never closes. */
function stalledBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"usage":'));
    },
  });
}

function usageBody(percents: Record<string, number>): string {
  const windows: Record<string, unknown> = {};
  for (const [key, percent] of Object.entries(percents)) {
    windows[key] = { status: "ok", percent, resetsAt: "2026-09-01T00:00:00Z" };
  }
  return JSON.stringify({ usage: windows });
}