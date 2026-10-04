// @vitest-environment node
//
// 6.10 security review, G-02: Express matched routes case-insensitively while
// the console guards decided rights from the exact path — "/admin/telephony/
// LOG/<id>" reached the log entry (raw provider payloads) with only the
// module's read access, "/api/admin/android/Devices/<id>/LOCATIONS" the
// positions without the "devices" right. The apps and routers now route
// exactly (server/exact-routing.ts) and the telephony guard compares like a
// router would.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";

const express = (await import("express")).default;
const { exactRouting, EXACT_ROUTER } = await import("../server/exact-routing");
const { telephonyConsoleRight } = await import("../server/telephony/control/guard");

async function serve(app: import("express").Express, paths: string[]): Promise<Array<{ status: number; body: string }>> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const out: Array<{ status: number; body: string }> = [];
    for (const p of paths) { const r = await fetch(`${base}${p}`); out.push({ status: r.status, body: await r.text() }); }
    return out;
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

/** An app shaped like the admin service: a guard on the prefix that records the right, then the routes. */
function consoleLike(app: import("express").Express) {
  app.use("/admin/telephony", (req, res, next) => { res.locals.need = JSON.stringify(telephonyConsoleRight(req)); next(); });
  app.get("/admin/telephony/log/:id", (req, res) => { res.json({ entry: req.params.id, need: res.locals.need }); });
  const r = express.Router(EXACT_ROUTER);
  r.get("/devices/:id/locations", (_req, res) => { res.json({ positions: true }); });
  app.use("/api/admin/android", r);
  return app;
}

describe("6.10 (G-02): exact routing", () => {
  it("a default Express app would hand a case-changed path to the handler with no right asked (the bug)", async () => {
    const app = express();
    app.use("/admin/telephony", (req, res, next) => { res.locals.need = JSON.stringify(telephonyConsoleRight(req)); next(); });
    app.get("/admin/telephony/log/:id", (req, res) => { res.json({ entry: req.params.id, need: res.locals.need }); });
    const [r] = await serve(app, ["/admin/telephony/LOG/abc"]);
    expect(r.status).toBe(200);
    // The guard is case-insensitive now, so even here it would ask for "log".
    expect(JSON.parse(r.body)).toMatchObject({ entry: "abc", need: JSON.stringify([["log"]]) });
  });

  it("with exactRouting / EXACT_ROUTER a case-changed path matches no route; the exact one keeps its right", async () => {
    const [exact, upper, mixed, slash, androidExact, androidUpper] = await serve(consoleLike(exactRouting(express())), [
      "/admin/telephony/log/abc", "/admin/telephony/LOG/abc", "/admin/Telephony/log/abc", "/admin/telephony/Log/abc/",
      "/api/admin/android/devices/d1/locations", "/api/admin/android/Devices/d1/LOCATIONS",
    ]);
    expect(exact.status).toBe(200);
    expect(JSON.parse(exact.body)).toMatchObject({ entry: "abc", need: JSON.stringify([["log"]]) });
    for (const r of [upper, mixed, slash]) expect(r.status).toBe(404);
    expect(androidExact.status).toBe(200);
    expect(androidUpper.status).toBe(404);
  });

  it("the telephony guard asks the same right whatever the case", () => {
    const right = (method: string, path: string) => telephonyConsoleRight({ method, path, baseUrl: "/admin/telephony" });
    expect(right("GET", "/log/tlg_1")).toEqual([["log"]]);
    expect(right("GET", "/LOG/tlg_1")).toEqual([["log"]]);
    expect(right("PUT", "/Rules/Inbound")).toEqual([["routing"]]);
  });

  it("both services and the routers with path-based rights route exactly", () => {
    const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
    expect(src("server/index.ts")).toMatch(/const app = exactRouting\(express\(\)\);/);
    expect(src("server/admin.ts")).toMatch(/const app = exactRouting\(express\(\)\);/);
    for (const p of ["server/android/admin-routes.ts", "server/android/routes.ts", "server/functions/admin-routes.ts"]) {
      expect(src(p)).toContain("express.Router(EXACT_ROUTER)");
      expect(src(p)).not.toMatch(/express\.Router\(\)/);
    }
  });
});
