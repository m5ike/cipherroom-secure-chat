// @vitest-environment node
// 6.11 — model answers on Android (server/android/design-611-fn.ts and the
// app's fn/ModelIdentity, fn/CommandCheck, fn/RunWatch, fn/Suggestions,
// ui/bubble/ModelFace): a model's answer is an incoming message from
// "system-messenger" with the model's name and icon (the same colour as the
// web), replying to the command; a run that hangs fails after 30 s; a wrong
// call is answered by an error card; the suggester. Here: the contract's
// vectors (the Java port's JVM tests read the same file), the trees, the
// version gate, and that every text the app asks for exists in Czech,
// English and German.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { checkCommandInputs, commandUsage, FN_RUN_TIMEOUT_MS, inputExpectation, modelColor, modelIdentity, SYSTEM_MESSENGER_ID } from "../client/src/lib/system-messenger";
import { DEFAULT_DESIGN, DEFAULT_SCREENS, DEFAULT_STRINGS, SCREEN_IDS, sanitizeScreen, type ANode } from "../server/android/design";
import { designMinAppCode } from "../server/android/bundle";
import { AREA, FACE, modelSheet } from "../server/android/design-611-fn";
import type { Command } from "../client/src/lib/functions";

const walk = (n: ANode, f: (n: ANode) => void): void => { f(n); (n.children ?? []).forEach((c) => walk(c, f)); };
const find = (n: ANode, id: string): ANode | null => { let out: ANode | null = null; walk(n, (x) => { if (!out && x.id === id) out = x; }); return out; };
const clean = (tree: ANode, id: string): string[] => { const p: string[] = []; sanitizeScreen(structuredClone(tree), id, p); return p; };
const root = new URL("../android/app/src/", import.meta.url).pathname;
const java = (p: string) => readFileSync(join(root, "main/java/cz/m5cet/app", p), "utf8");
const vectors = JSON.parse(readFileSync(join(root, "test/resources/cz/m5cet/app/fn/system-messenger-vectors.json"), "utf8"));

function javaFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? javaFiles(p) : p.endsWith(".java") ? [p] : []; });
}

describe("android fn 6.11 — the contract's vectors (the Java port reads the same file)", () => {
  it("the same colours", () => {
    for (const [k, c] of Object.entries(vectors.colors as Record<string, string>)) expect(modelColor(k), k).toBe(c);
    expect(modelColor("mail")).toBe("#36b234");
    expect(modelColor("hlr")).toBe("#7bb234");
    expect(modelColor("x")).toBe("#34b234");
  });

  it("the same identities", () => {
    for (const v of vectors.identities as Array<{ in: { keyword: string; name: string; icon?: string }; out: unknown }>) expect(modelIdentity(v.in)).toEqual(v.out);
    expect(SYSTEM_MESSENGER_ID).toBe("system-messenger");
    expect(FN_RUN_TIMEOUT_MS).toBe(30_000);
  });

  it("the same usage line, expectations and checks", () => {
    const cmd = { ...vectors.command } as Command;
    expect(commandUsage(cmd)).toBe(vectors.usage["/"]);
    expect(commandUsage(cmd, "!")).toBe(vectors.usage["!"]);
    cmd.inputs.forEach((i, k) => expect(inputExpectation(i), i.name).toBe(vectors.expectations[k]));
    for (const m of vectors.moreExpectations) expect(inputExpectation(m.input)).toBe(m.out);
    for (const c of vectors.checks) expect(checkCommandInputs(cmd, c.values), JSON.stringify(c.values)).toEqual(c.out);
    expect(checkCommandInputs({ inputs: vectors.badPattern.inputs }, vectors.badPattern.values)).toEqual(vectors.badPattern.out);
  });
});

