// @vitest-environment node
//
// 6.7 — the profile in the Android design (server/android/design-67-profile.ts):
// the editor's tree passes the sanitizer, every text it and the app use is
// in Czech, English and German, its actions are in the catalog, the patches
// put the profile into Settings › User and a person's detail (once), and the
// audiences offered are exactly the model's.

import { describe, it, expect } from "vitest";
import { ACTIONS, DEFAULT_SCREENS, DEFAULT_STRINGS, SCREEN_IDS, sanitizeScreen, type ANode } from "../server/android/design";
import { AREA } from "../server/android/design-67-profile";
import { AUDIENCES, FIELD_TYPES } from "../client/src/lib/profile/model";

const walk = (n: ANode, f: (n: ANode) => void): void => { f(n); (n.children ?? []).forEach((c) => walk(c, f)); };
const find = (n: ANode, id: string): ANode | null => { let out: ANode | null = null; walk(n, (x) => { if (!out && x.id === id) out = x; }); return out; };

describe("android profile (design-67-profile)", () => {
  it("its tree passes the sanitizer and is a screen of the design", () => {
    for (const [id, tree] of Object.entries(AREA.trees ?? {})) {
      const problems: string[] = [];
      sanitizeScreen(structuredClone(tree), id, problems);
      expect(problems, id).toEqual([]);
      expect(SCREEN_IDS).toContain(id);
      expect(DEFAULT_SCREENS[id]).toBeTruthy();
    }
  });

  it("every action it names is in the catalog (Actions.java implements profile.*)", () => {
    const known = new Set(ACTIONS.map((a) => a.action));
    for (const a of AREA.actions ?? []) expect(known.has(a.action), a.action).toBe(true);
    const used = new Set<string>();
    for (const tree of [...Object.values(AREA.trees ?? {}), DEFAULT_SCREENS["users.person"], DEFAULT_SCREENS["settings.user"]]) walk(tree, (n) => { for (const h of Object.values(n.on ?? {})) used.add(h.action); });
    for (const a of used) expect(known.has(a), a).toBe(true);
    for (const a of ["profile.open", "profile.pick", "profile.field", "profile.save", "profile.public"]) expect(used.has(a), a).toBe(true);
  });

  it("every text exists in Czech, English and German — the kinds and audiences of the model too", () => {
    const s = AREA.strings!;
    const keys = new Set((["cs", "en", "de"] as const).flatMap((l) => Object.keys(s[l] ?? {})));
    for (const l of ["cs", "en", "de"] as const) for (const k of keys) expect(s[l]?.[k], `${l} ${k}`).toBeTruthy();
    for (const t of FIELD_TYPES) expect(keys.has(`pf.type.${t}`), t).toBe(true);
    for (const a of AUDIENCES) { expect(keys.has(`pf.aud.${a}`)).toBe(true); expect(keys.has(`pf.aud.${a}.hint`)).toBe(true); }
    const used = new Set<string>();
    const scan = (v: unknown): void => {
      if (typeof v === "string") for (const m of v.matchAll(/_\(?'([A-Za-z0-9_.]+)'/g)) used.add(m[1]);
      else if (v && typeof v === "object") Object.values(v).forEach(scan);
    };
    scan(AREA.trees);
    scan(DEFAULT_SCREENS["users.person"]);
    for (const k of used) expect(k in DEFAULT_STRINGS.cs && k in DEFAULT_STRINGS.de && k in DEFAULT_STRINGS.en, k).toBe(true);
  });

  it("offers exactly the three audiences, and binds what the app reads", () => {
    const tree = AREA.trees!["settings.profile"];
    const binds: string[] = [];
    walk(tree, (n) => {
      if (n.el === "segmented") {
        expect(String(n.props?.options).split("|").map((o) => o.split(":")[0])).toEqual([...AUDIENCES]);
        binds.push(String(n.props?.bind));
      }
      if (n.el === "input") binds.push(String(n.props?.bind));
    });
    expect(binds.sort()).toEqual(["pfAbout", "pfAboutAud", "pfAvatarAud", "pfCoverAud", "pfNick", "pfNickAud", "pfPreview"]);
  });

  it("patches Settings › User and a person's detail once, keeping what was there", () => {
    const screens = structuredClone(DEFAULT_SCREENS);
    const before = find(screens["users.person"], "body")!.children!.map((c) => c.id);
    AREA.patch!(screens);
    AREA.patch!(screens);
    const card = find(screens["settings.user"], "card")!;
    expect(card.children!.filter((c) => c.id === "profile")).toHaveLength(1);
    expect(card.children!.find((c) => c.id === "profile")!.on?.click?.action).toBe("profile.open");
    const body = find(screens["users.person"], "body")!.children!.map((c) => c.id);
    for (const id of before) expect(body).toContain(id);
    expect(body.filter((id) => id === "pf-room")).toHaveLength(1);
    expect(body.indexOf("pf-room")).toBe(body.indexOf("head") + 1);
    // The merged design has it already.
    expect(find(DEFAULT_SCREENS["users.person"], "pf-public")).toBeTruthy();
    const problems: string[] = [];
    sanitizeScreen(structuredClone(DEFAULT_SCREENS["users.person"]), "users.person", problems);
    expect(problems).toEqual([]);
  });
});
