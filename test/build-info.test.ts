// "New version deployed" detection: a tab compares its own build id with
// dist/public/build.json; dev builds never check.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildLabel, fetchDeployedBuild, watchForNewVersion } from "../client/src/lib/build-info";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.useRealTimers(); });

function serve(build: string | null) {
  const fn = vi.fn(async () => (build === null
    ? new Response("nope", { status: 404 })
    : new Response(JSON.stringify({ app: "m5cet", version: "2.8.0", build, builtAt: "2026-09-22T10:00:00Z" }), { status: 200 })));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("build info", () => {
  it("labels an unbuilt (test/dev) bundle as dev", () => {
    expect(buildLabel()).toBe("M5cet dev · dev");
  });

  it("reads build.json without caching and tolerates its absence", async () => {
    const fn = serve("abc12345");
    expect(await fetchDeployedBuild()).toEqual({ version: "2.8.0", build: "abc12345", builtAt: "2026-09-22T10:00:00Z" });
    expect(String((fn.mock.calls[0] as unknown[])[0])).toMatch(/build\.json\?ts=\d+/);
    serve(null);
    expect(await fetchDeployedBuild()).toBeNull();
  });

  it("reports a different deployed build exactly once", async () => {
    serve("new00001");
    const onNew = vi.fn();
    const stop = watchForNewVersion(onNew, { current: "old00001", intervalMs: 50 });
    await flush(); await flush();
    window.dispatchEvent(new Event("focus"));
    await flush(); await flush();
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(onNew.mock.calls[0][0].build).toBe("new00001");
    stop();
  });

  it("stays quiet when the tab already runs the deployed build, and never checks in dev", async () => {
    const fn = serve("same0001");
    const onNew = vi.fn();
    const stop = watchForNewVersion(onNew, { current: "same0001" });
    await flush(); await flush();
    expect(onNew).not.toHaveBeenCalled();
    stop();
    fn.mockClear();
    const stopDev = watchForNewVersion(onNew, { current: "dev" });
    await flush();
    expect(fn).not.toHaveBeenCalled();
    stopDev();
  });
});

describe("build info — start check", () => {
  it("checks at start even when the tab reports hidden (restored in the background)", async () => {
    serve("new00002");
    const vis = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const onNew = vi.fn();
    const stop = watchForNewVersion(onNew, { current: "old00002" });
    await flush(); await flush();
    expect(onNew).toHaveBeenCalledTimes(1);
    stop();
    vis.mockRestore();
  });
});
