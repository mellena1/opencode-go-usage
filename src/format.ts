/**
 * Small, dependency-free formatting helpers for the sidebar widget.
 * All output targets a ~36-column sidebar, so strings stay terse.
 */

/** Renders a countdown to a reset time (ms until reset) as "2h 15m", "3d 4h", "just now". */
export function formatCountdown(now: number, resetsAt: string | undefined): string {
  if (!resetsAt) return "";
  const target = Date.parse(resetsAt);
  if (!Number.isFinite(target)) return "";
  const remainingMs = target - now;
  if (remainingMs <= 0) return "resets now";
  const minutes = Math.max(1, Math.round(remainingMs / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const minutePart = minutes % 60;
    return minutePart === 0 ? `${hours}h` : `${hours}h ${minutePart}m`;
  }
  const days = Math.floor(hours / 24);
  const hourPart = hours % 24;
  return hourPart === 0 ? `${days}d` : `${days}d ${hourPart}h`;
}

/** Renders how long ago a snapshot was taken: "just now", "3m ago", "2h ago". */
export function formatRelative(now: number, then: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

/** A trimmed unicode progress bar; percent is clamped to 0..100. */
export function progressBar(percent: number, width: number): string {
  const clamped = Number.isFinite(percent)
    ? Math.max(0, Math.min(100, percent))
    : 0;
  const filled = Math.round((clamped / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}