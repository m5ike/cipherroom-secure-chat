// The Functions store and package/model operations (server/functions/store.ts,
// packages.ts, 4.15): drafts are mutable, published versions immutable, models
// point at a published entry, sessions and cache keep values with a TTL.

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FUNCTIONS_DB_FILE = join(mkdtempSync(join(tmpdir(), "m5fn-")), "functions.db");

const { functionsStore } = await import("../server/functions/store");
const { createPackage, saveDraft, publishDraft, saveModel, deletePackage, PackageError } = await import("../server/functions/packages");

beforeAll(() => functionsStore.ready());

describe("packages", () => {
  it("creates a draft, saves it, and publishes an immutable version", () => {
    const pkg = createPackage("tools", "js", "helpers", "op");
    expect(pkg.name).toBe("tools");
    expect(functionsStore.version(pkg.id, "draft")).not.toBeNull();
    saveDraft(pkg.id, { "index.js": "export const x = 1;" }, {}, "op");
    const v1 = publishDraft(pkg.id, "minor", "op");
    expect(v1.version).toBe("0.1.0");
    expect(v1.status).toBe("published");
    const v2 = publishDraft(pkg.id, "patch", "op");
    expect(v2.version).toBe("0.1.1");
    // A published version keeps its files even after the draft changes.
    saveDraft(pkg.id, { "index.js": "export const x = 2;" }, {}, "op");
    expect(functionsStore.version(pkg.id, "0.1.0")!.files["index.js"]).toBe("export const x = 1;");
  });

  it("refuses a duplicate name and a self / missing dependency", () => {
    createPackage("dup", "js", "", "op");
    expect(() => createPackage("dup", "js", "", "op")).toThrow(PackageError);
    const p = functionsStore.packageByName("dup")!;
    expect(() => saveDraft(p.id, { "index.js": "" }, { nope: "1.0.0" }, "op")).toThrow(/not published/);
  });

  it("won't delete a package a model uses", () => {
    const p = createPackage("used", "js", "", "op");
    saveDraft(p.id, { "index.js": "export async function execute(){ return m5.out.text('hi'); }" }, {}, "op");
    publishDraft(p.id, "minor", "op");
    saveModel({ name: "Uses it", entry: "used@0.1.0:index.js#execute", keyword: "usesit", enabled: true }, "op");
    expect(() => deletePackage(p.id, "op")).toThrow(/use/);
  });
});

describe("models", () => {
  it("validates the keyword and the entry, and bumps the revision", () => {
    const p = createPackage("mods", "js", "", "op");
    saveDraft(p.id, { "index.js": "export async function execute(){ return null; }" }, {}, "op");
    publishDraft(p.id, "minor", "op");
    const m = saveModel({ name: "M", keyword: "runit", entry: "mods@0.1.0:index.js#execute", enabled: true }, "op");
    expect(m.revision).toBe(1);
    const m2 = saveModel({ id: m.id, name: "M2" }, "op");
    expect(m2.revision).toBe(2);
    expect(functionsStore.modelByKeyword("runit")!.id).toBe(m.id);
    expect(() => saveModel({ name: "bad", keyword: "Has Space" }, "op")).toThrow(/keyword/);
    expect(() => saveModel({ name: "bad", entry: "mods@9.9.9:index.js#execute" }, "op")).toThrow(/not published/);
  });
});

describe("sessions and cache", () => {
  it("keeps values, counts, and expires them", () => {
    const sid = functionsStore.session("m", "scope-a");
    expect(functionsStore.session("m", "scope-a")).toBe(sid); // same scope → same session
    functionsStore.sessionSet(sid, "k", { a: 1 }, null);
    expect(functionsStore.sessionGet(sid, "k")).toEqual({ a: 1 });
    expect(functionsStore.sessionKeys(sid)).toEqual(["k"]);
    functionsStore.sessionSet(sid, "gone", "x", -1); // already expired
    expect(functionsStore.sessionGet(sid, "gone")).toBeNull();

    expect(functionsStore.cacheIncr("model:m", "hits", 1, null)).toBe(1);
    expect(functionsStore.cacheIncr("model:m", "hits", 4, null)).toBe(5);
    functionsStore.cacheSet("global", "flag", true, null);
    expect(functionsStore.cacheGet("global", "flag")).toBe(true);
  });
});
