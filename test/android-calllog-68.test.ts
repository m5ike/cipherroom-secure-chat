// @vitest-environment node
//
// 6.8 — the call log and the History screen in the Android design
// (server/android/design-68-calllog.ts): the History tree passes the
// sanitizer and is a screen of the design, its actions are in the catalog
// (and make a build need the 6.8 app), the patches put its icon into the
// rooms' bar, its item into the main menu and the call log's rows into
// Settings › Calls (once, keeping what was there), every text it and the
// app's Java use is in Czech, English and German, and the settings it binds
// exist in the app (core/Settings.java).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ACTIONS, DEFAULT_DESIGN, DEFAULT_MENUS, DEFAULT_SCREENS, DEFAULT_STRINGS, SCREEN_IDS, sanitizeScreen, type AndroidDesign, type ANode, type MenuItem } from "../server/android/design";
import { ACTIONS_68 } from "../server/android/design-68";
import { AREA } from "../server/android/design-68-calllog";
import { designMinAppCode } from "../server/android/bundle";

const walk = (n: ANode, f: (n: ANode) => void): void => { f(n); (n.children ?? []).forEach((c) => walk(c, f)); };
const find = (n: ANode, id: string): ANode | null => { let out: ANode | null = null; walk(n, (x) => { if (!out && x.id === id) out = x; }); return out; };
const JAVA = join(__dirname, "..", "android", "app", "src", "main", "java", "cz", "m5cet", "app");
const java = (...p: string[]) => readFileSync(join(JAVA, ...p), "utf8");

