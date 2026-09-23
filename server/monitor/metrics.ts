// Prometheus text exposition (version 0.0.4) of what the monitors know.
//
// Scrape GET /api/admin/metrics (or /metrics) with
//   Authorization: Bearer <METRICS_TOKEN or an administrator's token>.
// Everything here is counts and sizes — no names, no rooms, no content.

export type MetricSample = { labels?: Record<string, string | number>; value: number };
export type Metric = { name: string; help: string; type: "gauge" | "counter"; samples: MetricSample[] };

const escapeLabel = (v: string | number) => String(v).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');

export function renderMetrics(metrics: Metric[]): string {
  const out: string[] = [];
  for (const m of metrics) {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(m.name)) continue;
    out.push(`# HELP ${m.name} ${m.help.replace(/\n/g, " ")}`);
    out.push(`# TYPE ${m.name} ${m.type}`);
    for (const s of m.samples) {
      const labels = s.labels && Object.keys(s.labels).length
        ? `{${Object.entries(s.labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",")}}`
        : "";
      const value = Number.isFinite(s.value) ? s.value : 0;
      out.push(`${m.name}${labels} ${value}`);
    }
  }
  return `${out.join("\n")}\n`;
}

export const gauge = (name: string, help: string, value: number, labels?: Record<string, string | number>): Metric =>
  ({ name, help, type: "gauge", samples: [{ value, ...(labels ? { labels } : {}) }] });