describe("android fn 6.11 — the trees", () => {
  const IN = DEFAULT_SCREENS["message.in"];

  it("a model's answer shows the model's face, its name in its colour and how it came", () => {
    const face = find(IN, "face")!;
    const model = find(face, "model-face")!;
    expect(model).toMatchObject({ el: "column", if: "$msg.model" });
    expect(model.style).toMatchObject({ width: FACE, height: FACE, radius: FACE / 2, bg: "=$msg.model.color" });
    expect(find(model, "model-icon")).toMatchObject({ el: "icon", if: "!$msg.model.emoji", props: { icon: "=$msg.model.glyph" } });
    expect(find(model, "model-emoji")).toMatchObject({ el: "text", if: "$msg.model.emoji" });
    // The monogram and the photo give way to it.
    expect(find(face, "avatar")!.if).toContain("!$msg.model");
    expect(find(face, "photo")!.if).toContain("!$msg.model");
    expect(find(IN, "sender")!.style?.fg).toBe("=$msg.model ? $msg.model.color : '@primary'");
    const line = find(IN, "model-line")!;
    expect(line).toMatchObject({ el: "text", if: "$msg.model", text: "{$msg.model.line}" });
    expect(clean(IN, "message.in")).toEqual([]);
  });

  it("patching twice changes nothing; a tree without a face keeps its look", () => {
    const screens = { "message.in": structuredClone(IN) };
    AREA.patch!(screens);
    expect(screens["message.in"]).toEqual(IN);
    const own: ANode = { id: "row", el: "row", children: [{ id: "x", el: "text", text: "{$msg.text}" }] };
    const mine = { "message.in": structuredClone(own) };
    AREA.patch!(mine);
    expect(mine["message.in"]).toEqual(own);
  });

  it("the model's sheet: what it is, its usage and parameters, who it came through, write the command", () => {
    expect(SCREEN_IDS).toContain("message.model");
    expect(DEFAULT_SCREENS["message.model"]).toEqual(modelSheet);
    expect(clean(modelSheet, "message.model")).toEqual([]);
    for (const id of ["face", "title", "keyword", "summary", "usage", "input", "guide", "write", "sender", "note"]) expect(find(modelSheet, id), id).not.toBeNull();
    expect(find(modelSheet, "input")!.each).toBe("$form.model.inputs");
    expect(find(modelSheet, "write")!.on?.click).toEqual({ action: "compose", arg: "write:{$form.model.write}" });
    expect(find(modelSheet, "sender")!.on?.click).toEqual({ action: "people.open", arg: "{$form.model.senderId}" });
  });

  it("no new element or action: the default design still runs on app 61000", () => {
    expect(AREA.elements ?? []).toEqual([]);
    expect(AREA.actions ?? []).toEqual([]);
    expect(designMinAppCode(DEFAULT_DESIGN)).toBeLessThanOrEqual(61000);
  });
});

describe("android fn 6.11 — the app", () => {
  it("every text it asks for, in Czech, English and German", () => {
    const src = javaFiles(join(root, "main/java/cz/m5cet/app")).map((f) => readFileSync(f, "utf8")).join("\n");
    const used = new Set([...src.matchAll(/"(fnm\.[A-Za-z.]+[A-Za-z])"/g)].map((m) => m[1]));
    for (const k of ["missing", "type", "pattern", "range", "values"]) used.add(`fnm.problem.${k}`);
    for (const k of ["recent", "commands", "others", "people", "tags"]) used.add(`fnm.sec.${k}`);
    used.add("fnm.interrupted"); // a bubble still loading when the app stopped (its status code)
    // And what the trees read.
    for (const [, v] of JSON.stringify(DEFAULT_SCREENS).matchAll(/_\(?'(fnm\.[A-Za-z.]+)'/g)) used.add(v);
    expect(used.size).toBeGreaterThan(40);
    for (const lang of ["cs", "en", "de"] as const) {
      for (const k of used) expect(DEFAULT_STRINGS[lang][k], `${lang} ${k}`).toBeTruthy();
    }
    // Translated, not copied: Czech with its diacritics, German its own.
    expect(DEFAULT_STRINGS.cs["fnm.failed"]).toBe("Chyba při provádění funkce modelu /{keyword}");
    expect(DEFAULT_STRINGS.en["fnm.failed"]).toBe("Error while running the model's function /{keyword}");
    expect(DEFAULT_STRINGS.de["fnm.failed"]).toContain("/{keyword}");
    const strings = Object.keys(DEFAULT_STRINGS.cs).filter((k) => k.startsWith("fnm."));
    const differ = strings.filter((k) => DEFAULT_STRINGS.cs[k] !== DEFAULT_STRINGS.en[k]).length;
    expect(differ / strings.length).toBeGreaterThan(0.9);
    expect(strings.some((k) => /[ěščřžýáíéůú]/.test(DEFAULT_STRINGS.cs[k]))).toBe(true);
    for (const k of strings) expect(DEFAULT_STRINGS.de[k], k).toBeTruthy();
    // The placeholders the app fills are in every language.
    for (const [k, ph] of [["fnm.timeout", "{s}"], ["fnm.via", "{name}"], ["fnm.error.title", "{keyword}"], ["fnm.error.server", "{message}"], ["fnm.expect.values", "{values}"], ["fnm.pick", "{label}"], ["fnm.hint.value", "{value}"]] as const) {
      for (const lang of ["cs", "en", "de"] as const) expect(DEFAULT_STRINGS[lang][k], `${lang} ${k}`).toContain(ph);
    }
  });

  it("the app fills what the trees read and keeps the system's sender its own", () => {
    const list = java("ui/parts/MessageList.java");
    expect(list).toContain('ms.put("model"');
    expect(java("ui/bubble/ModelFace.java")).toMatch(/put\("glyph"/);
    expect(java("ui/parts/Parts.java")).toContain('showSheet("message.model")');
    for (const k of ['"known"', '"write"', '"senderId"', '"hasInputs"', '"guide"']) expect(java("ui/parts/Fn.java")).toContain(k);
    expect(java("chat/Payloads.java")).toContain("ModelIdentity.reservedSender(senderId)");
    expect(java("fn/ModelIdentity.java")).toContain('SYSTEM_MESSENGER_ID = "system-messenger"');
    expect(java("fn/ModelIdentity.java")).toContain("FN_RUN_TIMEOUT_MS = 30_000");
  });
});
