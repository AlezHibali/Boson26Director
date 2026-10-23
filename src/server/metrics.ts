export const operations = [
  "realtime_session",
  "tts_headers",
  "avatar_submit",
  "avatar_poll",
  "avatar_content_headers",
  "avatar_total",
] as const;
export type Operation = (typeof operations)[number];
export type MetricInput = {
  operation: Operation;
  durationMs: number;
  outcome: "ok" | "error";
};
export type Metric = MetricInput & { at: string };
const state = globalThis as unknown as { directorMetrics?: Metric[] };
export function recordMetric(value: MetricInput) {
  if (
    !operations.includes(value.operation) ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0 ||
    !["ok", "error"].includes(value.outcome)
  )
    return;
  const rows = (state.directorMetrics ||= []);
  // Reconstruct the DTO so caller-supplied keys, URLs and payloads never enter diagnostics.
  rows.push({
    operation: value.operation,
    durationMs: Math.round(value.durationMs),
    outcome: value.outcome,
    at: new Date().toISOString(),
  });
  if (rows.length > 128) rows.splice(0, rows.length - 128);
}
export function metricsSnapshot() {
  const samples = [...(state.directorMetrics || [])];
  return {
    scope:
      "Current server process; last 128 observations only. No percentile or reliability claim.",
    samples,
    summary: operations.map((operation) => {
      const rows = samples.filter((s) => s.operation === operation);
      return {
        operation,
        count: rows.length,
        errors: rows.filter((s) => s.outcome === "error").length,
        durationsMs: rows.map((s) => s.durationMs),
      };
    }),
  };
}
export function operationFor(path: string): Operation | undefined {
  if (path === "/realtime/client_secrets") return "realtime_session";
  if (path === "/audio/speech") return "tts_headers";
  if (path === "/videos") return "avatar_submit";
  if (/^\/videos\/video_[a-zA-Z0-9_-]+\/content$/.test(path))
    return "avatar_content_headers";
  if (/^\/videos\/video_[a-zA-Z0-9_-]+$/.test(path)) return "avatar_poll";
}
