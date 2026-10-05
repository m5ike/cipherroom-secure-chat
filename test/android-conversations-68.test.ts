// @vitest-environment node
// 6.8 — rooms as Android conversations (server/android/design-68-conversations.ts,
// android/…/telecom/Conversations.java + ConversationPlan.java): the settings
// section on Settings › Notifications (on / off, names), the room menu's
// "Conversation on the phone" (a 6.8 action: a design using it needs app 6.8),
// the strings in cs / en / de, and that the app knows the settings, the action
// and the direct-share target the design speaks of.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACTIONS, DEFAULT_DESIGN, DEFAULT_MENUS, DEFAULT_SCREENS, DEFAULT_STRINGS, LANGS, sanitizeDesign, type ANode } from "../server/android/design";
import { ACTIONS_68 } from "../server/android/design-68";
import { designMinAppCode } from "../server/android/bundle";
import { AREA, CONVERSATION_ROWS, ROOM_MENU_ITEM } from "../server/android/design-68-conversations";

const walk = (n: ANode, f: (n: ANode) => void): void => { f(n); (n.children ?? []).forEach((c) => walk(c, f)); };
const all = (root: ANode): ANode[] => { const out: ANode[] = []; walk(root, (x) => out.push(x)); return out; };
const app = (...p: string[]) => readFileSync(join(__dirname, "..", "android", "app", "src", "main", ...p), "utf8");
const KEYS = ["conversations.section", "conversations.on", "conversations.hint", "conversations.names", "conversations.names.hint", "conversations.neutral", "conversations.gone", "conversations.room"];

describe("6.8 rooms as Android conversations — the design", () => {
  it("Settings › Notifications has the section after Privacy: the switch, then names only while it is on", () => {
    const nodes = all(DEFAULT_SCREENS["settings.notify"]);
    const ids = nodes.map((x) => x.id);
    const switches = nodes.filter((x) => x.el === "switch").map((x) => x.props?.setting);
    expect(switches).toContain("conversations.on");
    expect(switches).toContain("conversations.names");
    expect(ids.indexOf("s-conversations")).toBe(ids.indexOf("privacy-hint") + 1);
    const names = nodes.find((x) => x.id === "conversations-names")!;
    expect(names.if).toBe("$settings.conversations.on");
    expect(nodes.find((x) => x.id === "conversations")!.if).toBeUndefined();
    // added once, even if the patch ran again
    AREA.patch!(DEFAULT_SCREENS);
    expect(all(DEFAULT_SCREENS["settings.notify"]).filter((x) => x.id === "conversations").length).toBe(1);
    expect(CONVERSATION_ROWS.length).toBeGreaterThanOrEqual(4);
  });

  it("the room's menu opens the phone's settings of that conversation, before Leave, only while it is on", () => {
    const room = DEFAULT_MENUS.room;
    const i = room.findIndex((it) => it.id === "conversation");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(room[i]).toMatchObject({ action: "conversations.settings", arg: "room", if: "$settings.conversations.on", icon: "messages-square" });
    const leave = room.findIndex((it) => it.id === "leave");
    if (leave >= 0) expect(i).toBe(leave - 1);
    AREA.patchMenus!(DEFAULT_MENUS);
    expect(DEFAULT_MENUS.room.filter((it) => it.id === ROOM_MENU_ITEM.id).length).toBe(1);
  });

  it("the action is a 6.8 one: the default design stays valid and needs the 6.8 app", () => {
    expect(ACTIONS_68.map((a) => a.action)).toContain("conversations.settings");
    expect(ACTIONS.map((a) => a.action)).toContain("conversations.settings");
    expect(() => sanitizeDesign(DEFAULT_DESIGN)).not.toThrow();
    expect(designMinAppCode(DEFAULT_DESIGN)).toBeGreaterThanOrEqual(60800);
  });

  it("every string is there in cs, en and de — natural Czech with diacritics, the neutral label numbered", () => {
    for (const lang of LANGS) for (const k of KEYS) expect(DEFAULT_STRINGS[lang][k], `${lang} ${k}`).toBeTruthy();
    for (const lang of LANGS) expect(DEFAULT_STRINGS[lang]["conversations.neutral"]).toMatch(/\{n\}/);
    expect(DEFAULT_STRINGS.cs["conversations.on"]).toBe("Místnosti jako konverzace Androidu");
    expect(DEFAULT_STRINGS.cs["conversations.names.hint"]).toMatch(/odemčená/);
    expect(DEFAULT_STRINGS.de["conversations.names"]).toBe("Raumnamen anzeigen");
    // the three languages differ (nothing left untranslated)
    for (const k of ["conversations.on", "conversations.hint", "conversations.names.hint"]) {
      expect(new Set((["cs", "en", "de"] as const).map((l) => DEFAULT_STRINGS[l][k])).size, k).toBe(3);
    }
  });
});

describe("6.8 rooms as Android conversations — the app knows what the design names", () => {
  it("the settings and their defaults, the action, the strings it uses itself", () => {
    const plan = app("java", "cz", "m5cet", "app", "telecom", "ConversationPlan.java");
    expect(plan).toContain('SETTING_ON = "conversations.on"');
    expect(plan).toContain('SETTING_NAMES = "conversations.names"');
    expect(app("java", "cz", "m5cet", "app", "core", "Settings.java")).toContain("ConversationPlan.defaults(DEFAULTS)");
    expect(app("java", "cz", "m5cet", "app", "ui", "Actions.java")).toMatch(/case "conversations\.settings":/);
    const conv = app("java", "cz", "m5cet", "app", "telecom", "Conversations.java");
    expect(conv).toContain('"conversations.neutral"');
    expect(conv).toContain('"conversations.gone"');
  });

  it("direct share: the share target maps text to the rooms' category, the activity carries it", () => {
    const xml = app("res", "xml", "shortcuts.xml");
    const category = /CATEGORY = "([^"]+)"/.exec(app("java", "cz", "m5cet", "app", "telecom", "ConversationPlan.java"))![1];
    expect(xml).toContain('android:targetClass="cz.m5cet.app.ui.MainActivity"');
    expect(xml).toContain('android:mimeType="text/plain"');
    expect(xml).toContain(`<category android:name="${category}" />`);
    const manifest = app("AndroidManifest.xml");
    expect(manifest).toContain('<meta-data android:name="android.app.shortcuts" android:resource="@xml/shortcuts" />');
    expect(manifest).toContain('android:name=".telecom.Conversations$Alarm"');
  });

  it("notifications: a conversation only while the app is not locked (audit S11 kept)", () => {
    const notify = app("java", "cz", "m5cet", "app", "telecom", "Notify.java");
    expect(notify).toMatch(/locked \? null : Conversations\.get\(app\)\.forNotification\(roomKey\)/);
    expect(notify).toContain("setShortcutId(conversation).setLocusId(new LocusId(conversation))");
  });
});