describe("android call log and History (design-68-calllog)", () => {
  it("the History tree passes the sanitizer and is a screen of the design", () => {
    expect(Object.keys(AREA.trees ?? {})).toEqual(["log"]);
    const problems: string[] = [];
    sanitizeScreen(structuredClone(AREA.trees!.log), "log", problems);
    expect(problems).toEqual([]);
    expect(SCREEN_IDS).toContain("log");
    expect(DEFAULT_SCREENS.log).toBeTruthy();
    for (const id of ["rooms", "settings.calls"]) {
      const p: string[] = [];
      sanitizeScreen(structuredClone(DEFAULT_SCREENS[id]), id, p);
      expect(p, id).toEqual([]);
    }
  });

  it("its actions are 6.8's, in the catalog, implemented in Java — and a build using them needs the 6.8 app", () => {
    const known = new Set(ACTIONS.map((a) => a.action));
    const mine = (AREA.actions ?? []).map((a) => a.action);
    expect(mine.sort()).toEqual(["calllog.call", "calllog.clear", "calllog.item", "calllog.open", "calllog.refresh", "calllog.system"]);
    const actions = java("ui", "Actions.java");
    for (const a of mine) {
      expect(known.has(a), a).toBe(true);
      expect(ACTIONS_68.map((x) => x.action)).toContain(a);
      expect(actions, a).toContain(`"${a}"`);
    }
    const used = new Set<string>();
    for (const tree of [AREA.trees!.log, DEFAULT_SCREENS.rooms, DEFAULT_SCREENS["settings.calls"]]) walk(tree, (n) => { for (const h of Object.values(n.on ?? {})) used.add(h.action); });
    for (const a of used) expect(known.has(a), a).toBe(true);
    for (const a of ["calllog.open", "calllog.refresh", "calllog.item", "calllog.call", "calllog.system", "calllog.clear"]) expect(used.has(a), a).toBe(true);

    const only = (root: ANode): AndroidDesign => ({ ...DEFAULT_DESIGN, screens: { log: root }, menus: {} });
    expect(designMinAppCode(only(AREA.trees!.log))).toBe(60800);
    expect(designMinAppCode(DEFAULT_DESIGN)).toBe(60800);
  });

  it("the rooms' bar and the main menu open the History, once", () => {
    const screens = structuredClone(DEFAULT_SCREENS);
    const menus: Record<string, MenuItem[]> = structuredClone(DEFAULT_MENUS);
    const barBefore = find(screens.rooms, "bar")!.children!.map((c) => c.id);
    AREA.patch!(screens);
    AREA.patchMenus!(menus);
    const bar = find(screens.rooms, "bar")!.children!.map((c) => c.id);
    expect(bar).toEqual(barBefore);
    expect(bar.filter((id) => id === "log")).toHaveLength(1);
    expect(bar.indexOf("log")).toBe(bar.indexOf("add") - 1);
    expect(find(screens.rooms, "log")!.on?.click?.action).toBe("calllog.open");
    expect(menus.main.filter((m) => m.id === "log")).toHaveLength(1);
    expect(menus.main[menus.main.findIndex((m) => m.id === "settings") + 1].action).toBe("calllog.open");
  });

  it("Settings › Calls gets the call log's rows under its switch, once, keeping what was there", () => {
    const calls = DEFAULT_SCREENS["settings.calls"];
    const list = find(calls, "list")!.children!.map((c) => c.id);
    for (const id of ["audiotext", "speaker", "log"]) expect(list).toContain(id);
    expect(list.indexOf("calllog-hint")).toBe(list.indexOf("log") + 1);
    const settings: string[] = [];
    walk(calls, (n) => { if (n.props?.setting) settings.push(String(n.props.setting)); });
    expect(settings).toEqual(expect.arrayContaining(["callLog", "calls.logName", "calls.history"]));
    const select = find(calls, "calllog-name-select")!;
    expect(String(select.props?.options).split("|").map((o) => o.split(":")[0])).toEqual(["app", "room", "people"]);
    expect(find(calls, "calllog-name")!.if).toBe("$settings.callLog");
    // Patching again changes nothing.
    const again = structuredClone(DEFAULT_SCREENS);
    AREA.patch!(again);
    expect(find(again["settings.calls"], "list")!.children!.map((c) => c.id)).toEqual(list);
  });

  it("the settings it binds exist in the app with the neutral defaults", () => {
    const s = java("core", "Settings.java");
    expect(s).toMatch(/DEFAULTS\.put\("calls\.logName", "app"\)/);
    expect(s).toMatch(/DEFAULTS\.put\("calls\.history", true\)/);
    expect(s).toMatch(/DEFAULTS\.put\("callLog", false\)/);
  });

  it("every text exists in Czech, English and German — those the Java uses too", () => {
    const s = AREA.strings!;
    const keys = new Set((["cs", "en", "de"] as const).flatMap((l) => Object.keys(s[l] ?? {})));
    for (const l of ["cs", "en", "de"] as const) for (const k of keys) expect(s[l]?.[k], `${l} ${k}`).toBeTruthy();
    const used = new Set<string>();
    const scan = (v: unknown): void => {
      if (typeof v === "string") for (const m of v.matchAll(/_\(?'([A-Za-z0-9_.]+)'/g)) used.add(m[1]);
      else if (v && typeof v === "object") Object.values(v).forEach(scan);
    };
    scan(AREA.trees);
    scan(DEFAULT_SCREENS.rooms);
    scan(DEFAULT_SCREENS["settings.calls"]);
    scan(DEFAULT_MENUS.main);
    // The keys the Java of 6.8 asks for (app.t / t(a, …)), with the kinds and directions it puts together.
    for (const file of ["ui/parts/CallLogUi.java", "telecom/CallRing.java"]) {
      for (const m of java(...file.split("/")).matchAll(/\bt\((?:a, )?"([a-z][A-Za-z0-9_.]+)"\)/g)) used.add(m[1]);
    }
    for (const k of ["in", "out", "missed", "declined"]) used.add(`log.dir.${k}`);
    for (const k of ["sealed", "tap", "vanish", "hidden"]) used.add(`log.kind.${k}`);
    expect(used.size).toBeGreaterThan(30);
    for (const k of used) expect(k in DEFAULT_STRINGS.cs && k in DEFAULT_STRINGS.en && k in DEFAULT_STRINGS.de, k).toBe(true);
    // Czech with its diacritics.
    expect(DEFAULT_STRINGS.cs["log.filter.missed"]).toBe("Zmeškané");
    expect(DEFAULT_STRINGS.cs["ring.decline"]).toBe("Odmítnout");
  });

  it("the phone's call log never gets a number, and the old 'm5cet:' rows are fixed", () => {
    const bridge = java("telecom", "CallLogBridge.java");
    expect(bridge).toContain('v.put(CallLog.Calls.NUMBER, "")');
    expect(bridge).toContain("PRESENTATION_UNKNOWN");
    expect(bridge).not.toMatch(/NUMBER, "m5cet:/);
    expect(bridge).toContain("LIKE 'm5cet:%'");
    // A wipe takes the rows, the account and the history.
    expect(java("security", "Wiper.java")).toContain("CallLogBridge.wipe(app)");
    // The calling account's service refuses every connection.
    const service = java("telecom", "M5ConnectionService.java");
    expect(service.match(/createFailedConnection/g)).toHaveLength(2);
    const manifest = readFileSync(join(__dirname, "..", "android", "app", "src", "main", "AndroidManifest.xml"), "utf8");
    expect(manifest).toContain("android.permission.MANAGE_OWN_CALLS");
    expect(manifest).toMatch(/M5ConnectionService"[\s\S]*?BIND_TELECOM_CONNECTION_SERVICE/);
    expect(readdirSync(join(JAVA, "telecom"))).toEqual(expect.arrayContaining(["CallLogBridge.java", "CallRing.java", "M5ConnectionService.java"]));
  });
});
