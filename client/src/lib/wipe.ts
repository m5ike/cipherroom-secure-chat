// "Clear & Quit": remove every trace of this visit that a web page can reach,
// then hand over to the server's /goodbye page, whose Clear-Site-Data header
// removes what script cannot (HttpOnly cookies, the HTTP cache) and repeats
// the rest as a safety net.
//
// What is cleared:
//   - the encrypted session cache and its key
//   - localStorage, sessionStorage, every IndexedDB database of this origin
//   - Cache Storage, service worker registrations, the push subscription
//   - script-visible cookies
//   - server side: settings / consent / push subscriptions tied to this device
//
// What a website cannot do, and this does not pretend to: delete entries from
// the browser's history. We only avoid feeding it — invite links keep their
// secrets in the #fragment and scrub it on arrival, and leaving goes through
// location.replace(), so Back does not lead into the chat again.

export type WipeStep = "server" | "push" | "serviceWorker" | "caches" | "indexedDB" | "storage" | "cookies";
export type WipeReport = Record<WipeStep, "ok" | "skipped" | "failed">;

const KNOWN_DATABASES = ["m5cet-session"];

async function attempt(report: WipeReport, step: WipeStep, run: () => Promise<boolean | void>): Promise<void> {
  try { report[step] = (await run()) === false ? "skipped" : "ok"; } catch { report[step] = "failed"; }
}

function expireCookies(): void {
  const names = document.cookie.split(";").map((c) => c.split("=")[0]?.trim()).filter(Boolean) as string[];
  const hostParts = location.hostname.split(".");
  for (const name of names) {
    // a cookie is only removed when path AND domain match how it was set
    const domains = ["", ...hostParts.map((_, i) => hostParts.slice(i).join("."))];
    for (const domain of domains) {
      for (const path of ["/", location.pathname]) {
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${path}${domain ? `; domain=${domain}` : ""}`;
      }
    }
  }
}

/** Never throws: a step that fails must not stop the ones after it. */
export async function wipeEverything(opts: { deviceId?: string; fetcher?: typeof fetch } = {}): Promise<WipeReport> {
  const report: WipeReport = { server: "skipped", push: "skipped", serviceWorker: "skipped", caches: "skipped", indexedDB: "skipped", storage: "skipped", cookies: "skipped" };
  const fetcher = opts.fetcher ?? (typeof fetch !== "undefined" ? fetch : undefined);

  // Server first, while we still know who we are.
  await attempt(report, "server", async () => {
    if (!opts.deviceId || !fetcher) return false;
    await fetcher("/api/audit/purge", {
      method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", keepalive: true,
      body: JSON.stringify({ deviceId: opts.deviceId }),
    });
  });

  await attempt(report, "push", async () => {
    if (!("serviceWorker" in navigator)) return false;
    const regs = await navigator.serviceWorker.getRegistrations();
    let any = false;
    for (const reg of regs) {
      const sub = await reg.pushManager?.getSubscription().catch(() => null);
      if (sub) { await sub.unsubscribe(); any = true; }
    }
    return any;
  });

  await attempt(report, "serviceWorker", async () => {
    if (!("serviceWorker" in navigator)) return false;
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    return regs.length > 0;
  });

  await attempt(report, "caches", async () => {
    if (typeof caches === "undefined") return false;
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    return keys.length > 0;
  });

  await attempt(report, "indexedDB", async () => {
    if (typeof indexedDB === "undefined") return false;
    const listed = typeof indexedDB.databases === "function" ? await indexedDB.databases().catch(() => []) : [];
    const names = new Set<string>([...KNOWN_DATABASES, ...listed.map((d) => d.name).filter((n): n is string => Boolean(n))]);
    await Promise.all(Array.from(names, (name) => new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    })));
  });

  await attempt(report, "storage", async () => {
    try { localStorage.clear(); } catch { /* blocked storage */ }
    try { sessionStorage.clear(); } catch { /* blocked storage */ }
  });

  await attempt(report, "cookies", async () => {
    if (typeof document === "undefined" || !document.cookie) return false;
    expireCookies();
  });

  return report;
}

/** Replace — not push — the current history entry, so Back cannot return here. */
export function leaveToGoodbye(): void {
  location.replace("/goodbye");
}
