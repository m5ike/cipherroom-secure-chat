// @vitest-environment node
// 6.8 — "Send another way" on Android (server/android/design-68-send.ts): the
// long press on Send offers options of the messages, not actions — every row
// switches an option (send.option) and the sheet stays; an option that is on
// has its icon green with a tick; the individual code shows its field and a
// button that makes one up only when it is on (vanishing its time); the app
// applies them on Send (android/…/chat/SendPlan). A build using the new parts
// needs the 6.8 app; every text exists in Czech, English and German.

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { ACTIONS, DEFAULT_DESIGN, DEFAULT_SCREENS, DEFAULT_STRINGS, sanitizeScreen, type AndroidDesign, type ANode } from "../server/android/design";
import { designMinAppCode } from "../server/android/bundle";
import { ACTIONS_68 } from "../server/android/design-68";
import { AREA, SEND_OPTIONS, VANISH_OPTIONS } from "../server/android/design-68-send";

const find = (n: ANode, id: string): ANode | null => {
  if (n.id === id) return n;
  for (const c of n.children ?? []) { const f = find(c, id); if (f) return f; }
  return null;
};
const all = (n: ANode): ANode[] => [n, ...(n.children ?? []).flatMap(all)];

const sheet = DEFAULT_SCREENS["send.options"];
const ON: Record<(typeof SEND_OPTIONS)[number], string> = {
  asVoice: "$composer.asVoice", voiceText: "$composer.voiceText", seal: "$composer.sealed", vanish: "$composer.vanish > 0", tap: "$composer.tap",
};

describe("android send options (design-68-send)", () => {
  it("the sheet is the area's, passes the sanitizer and needs the 6.8 app", () => {
    expect(sheet).toEqual(AREA.trees!["send.options"]);
    const problems: string[] = [];
    sanitizeScreen(structuredClone(sheet), "send.options", problems);
    expect(problems).toEqual([]);
    expect(ACTIONS.some((a) => a.action === "send.option")).toBe(true);
    expect(ACTIONS_68.map((a) => a.action)).toContain("send.option");
    const withSheet: AndroidDesign = { ...DEFAULT_DESIGN, screens: { "send.options": sheet }, menus: {} };
    expect(designMinAppCode(withSheet)).toBe(60800);
    expect(designMinAppCode(DEFAULT_DESIGN)).toBe(60800);
  });

  it("every row is an option of the message, switched by send.option — nothing is sent from the sheet", () => {
    const list = find(sheet, "list")!;
    const rows = list.children!.filter((c) => c.on?.click?.action === "send.option").map((c) => c.id);
    expect(rows).toEqual([...SEND_OPTIONS]);
    for (const id of SEND_OPTIONS) expect(find(sheet, id)!.on!.click).toEqual({ action: "send.option", arg: id });
    // No immediate actions any more (6.1's sheet sent "as voice" at once).
    const actions = all(sheet).flatMap((n) => Object.values(n.on ?? {}).map((h) => h.action));
    expect(actions).not.toContain("compose");
    expect(actions).not.toContain("message.kind");
    // The two voice options keep their hints; every option says what it does.
    for (const id of SEND_OPTIONS) expect(find(sheet, `${id}-hint`)?.text).toMatch(/^\{_'send\.opt\.\w+Hint'\}$/);
  });

  it("an option that is on: its icon green with a tick, the row raised; off: neutral", () => {
    for (const id of SEND_OPTIONS) {
      const on = ON[id];
      const icon = find(sheet, `${id}-icon`)!;
      expect(icon.props?.color).toBe(`=${on} ? '@success' : '@muted'`);
      const tick = find(sheet, `${id}-tick`)!;
      expect(tick.if).toBe(on);
      expect(tick.props).toMatchObject({ icon: "circle-check", color: "@success" });
      expect(find(sheet, id)!.style?.bg).toBe(`=${on} ? '@surfaceVariant' : '@surface'`);
    }
  });

  it("the code: its field and a button that makes one up, only when it is on", () => {
    const code = find(sheet, "seal-code")!;
    expect(code.if).toBe("$composer.sealed");
    const input = find(code, "seal-input")!;
    expect(input.el).toBe("input");
    expect(input.props).toMatchObject({ bind: "msgSeal", hint: "{_'send.code.hint'}" });
    const dice = find(code, "seal-new")!;
    expect(dice.el).toBe("iconButton");
    expect(dice.props?.icon).toBe("dice-5");
    expect(dice.on?.click).toEqual({ action: "send.option", arg: "newCode" });
    // Nowhere else: the field and the button live only under the code's option.
    expect(all(sheet).filter((n) => n.el === "input").map((n) => n.id)).toEqual(["seal-input"]);
    // A voice message goes without the code: said when both are on.
    expect(find(code, "seal-voice")?.if).toBe("$composer.asVoice");
  });

  it("vanishing: how long, only when it is on; Done closes, \"turn all off\" clears", () => {
    const time = find(sheet, "vanish-time")!;
    expect(time.if).toBe("$composer.vanish > 0");
    const select = find(time, "vanish-select")!;
    expect(select.props).toMatchObject({ bind: "msgVanish", options: VANISH_OPTIONS });
    expect(select.on?.change).toEqual({ action: "send.option", arg: "vanish:{$value}" });
    expect(find(sheet, "done")?.on?.click).toEqual({ action: "sheet.close" });
    expect(find(sheet, "clear")).toMatchObject({ if: "$composer.count > 0", on: { click: { action: "send.option", arg: "none" } } });
  });

  it("every text exists in Czech, English and German — the sheet's and the app's", () => {
    const strings = AREA.strings!;
    const keys = new Set((["cs", "en", "de"] as const).flatMap((l) => Object.keys(strings[l] ?? {})));
    for (const l of ["cs", "en", "de"] as const) for (const k of keys) expect(strings[l]?.[k], `${l} ${k}`).toBeTruthy();
    const used = new Set<string>();
    const scan = (v: unknown): void => {
      if (typeof v === "string") for (const m of v.matchAll(/_\(?'([A-Za-z0-9_.-]+)'/g)) used.add(m[1]);
      else if (v && typeof v === "object") Object.values(v).forEach(scan);
    };
    scan(sheet);
    // What the Java says (ui/parts/Composer: the chips, Send's label, the code left out of a voice message).
    for (const k of ["send.opt.asVoice", "send.opt.voiceText", "send.btn.asVoice", "send.btn.voiceText", "send.code.noVoice", "msgkind.tap", "msgkind.sealed"]) used.add(k);
    for (const k of used) for (const l of ["cs", "en", "de"] as const) expect(DEFAULT_STRINGS[l][k], `${l} ${k}`).toBeTruthy();
    // Natural Czech, with its diacritics.
    expect(DEFAULT_STRINGS.cs["send.intro"]).toMatch(/[áčďéěíňóřšťúůýž]/);
    expect(DEFAULT_STRINGS.cs["send.code.new"]).toBe("Vymyslet kód");
  });

  it("the app implements the action and applies the options on Send", () => {
    const java = (p: string) => readFileSync(new URL(`../android/app/src/main/java/cz/m5cet/app/${p}`, import.meta.url), "utf8");
    expect(java("ui/Actions.java")).toContain('case "send.option": a.parts.sendOption(s);');
    const composer = java("ui/parts/Composer.java");
    expect(composer).toMatch(/SendPlan\.of\(a\.form\(\)\)\.step\(/);
    // The sheet's scope has the new values.
    for (const k of ["asVoice", "voiceText", "sealCode", "count"]) expect(java("ui/parts/Parts.java")).toContain(`"${k}"`);
  });
});
