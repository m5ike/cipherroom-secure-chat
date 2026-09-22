// Notifications panel → "Test web push": targets only this device's own
// subscription (localStorage "m5cet:push:id"), never broadcasts, and
// explains what to do when there is no (longer a) subscription.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sendTestPush } from "../client/src/lib/push";

const realFetch = globalThis.fetch;
beforeEach(() => { localStorage.clear(); });
afterEach(() => { globalThis.fetch = realFetch; });

describe("sendTestPush", () => {
  it("without a stored subscription id it does not call the server", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const r = await sendTestPush();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/povolte/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends only its own id (no text, no broadcast)", async () => {
    localStorage.setItem("m5cet:push:id", "sub-123");
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true, mode: "self" }), { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    expect(await sendTestPush()).toEqual({ ok: true });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/push/test");
    expect(JSON.parse(String(init.body))).toEqual({ id: "sub-123" });
  });

  it("forgets an id the server no longer knows (restart) and says why", async () => {
    localStorage.setItem("m5cet:push:id", "sub-gone");
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false }), { status: 404 })) as unknown as typeof fetch;
    const r = await sendTestPush();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/restart/);
    expect(localStorage.getItem("m5cet:push:id")).toBeNull();
  });
});
