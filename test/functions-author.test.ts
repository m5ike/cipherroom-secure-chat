// Author tooling (4.15, stage 6): templates and .m5pkg export / import.

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FUNCTIONS_DB_FILE = join(mkdtempSync(join(tmpdir(), "m5auth-")), "functions.db");

const { functionsStore } = await import("../server/functions/store");
const { createPackage, saveDraft, publishDraft, exportPackage, importPackage, TEMPLATES, PackageError } = await import("../server/functions/packages");

beforeAll(() => functionsStore.ready());

describe("templates", () => {
  it("creates a package from a template with its files", () => {
    const tpl = TEMPLATES.find((t) => t.id === "http-fetch")!;
    const pkg = createPackage("fetcher", "js", "", "op", "http-fetch");
    expect(pkg.language).toBe("js");
    const draft = functionsStore.version(pkg.id, "draft")!;
    expect(draft.files["index.js"]).toBe(tpl.files["index.js"]);
  });
  it("refuses an unknown template", () => {
    expect(() => createPackage("x", "js", "", "op", "nope")).toThrow(PackageError);
  });
});

describe("export / import", () => {
  it("round-trips a package through a bundle", () => {
    const pkg = createPackage("roundtrip", "js", "demo", "op");
    saveDraft(pkg.id, { "index.js": "export const a = 1;" }, {}, "op");
    publishDraft(pkg.id, "minor", "op"); // 0.1.0
    saveDraft(pkg.id, { "index.js": "export const a = 2;" }, {}, "op");
    publishDraft(pkg.id, "minor", "op"); // 0.2.0

    const bundle = exportPackage(pkg.id);
    expect(bundle.format).toBe("m5pkg");
    expect(bundle.versions.map((v) => v.version)).toEqual(["0.1.0", "0.2.0"]);

    // Importing under the same name gets a fresh, suffixed name.
    const imported = importPackage(bundle, "op");
    expect(imported.name).toBe("roundtrip-2");
    expect(functionsStore.versions(imported.id).filter((v) => v.status === "published").map((v) => v.version).sort()).toEqual(["0.1.0", "0.2.0"]);
    expect(functionsStore.version(imported.id, "0.2.0")!.files["index.js"]).toBe("export const a = 2;");
    // The latest version becomes the draft.
    expect(functionsStore.version(imported.id, "draft")!.files["index.js"]).toBe("export const a = 2;");
  });

  it("rejects a non-bundle", () => {
    expect(() => importPackage({ hello: 1 }, "op")).toThrow(/m5pkg/);
  });
});
