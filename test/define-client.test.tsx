// 6.3 define — m5mobile.define in the web app (client/src/lib/define/client.ts).
// The endpoint returns already-materialized values; the module fetches them
// once, caches them, publishes window.m5mobile.define, refetches on demand, and
// handles absence (offline / no definitions / an error) as an empty object.

import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { fetchDefine, bootstrapDefine, defineValuesNow, useDefine, _resetDefineForTest } from "../client/src/lib/define/client";

const SCRIPT = { __m5script: true, code: "return 1 + 1;", lang: "js" };
const SAMPLE = { greeting: "ahoj", answer: 42, config: { host: "h", port: 8080 }, colors: ["red", "green"], onScan: SCRIPT };

function stubFetch(impl: (url: string) => Promise<Response> | Response) {
  const fn = vi.fn(async (url: string) => impl(url));
  vi.stubGlobal("fetch", fn);
  return fn;
}
const ok = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body } as unknown as Response);

function windowDefine(): Record<string, unknown> | undefined {
  return (window as unknown as { m5mobile?: { define: Record<string, unknown> } }).m5mobile?.define;
}

afterEach(() => {
  cleanup();
  _resetDefineForTest();
  vi.unstubAllGlobals();
});

describe("fetchDefine", () => {
  it("fetches web-scope values, surfaces them, and publishes window.m5mobile.define", async () => {
    const fn = stubFetch(() => ok({ ok: true, values: SAMPLE, updatedAt: 5 }));
    const values = await fetchDefine();
    expect(fn).toHaveBeenCalledWith("/api/define?scope=web", { cache: "no-store" });
    expect(values.greeting).toBe("ahoj");
    expect(values.answer).toBe(42);
    expect(values.config).toEqual({ host: "h", port: 8080 });
    expect(values.colors).toEqual(["red", "green"]);
    expect(values.onScan).toEqual(SCRIPT); // a script value stays as data, never evaluated
    expect(windowDefine()).toEqual(SAMPLE);
    expect(defineValuesNow().greeting).toBe("ahoj");
  });

  it("caches: a second call does not refetch, but force / refresh does", async () => {
    const fn = stubFetch(() => ok({ ok: true, values: SAMPLE, updatedAt: 5 }));
    await fetchDefine();
    await fetchDefine();
    expect(fn).toHaveBeenCalledTimes(1);
    await fetchDefine(true);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("handles absence gracefully: a rejected fetch yields an empty object", async () => {
    stubFetch(() => { throw new Error("offline"); });
    const values = await fetchDefine();
    expect(values).toEqual({});
    expect(windowDefine()).toEqual({});
  });

  it("handles a non-ok response as empty", async () => {
    stubFetch(() => ({ ok: false, status: 503, json: async () => ({}) } as unknown as Response));
    expect(await fetchDefine()).toEqual({});
  });
});

describe("bootstrapDefine", () => {
  it("publishes window.m5mobile.define immediately (empty) and then fills it", async () => {
    stubFetch(() => ok({ ok: true, values: SAMPLE, updatedAt: 5 }));
    bootstrapDefine();
    expect(windowDefine()).toEqual({}); // set synchronously, before the fetch resolves
    await fetchDefine(); // shares the in-flight request bootstrap started
    expect(windowDefine()).toEqual(SAMPLE);
  });
});

describe("useDefine", () => {
  it("returns the values once loaded and exposes refresh()", async () => {
    stubFetch(() => ok({ ok: true, values: SAMPLE, updatedAt: 7 }));
    const { result } = renderHook(() => useDefine());
    expect(result.current.loaded).toBe(false);
    expect(result.current.values).toEqual({});
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.values.greeting).toBe("ahoj");
    expect(result.current.updatedAt).toBe(7);
    expect(typeof result.current.refresh).toBe("function");
  });
});
