import { describe, expect, test } from "bun:test";
import { formatCountdown, formatRelative, progressBar } from "../src/format.js";

const NOW = Date.parse("2026-08-31T12:00:00Z");

function inMs(ms: number): string {
  return new Date(NOW + ms).toISOString();
}

describe("formatCountdown", () => {
  test("returns an empty string without a reset time", () => {
    expect(formatCountdown(NOW, undefined)).toBe("");
  });

  test("returns an empty string for an unparseable reset time", () => {
    expect(formatCountdown(NOW, "not-a-date")).toBe("");
  });

  test("reports an immediate reset when the window already elapsed", () => {
    expect(formatCountdown(NOW, "2026-01-01T00:00:00Z")).toBe("resets now");
  });

  test("shows minutes for sub-hour windows", () => {
    expect(formatCountdown(NOW, inMs(2 * 60_000))).toBe("2m");
  });

  test("rounds up to a minimum of one minute", () => {
    expect(formatCountdown(NOW, inMs(5_000))).toBe("1m");
  });

  test("shows hours and minutes below a day", () => {
    expect(formatCountdown(NOW, inMs(2 * 3_600_000 + 15 * 60_000))).toBe("2h 15m");
  });

  test("omits the minute part when it is zero", () => {
    expect(formatCountdown(NOW, inMs(3 * 3_600_000))).toBe("3h");
  });

  test("shows days and hours at day granularity", () => {
    expect(formatCountdown(NOW, inMs((2 * 24 + 4) * 3_600_000))).toBe("2d 4h");
  });

  test("omits the hour part when it is zero", () => {
    expect(formatCountdown(NOW, inMs(3 * 24 * 3_600_000))).toBe("3d");
  });
});

describe("formatRelative", () => {
  test("is 'just now' within a minute", () => {
    expect(formatRelative(NOW, NOW - 30_000)).toBe("just now");
  });

  test("is 'just now' for a future timestamp", () => {
    expect(formatRelative(NOW, NOW + 60_000)).toBe("just now");
  });

  test("shows minutes below an hour", () => {
    expect(formatRelative(NOW, NOW - 12 * 60_000)).toBe("12m ago");
  });

  test("shows hours from an hour up", () => {
    expect(formatRelative(NOW, NOW - 2 * 3_600_000)).toBe("2h ago");
  });
});

describe("progressBar", () => {
  test("renders a full bar at 100%", () => {
    expect(progressBar(100, 12)).toBe("█".repeat(12));
  });

  test("renders an empty bar at 0%", () => {
    expect(progressBar(0, 12)).toBe("░".repeat(12));
  });

  test("hard-clamps values above 100", () => {
    expect(progressBar(150, 12)).toBe("█".repeat(12));
  });

  test("hard-clamps negative values", () => {
    expect(progressBar(-20, 12)).toBe("░".repeat(12));
  });

  test("treats non-finite percentages as 0", () => {
    expect(progressBar(Number.NaN, 12)).toBe("░".repeat(12));
    expect(progressBar(Number.POSITIVE_INFINITY, 12)).toBe("░".repeat(12));
  });

  test("is always exactly width long", () => {
    for (const percent of [0, 1, 33, 50, 66.6, 99, 100]) {
      expect(progressBar(percent, 12)).toHaveLength(12);
    }
  });

  test("fills proportionally", () => {
    expect(progressBar(50, 12)).toBe("██████░░░░░░");
  });
});