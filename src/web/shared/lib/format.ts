// Formatting helpers for pretty-printing values and rendering readable relative timestamps.

// Render any value as display text: strings pass through, the rest become indented JSON.
export function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

// Format an elapsed timestamp as a short English relative label.
export function relativeTime(timestamp: number): string {
  const diff = Math.max(0, Date.now() - timestamp);
  if (diff < 60_000) return "Just now"; if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(timestamp).toLocaleDateString("en", { month: "short", day: "numeric" });
}
