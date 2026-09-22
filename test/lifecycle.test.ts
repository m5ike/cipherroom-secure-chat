// When the browser puts the page aside and hands it back
// (client/src/lib/lifecycle.ts). The point of the module is that callers
// get one suspend / one resume instead of six overlapping events, so the
// tests drive the real events and check what comes out.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { watchLifecycle, startBackgroundTick, wasDiscarded, type ResumeEvent, type SuspendEvent } from "../client/src/lib/lifecycle";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => state === "hidden" });
  document.dispatchEvent(new Event("visibilitychange"));
}

function pageEvent(type: "pagehide" | "pageshow", persisted: boolean) {
  const event = new Event(type) as Event & { persisted?: boolean };
  Object.defineProperty(event, "persisted", { value: persisted });
  window.dispatchEvent(event);
}

let suspends: SuspendEvent[] = [];
let resumes: ResumeEvent[] = [];
let handle: ReturnType<typeof watchLifecycle> | null = null;

function start(options: Parameters<typeof watchLifecycle>[0] = {}) {
  handle = watchLifecycle({
    hiddenGraceMs: 1_000,
    blurGraceMs: 10_000,
    onSuspend: (e) => suspends.push(e),
    onResume: (e) => resumes.push(e),
    ...options,
  });
  return handle;
}

beforeEach(() => {
  vi.useFakeTimers();
  suspends = [];
  resumes = [];
  setVisibility("visible");
});

afterEach(() => {
  handle?.stop();
  handle = null;
  vi.useRealTimers();
});

describe("switching away and back", () => {
  it("reports one suspend when the tab is hidden, and a resume with how long it was gone", () => {
    start();
    setVisibility("hidden");
    expect(suspends).toEqual([]); // not yet: a flick to another tab is not away

    vi.advanceTimersByTime(1_000);
    expect(suspends).toMatchObject([{ reason: "hidden", final: false }]);

    vi.advanceTimersByTime(5_000);
    setVisibility("visible");
    expect(resumes).toHaveLength(1);
    expect(resumes[0]).toMatchObject({ reason: "visible", fromCache: false });
    expect(resumes[0].awayMs).toBeGreaterThanOrEqual(5_000);
  });

  it("ignores a quick flick to another tab", () => {
    start();
    setVisibility("hidden");
    vi.advanceTimersByTime(300);
    setVisibility("visible");
    vi.advanceTimersByTime(5_000);
    expect(suspends).toEqual([]);
    expect(resumes).toEqual([]);
  });

  it("does not repeat itself while the page stays away", () => {
    start();
    setVisibility("hidden");
    vi.advanceTimersByTime(10_000);
    window.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(60_000);
    expect(suspends).toHaveLength(1);

    setVisibility("visible");
    window.dispatchEvent(new Event("focus"));
    expect(resumes).toHaveLength(1);
  });
});

describe("switching to another application", () => {
  it("counts a long blur as a suspend, and focus as the resume", () => {
    start();
    window.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(9_000);
    expect(suspends).toEqual([]); // still looking at the tab

    vi.advanceTimersByTime(1_000);
    expect(suspends).toMatchObject([{ reason: "blurred" }]);

    window.dispatchEvent(new Event("focus"));
    expect(resumes).toMatchObject([{ reason: "focused" }]);
  });

  it("forgets a pending blur when the user comes straight back", () => {
    start();
    window.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(2_000);
    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(30_000);
    expect(suspends).toEqual([]);
  });
});

describe("the browser stopping us", () => {
  it("reports a freeze at once, as final — there may be no second chance", () => {
    start();
    document.dispatchEvent(new Event("freeze"));
    expect(suspends).toMatchObject([{ reason: "frozen", final: true }]);

    document.dispatchEvent(new Event("resume"));
    expect(resumes).toMatchObject([{ reason: "resumed" }]);
  });

  it("treats pagehide as final only when the page is not cached", () => {
    start();
    pageEvent("pagehide", true);
    expect(suspends).toMatchObject([{ reason: "pagehide", final: false }]);
    handle!.stop();

    suspends = [];
    start();
    pageEvent("pagehide", false);
    expect(suspends).toMatchObject([{ reason: "pagehide", final: true }]);
  });

  it("resumes a page restored from the back/forward cache, even without a suspend", () => {
    start();
    pageEvent("pageshow", true);
    expect(resumes).toMatchObject([{ reason: "pageshow", fromCache: true }]);
  });

  it("says when the page was discarded and rebuilt", () => {
    Object.defineProperty(document, "wasDiscarded", { configurable: true, value: true });
    expect(wasDiscarded()).toBe(true);
    start();
    setVisibility("hidden");
    vi.advanceTimersByTime(1_000);
    setVisibility("visible");
    expect(resumes[0].wasDiscarded).toBe(true);
    Object.defineProperty(document, "wasDiscarded", { configurable: true, value: false });
  });
});

describe("a page that starts in the background", () => {
  it("is suspended from the first moment, so the first look counts as a resume", () => {
    setVisibility("hidden");
    start();
    expect(handle!.suspended).toBe(true);
    setVisibility("visible");
    expect(resumes).toHaveLength(1);
  });
});

describe("the network", () => {
  it("passes online and offline straight through", () => {
    const online = vi.fn();
    const offline = vi.fn();
    start({ onOnline: online, onOffline: offline });
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
    expect(offline).toHaveBeenCalledOnce();
    expect(online).toHaveBeenCalledOnce();
  });
});

describe("stopping", () => {
  it("detaches every listener", () => {
    start();
    handle!.stop();
    setVisibility("hidden");
    vi.advanceTimersByTime(60_000);
    document.dispatchEvent(new Event("freeze"));
    expect(suspends).toEqual([]);
  });
});

describe("the background tick", () => {
  it("falls back to a timer when workers are unavailable", () => {
    const original = globalThis.Worker;
    // @ts-expect-error — removing it is the point
    delete globalThis.Worker;
    const ticks: string[] = [];
    const tick = startBackgroundTick((source) => ticks.push(source), 5_000);
    expect(tick.source).toBe("interval");

    vi.advanceTimersByTime(12_000);
    expect(ticks).toEqual(["interval", "interval"]);

    tick.stop();
    vi.advanceTimersByTime(30_000);
    expect(ticks).toHaveLength(2);
    if (original) globalThis.Worker = original;
  });
});
