// @vitest-environment node
// The console's preview language (admin-ui/public/android-expr.js) against
// the same vectors as the server (expr.ts) and the app (Expr.java).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

type Api = { eval: (s: string, scope: object, tr: (k: string) => string) => unknown; render: (s: string, scope: object, tr: (k: string) => string) => string; check: (s: string) => string | null; checkTemplate: (s: string) => string | null };

const sandbox: { M5AndroidExpr?: Api; globalThis?: unknown } = {};
sandbox.globalThis = sandbox;
runInNewContext(readFileSync(join(__dirname, "..", "admin-ui", "public", "android-expr.js"), "utf8"), sandbox);
const X = sandbox.M5AndroidExpr!;
const v = JSON.parse(readFileSync(join(__dirname, "fixtures", "android-expr.json"), "utf8"));
const tr = (k: string) => v.strings[k] ?? k;

describe("android-expr.js (the console's preview)", () => {
  it("evaluates every shared expression", () => {
    for (const c of v.expressions) expect(X.eval(c.src, v.scope, tr), c.src).toEqual(c.value);
  });
  it("renders every shared template", () => {
    for (const c of v.templates) expect(X.render(c.src, v.scope, tr), c.src).toBe(c.text);
  });
  it("refuses what the others refuse", () => {
    for (const s of v.invalid.expressions) expect(X.check(s), s).not.toBeNull();
    for (const s of v.invalid.templates) expect(X.checkTemplate(s), s).not.toBeNull();
  });
});
