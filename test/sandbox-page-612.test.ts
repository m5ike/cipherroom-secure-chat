// @vitest-environment node
// 6.12 (F-08, server part): /fn-sandbox.html?origin=peer — the frame for code
// that came in another member's message — has no network at all: connect-src
// 'none', images / media / fonts only from data: and blob:, no frames, and the
// page drops WebRTC. The default page (the caller's own runs, model outputs)
// is unchanged.

import { describe, it, expect, afterAll } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { SANDBOX_CSP, SANDBOX_CSP_PEER, SANDBOX_HTML, registerSandboxPage, sandboxHtml, sandboxVariant } from "../server/functions/sandbox-page";

const app = express();
registerSandboxPage(app);
const server = app.listen(0, "127.0.0.1");
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const directives = (csp: string) => Object.fromEntries(csp.split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));

describe("the sandbox page's variants", () => {
  it("?origin=peer selects the strict variant; anything else the default", () => {
    expect(sandboxVariant({ origin: "peer" })).toBe("peer");
    for (const q of [{}, { origin: "own" }, { origin: ["peer"] }, { origin: "PEER" }, null]) expect(sandboxVariant(q)).toBe("own");
  });

  it("the strict CSP lets nothing leave the frame on its own", () => {
    const d = directives(SANDBOX_CSP_PEER);
    expect(d["connect-src"]).toEqual(["'none'"]);
    for (const k of ["img-src", "media-src"]) expect(d[k]).toEqual(["data:", "blob:"]);
    expect(d["font-src"]).toEqual(["data:"]);
    for (const k of ["frame-src", "child-src", "worker-src"]) expect(d[k]).toEqual(["'none'"]);
    expect(SANDBOX_CSP_PEER).not.toMatch(/https:/);
    expect(d.sandbox).toEqual(["allow-scripts"]);
    expect(d["frame-ancestors"]).toEqual(["'self'"]);
    expect(d["default-src"]).toEqual(["'none'"]);
  });

  it("the default variant is what it was", () => {
    expect(directives(SANDBOX_CSP)["connect-src"]).toEqual(["https:"]);
    expect(SANDBOX_HTML).toBe(sandboxHtml("own"));
    expect(SANDBOX_HTML).not.toMatch(/RTCPeerConnection/);
  });

  it("the strict page refuses https: sources in m5.play and drops WebRTC", () => {
    const peer = sandboxHtml("peer");
    expect(peer).toMatch(/RTCPeerConnection/);
    expect(peer).toContain("/^(data:|blob:)/");
    expect(SANDBOX_HTML).toContain("/^(data:|blob:|https:)/");
  });

  it("serves each variant with its own CSP", async () => {
    const own = await fetch(`${base()}/fn-sandbox.html`);
    expect(own.headers.get("content-security-policy")).toBe(SANDBOX_CSP);
    expect(await own.text()).toBe(SANDBOX_HTML);
    const peer = await fetch(`${base()}/fn-sandbox.html?origin=peer`);
    expect(peer.headers.get("content-security-policy")).toBe(SANDBOX_CSP_PEER);
    expect(await peer.text()).toBe(sandboxHtml("peer"));
  });
});
