// The console's code editor (admin-ui/src/m5-editor.ts, 5.1): SDK signatures
// become snippets with fields for the required arguments, an editor keeps
// and changes its text, and the bundle the console loads builds.

import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const E = await import("../admin-ui/src/m5-editor");

describe("SDK snippets", () => {
  it("fills the required fields of an options object", () => {
    expect(E.toSnippet("await m5.ai.tts({ text, voice? })", "js")).toBe("tts({ text: ${text} })");
    expect(E.toSnippet("await m5.ai.chat({ messages, model?, system? })", "js")).toBe("chat({ messages: ${messages} })");
  });
  it("fills positional arguments and leaves the optional ones out", () => {
    expect(E.toSnippet("m5.crypto.hash(alg, data, enc?)", "js")).toBe("hash(${alg}, ${data})");
    expect(E.toSnippet("m5.out.table(columns, rows, { title })", "js")).toBe("table(${columns}, ${rows})");
    expect(E.toSnippet("m5.id.uuid()", "js")).toBe("uuid()");
  });
  it("handles Python keyword arguments", () => {
    expect(E.toSnippet("await m5.ai.tts(text=...)", "py")).toBe("tts(text=${text})");
    expect(E.toSnippet("m5.crypto.hash(alg, data, encoding=None)", "py")).toBe("hash(${alg}, ${data})");
    expect(E.toSnippet("await m5.dns.resolve(name, type='A')", "py")).toBe("resolve(${name})");
  });
  it("knows a file's language", () => {
    expect(E.langOf("index.py")).toBe("py");
    expect(E.langOf("lib/a.js")).toBe("js");
    expect(E.langOf("flow.m5flow.json")).toBe("json");
    expect(E.langOf("README.md")).toBe("text");
  });
  it("has templates for both languages", () => {
    expect(E.SNIPPETS.js.map((s) => s.label)).toContain("execute");
    expect(E.SNIPPETS.py.map((s) => s.label)).toContain("execute");
  });
});

describe("the editor", () => {
  it("holds, replaces and inserts text; reports changes", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const changes: string[] = [];
    const ed = E.create(host, { doc: "const a = 1;", lang: "js", onChange: (t) => changes.push(t) });
    expect(ed.getValue()).toBe("const a = 1;");
    ed.setValue("x");
    expect(ed.getValue()).toBe("x");
    ed.insertText("y");
    expect(ed.getValue()).toContain("y");
    expect(changes.length).toBeGreaterThanOrEqual(2);
    expect(host.querySelector(".cm-editor")).toBeTruthy();
    ed.destroy();
  });
  it("exposes itself and the flow compiler to the console", () => {
    expect(window.M5Editor?.create).toBeTypeOf("function");
    expect(window.M5Flow?.compileFlow).toBeTypeOf("function");
  });
});

describe("the bundle", () => {
  it("builds for the console (CSP 'self': no CDN)", async () => {
    const { buildAdminVendor, VENDOR_BUNDLES } = await import("../server/admin-vendor");
    const root = mkdtempSync(join(tmpdir(), "m5vendor-"));
    const { symlinkSync, mkdirSync } = await import("node:fs");
    // Build from the repo's sources into a scratch copy of the output path.
    mkdirSync(join(root, "admin-ui", "src"), { recursive: true });
    mkdirSync(join(root, "server", "functions"), { recursive: true });
    symlinkSync(join(process.cwd(), "admin-ui", "src", "m5-editor.ts"), join(root, "admin-ui", "src", "m5-editor.ts"));
    symlinkSync(join(process.cwd(), "server", "functions", "flow.ts"), join(root, "server", "functions", "flow.ts"));
    symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"));
    await buildAdminVendor(root, true);
    const out = join(root, VENDOR_BUNDLES[0].out);
    expect(statSync(out).size).toBeGreaterThan(100_000);
    const js = readFileSync(out, "utf8");
    expect(js).toContain("M5Editor");
    expect(js).not.toMatch(/https?:\/\/(cdn|unpkg|jsdelivr)/);
  }, 60_000);
});
