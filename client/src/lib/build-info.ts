// Which build is running, and is a newer one deployed?
//
// vite.config.ts embeds the version + build id (git commit) at build time and
// writes the same into dist/public/build.json. A tab opened before a deploy
// keeps running the old bundle (it is a single-page app) — watchForNewVersion
// notices the difference and the app offers a reload.

declare const __APP_VERSION__: string;
declare const __APP_BUILD__: string;
declare const __APP_BUILT_AT__: string;

export const APP_VERSION: string = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";
export const APP_BUILD: string = typeof __APP_BUILD__ !== "undefined" ? __APP_BUILD__ : "dev";
export const APP_BUILT_AT: string = typeof __APP_BUILT_AT__ !== "undefined" ? __APP_BUILT_AT__ : "";

export function buildLabel(): string {
  return `M5cet ${APP_VERSION} · ${APP_BUILD === "dev" ? "dev" : `build ${APP_BUILD}`}`;
}

export type DeployedBuild = { version: string; build: string; builtAt: string };

export async function fetchDeployedBuild(timeoutMs = 8000): Promise<DeployedBuild | null> {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(`./build.json?ts=${Date.now()}`, { cache: "no-store", signal: ctrl?.signal });
    if (!res.ok) return null;
    const j = (await res.json()) as Partial<DeployedBuild>;
    return typeof j.build === "string" && j.build ? { version: String(j.version ?? ""), build: j.build, builtAt: String(j.builtAt ?? "") } : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Calls onNew once when the server has a different build than this tab.
 *  Checks on start, whenever the tab is focused / shown again, and every 10
 *  minutes while visible. The start check and the focus / visibility checks
 *  do not ask document.visibilityState: a tab restored in the background
 *  (or still loading) reports "hidden" at that moment and would otherwise
 *  skip its only early check. A dev build never checks. */
export function watchForNewVersion(onNew: (deployed: DeployedBuild) => void, opts: { intervalMs?: number; current?: string } = {}): () => void {
  const current = opts.current ?? APP_BUILD;
  if (current === "dev" || typeof window === "undefined") return () => {};
  let done = false;
  let busy = false;
  const check = async (onlyIfVisible: boolean) => {
    if (done || busy) return;
    if (onlyIfVisible && typeof document !== "undefined" && document.visibilityState === "hidden") return;
    busy = true;
    const deployed = await fetchDeployedBuild();
    busy = false;
    if (!done && deployed && deployed.build !== current) {
      done = true;
      onNew(deployed);
    }
  };
  const onVisible = () => { if (document.visibilityState !== "hidden") void check(false); };
  const onFocus = () => { void check(false); };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onFocus);
  window.addEventListener("pageshow", onFocus);
  const timer = window.setInterval(() => { void check(true); }, opts.intervalMs ?? 10 * 60 * 1000);
  void check(false);
  return () => {
    done = true;
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("pageshow", onFocus);
    window.clearInterval(timer);
  };
}
