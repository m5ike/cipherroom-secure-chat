// The heartbeat of startBackgroundTick (lifecycle.ts). A file of its own:
// the production CSP (worker-src 'self') refuses a worker from a blob: URL,
// and did so silently — the tick never fired while the tab was hidden.

let id: ReturnType<typeof setInterval> | null = null;

self.onmessage = (event: MessageEvent<{ type?: string; intervalMs?: number }>) => {
  const data = event.data || {};
  if (data.type === "start") {
    if (id !== null) clearInterval(id);
    id = setInterval(() => self.postMessage({ type: "tick" }), Math.max(1000, data.intervalMs || 30_000));
  } else if (data.type === "stop") {
    if (id !== null) clearInterval(id);
    id = null;
    self.close();
  }
};
