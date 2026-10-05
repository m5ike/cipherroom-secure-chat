// @vitest-environment node
// 6.10 — the chat screen on Android (server/android/design-610-chat.ts): the
// sender's avatar at the TOP of a received message's row, larger, tappable
// (their room profile); one person's run shows it once; the message replied
// to is a quote card on top of the reply that scrolls to the original; the
// forward sheet (a room, then everyone or one person); the profile and who
// sees what easy to find (Settings' card, the main menu, my own detail, the
// editor's summary and per-field audience chips). The swipe gestures are the
// app's (ui/bubble/BubbleSwipe, JVM-tested); here: the trees, the actions,
// the version gate and the texts in Czech, English and German.

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { ACTIONS, DEFAULT_DESIGN, DEFAULT_MENUS, DEFAULT_SCREENS, DEFAULT_STRINGS, SCREEN_IDS, sanitizeScreen, type AndroidDesign, type ANode, type MenuItem } from "../server/android/design";
import { designMinAppCode } from "../server/android/bundle";
import { ACTIONS_610 } from "../server/android/design-610";
import { AREA, AVATAR, PROFILE_MENU_ITEM } from "../server/android/design-610-chat";

const walk = (n: ANode, f: (n: ANode) => void): void => { f(n); (n.children ?? []).forEach((c) => walk(c, f)); };
const find = (n: ANode, id: string): ANode | null => { let out: ANode | null = null; walk(n, (x) => { if (!out && x.id === id) out = x; }); return out; };
const ids = (n: ANode): string[] => { const out: string[] = []; walk(n, (x) => out.push(x.id)); return out; };
const clean = (tree: ANode, id: string): string[] => { const p: string[] = []; sanitizeScreen(structuredClone(tree), id, p); return p; };
const java = (p: string) => readFileSync(new URL(`../android/app/src/main/java/cz/m5cet/app/${p}`, import.meta.url), "utf8");

const IN = DEFAULT_SCREENS["message.in"];
const OUT = DEFAULT_SCREENS["message.out"];

describe("android chat 6.10 — the bubbles", () => {
  it("the avatar sits at the TOP of the row, larger, and opens the sender's profile", () => {
    expect(IN.el).toBe("row");
    expect(IN.style?.align).toBe("start");
    const face = find(IN, "face")!;
    expect(face.style?.self).toBe("start");
    expect(face.on?.click).toEqual({ action: "msg.sender", arg: "{$msg.id}" });
    expect(IN.children![0].id).toBe("face");
    const avatar = find(face, "avatar")!;
    expect(avatar.el).toBe("avatar");
    expect(Number(avatar.props?.size)).toBe(AVATAR);
    expect(AVATAR).toBeGreaterThanOrEqual(36);
    expect(AVATAR).toBeLessThanOrEqual(40);
    // A photo the sender shares with the room instead of the monogram — a local data: image, never a web address.
    const photo = find(face, "photo")!;
    expect(photo.el).toBe("image");
    expect(photo.props?.src).toBe("=$msg.photo");
    expect(avatar.if).toContain("!$msg.photo"); // 6.11 adds: not for a model's answer (its own face, design-611-fn.ts)
    expect(photo.style).toMatchObject({ width: AVATAR, height: AVATAR, radius: AVATAR / 2 });
  });

  it("a run of one person's messages shows the face and the name once, the bubbles stay in line", () => {
    expect(find(IN, "face")!.if).toBe("!$msg.cont");
    const gap = find(IN, "face-gap")!;
    expect(gap).toMatchObject({ el: "spacer", if: "$msg.cont", props: { size: AVATAR } });
    expect(find(IN, "sender")!.if).toBe("!$msg.cont");
  });

  it("the replied message is a quote card at the top of the reply bubble, a tap goes to the original", () => {
    for (const [tree, out] of [[IN, false], [OUT, true]] as const) {
      expect(find(tree, "reply")).toBeNull(); // the 6.1 one-line caption is gone
      const quote = find(tree, "quote")!;
      expect(quote.el).toBe("row");
      expect(quote.if).toBe("$msg.replyTo");
      expect(quote.on?.click).toEqual({ action: "msg.quote", arg: "{$msg.replyTo.id}" });
      expect(quote.children!.map((c) => c.id)).toEqual(["quote-bar", "quote-col", "quote-icon"]);
      expect(find(quote, "quote-bar")!.style).toMatchObject({ width: 3, self: "stretch" });
      expect(find(quote, "quote-sender")!.text).toBe("{$msg.replyTo.sender}");
      expect(find(quote, "quote-text")!.text).toBe("{$msg.replyTo.text}");
      expect(find(quote, "quote-text")!.style?.lines).toBe(2);
      expect(find(quote, "quote-icon")).toMatchObject({ if: "$msg.replyTo.icon", props: { icon: "=$msg.replyTo.icon" } });
      // Inside the bubble, before its body: it is part of the reply.
      const bubble = find(tree, "bubble")!;
      const kids = bubble.children!.map((c) => c.id);
      expect(kids.indexOf("quote")).toBeGreaterThanOrEqual(0);
      expect(kids.indexOf("quote")).toBeLessThan(kids.indexOf("body"));
      // Received: the sender's colour; mine: my bubble's.
      if (out) expect(find(quote, "quote-bar")!.style?.bg).toBe("@onBubbleOut");
      else expect(String(find(quote, "quote-bar")!.style?.bg)).toContain("$msg.replyTo.color");
    }
  });

  it("the trees pass the sanitizer, keep the 6.2 / 6.7 parts, and patching twice is once", () => {
    for (const id of ["message.in", "message.out"]) expect(clean(DEFAULT_SCREENS[id], id), id).toEqual([]);
    for (const id of ["body", "meta", "info", "hold", "source"]) { expect(find(IN, id), id).toBeTruthy(); expect(find(OUT, id), id).toBeTruthy(); }
    const screens = structuredClone(DEFAULT_SCREENS);
    const before = Object.fromEntries(["message.in", "message.out", "settings", "settings.profile", "users.person"].map((id) => [id, ids(screens[id])]));
    AREA.patch!(screens);
    for (const [id, list] of Object.entries(before)) expect(ids(screens[id]), id).toEqual(list);
  });

  it("an operator's own bubble without these parts is left alone", () => {
    const own: ANode = { id: "row", el: "row", children: [{ id: "bubble", el: "column", children: [{ id: "body", el: "slot", props: { name: "msgBody" } }] }] };
    const screens = { "message.in": structuredClone(own), "message.out": structuredClone(own) };
    AREA.patch!(screens);
    expect(screens["message.in"]).toEqual({ ...own, style: { align: "start" } });
    expect(screens["message.out"]).toEqual(own);
  });
});

describe("android chat 6.10 — the sheets", () => {
  it("both are screens of the design and pass the sanitizer", () => {
    for (const id of ["message.sender", "message.forward"]) {
      expect(SCREEN_IDS).toContain(id);
      expect(DEFAULT_SCREENS[id]).toEqual(AREA.trees![id]);
      expect(clean(DEFAULT_SCREENS[id], id), id).toEqual([]);
    }
  });

  it("the sender's sheet shows only what they share with the room, else says they share nothing", () => {
    const s = DEFAULT_SCREENS["message.sender"];
    const reads = new Set<string>();
    walk(s, (n) => {
      for (const v of [n.text, n.if, n.each, ...Object.values(n.props ?? {})]) if (typeof v === "string") for (const m of v.matchAll(/\$form\.sender\.([A-Za-z.]+)/g)) reads.add(m[1]);
    });
    // The profile it draws is the room view ($form.sender.profile: ProfileUi.sender ← WhoSees.senderView), never a "public" lookup.
    for (const r of reads) expect(r, r).toMatch(/^(profile\.(cover|about|fields)|photo|name|title|nickDiffers|me|function|username|present|has|canMessage|id)$/);
    expect(find(s, "none")!.if).toBe("!$form.sender.has");
    expect(find(s, "field")!.each).toBe("$form.sender.profile.fields");
    expect(find(s, "message")!.on?.click).toEqual({ action: "people.message", arg: "{$form.sender.id}" });
    expect(find(s, "more")!.on?.click).toEqual({ action: "people.open", arg: "{$form.sender.id}" });
    expect(find(s, "mine")).toMatchObject({ if: "$form.sender.me", on: { click: { action: "profile.open" } } });
    expect(find(s, "note-text")!.text).toContain("sender.note");
  });

  it("forward: the rooms, then everyone or one person privately", () => {
    const f = DEFAULT_SCREENS["message.forward"];
    expect(find(f, "rooms")!.if).toBe("$form.forward.step == 'room'");
    expect(find(f, "room")).toMatchObject({ each: "$form.forward.rooms", as: "fr", on: { click: { action: "msg.forwardRoom", arg: "{$fr.key}" } } });
    expect(find(f, "who")!.if).toBe("$form.forward.step == 'who'");
    expect(find(f, "all")!.on?.click).toEqual({ action: "msg.forwardTo" });
    expect(find(f, "person")).toMatchObject({ each: "$form.forward.people", as: "fp", on: { click: { action: "msg.forwardTo", arg: "{$fp.id}" } } });
    expect(find(f, "back")).toMatchObject({ if: "$form.forward.canBack", on: { click: { action: "msg.forwardRoom" } } });
    expect(find(f, "close")!.on?.click).toEqual({ action: "sheet.close" });
    expect(find(f, "whole")!.if).toBe("$form.forward.wholeRoom");
    // What goes is shown first.
    expect(find(f, "what-text")!.text).toBe("{$form.forward.text}");
  });
});

describe("android chat 6.10 — the profile and who sees what", () => {
  it("Settings starts with my profile card: photo, name, the audiences' counts → the editor", () => {
    const list = find(DEFAULT_SCREENS.settings, "list")!;
    const card = list.children![0];
    expect(card.id).toBe("me");
    expect(card.on?.click).toEqual({ action: "profile.open" });
    expect(find(card, "me-photo")!.props?.src).toBe("=$myProfile.photo");
    for (const [id, aud] of [["me-public", "public"], ["me-room", "room"], ["me-only", "me"]]) expect(find(card, id)!.text).toContain(`$myProfile.counts.${aud}`);
    expect(find(list, "user")).toBeTruthy(); // Settings › User stays (with the 6.7 "Public profile" button)
    expect(find(DEFAULT_SCREENS["settings.user"], "profile")!.on?.click?.action).toBe("profile.open");
    expect(clean(DEFAULT_SCREENS.settings, "settings")).toEqual([]);
  });

  it("the main menu has My profile on top (signed in), my own detail an Edit button", () => {
    const main = DEFAULT_MENUS.main;
    const at = main.findIndex((m) => m.id === "profile");
    expect(main[at]).toEqual(PROFILE_MENU_ITEM);
    expect(main[at + 1].id).toBe("settings");
    expect(main.filter((m) => m.id === "profile")).toHaveLength(1);
    const menus: Record<string, MenuItem[]> = structuredClone(DEFAULT_MENUS);
    AREA.patchMenus!(menus);
    expect(menus.main).toEqual(main);
    const mine = find(DEFAULT_SCREENS["users.person"], "pf-mine")!;
    expect(mine).toMatchObject({ if: "$form.person.me", on: { click: { action: "profile.open" } } });
    expect(clean(DEFAULT_SCREENS["users.person"], "users.person")).toEqual([]);
  });

  it("the editor sums up who sees what, each field's audience is a chip, the preview stays", () => {
    const ed = DEFAULT_SCREENS["settings.profile"];
    const edit = find(ed, "edit")!;
    const kids = edit.children!.map((c) => c.id);
    expect(kids.indexOf("who")).toBe(kids.indexOf("lg-public") + 2); // its label, then the box, right under the legend
    for (const [id, v] of [["who-public", "public"], ["who-room", "room"], ["who-me", "me"]]) {
      expect(find(ed, `${id}-label`)!.text).toContain(`$profile.whoSees.${v}.count`);
      expect(find(ed, `${id}-items`)!.text).toBe(`{$profile.whoSees.${v}.text}`);
    }
    const chip = find(ed, "field-aud")!;
    expect(chip.el).toBe("row");
    expect(chip.on?.click).toEqual({ action: "profile.audience", arg: "{$f.index}" });
    expect(find(chip, "field-aud-text")!.text).toBe("{$f.audLabel}");
    for (const id of ["preview-label", "preview-aud", "preview", "nick-aud", "about-aud", "photo-aud", "cover-aud"]) expect(find(ed, id), id).toBeTruthy();
    expect(clean(ed, "settings.profile")).toEqual([]);
  });
});

describe("android chat 6.10 — actions, version, texts", () => {
  it("its actions are in the catalog, the app implements them, a build using them needs the 6.10 app", () => {
    const known = new Set(ACTIONS.map((a) => a.action));
    const mine = (AREA.actions ?? []).map((a) => a.action);
    expect(mine.sort()).toEqual(["msg.forwardRoom", "msg.forwardTo", "msg.quote", "msg.sender", "profile.audience"]);
    for (const a of mine) { expect(known.has(a), a).toBe(true); expect(ACTIONS_610.map((x) => x.action)).toContain(a); }
    const actions = java("ui/Actions.java");
    for (const a of mine) expect(actions, a).toContain(`case "${a}":`);
    // Every action the patched trees and sheets name exists.
    for (const id of ["message.in", "message.out", "message.sender", "message.forward", "settings", "settings.profile", "users.person"]) {
      walk(DEFAULT_SCREENS[id], (n) => { for (const h of Object.values(n.on ?? {})) expect(known.has(h.action), `${id} ${h.action}`).toBe(true); });
    }
    const only = (root: ANode): AndroidDesign => ({ ...DEFAULT_DESIGN, screens: { "message.in": root }, menus: {} });
    expect(designMinAppCode(only({ id: "row", el: "row", on: { click: { action: "msg.sender", arg: "x" } } }))).toBe(61000);
    expect(designMinAppCode(DEFAULT_DESIGN)).toBe(61000);
  });

  it("the app fills what the trees read", () => {
    const list = java("ui/parts/MessageList.java");
    for (const k of ['"cont"', '"photo"', '"replyTo"']) expect(list).toContain(k);
    expect(list).toContain("new Swiper()");
    expect(java("ui/MainActivity.java")).toMatch(/case "settings": s\.put\("myProfile"/);
    const profile = java("ui/parts/ProfileUi.java");
    for (const k of ['"whoSees"', '"audLabel"', '"canMessage"', '"nickDiffers"']) expect(profile).toContain(k);
    const parts = java("ui/parts/Parts.java");
    for (const k of ['"step"', '"canBack"', '"wholeRoom"', '"hasPeople"', 'showSheet("message.forward")', 'showSheet("message.sender")']) expect(parts).toContain(k);
  });

  it("every text exists in Czech, English and German — the trees' and the app's", () => {
    const s = AREA.strings!;
    const keys = new Set((["cs", "en", "de"] as const).flatMap((l) => Object.keys(s[l] ?? {})));
    for (const l of ["cs", "en", "de"] as const) for (const k of keys) expect(s[l]?.[k], `${l} ${k}`).toBeTruthy();
    const used = new Set<string>();
    const scan = (v: unknown): void => {
      if (typeof v === "string") for (const m of v.matchAll(/_\(?'([A-Za-z0-9_.-]+)'/g)) used.add(m[1]);
      else if (v && typeof v === "object") Object.values(v).forEach(scan);
    };
    for (const id of ["message.in", "message.out", "message.sender", "message.forward", "settings", "settings.profile", "users.person"]) scan(DEFAULT_SCREENS[id]);
    scan(DEFAULT_MENUS.main);
    // What the Java says (MessageList, Parts, ProfileUi, ReplyQuote).
    for (const k of ["quote.you", "quote.photo", "quote.audio", "quote.video", "quote.file", "quote.position", "quote.sealed", "quote.vanished", "quote.empty",
      "quote.go", "quote.replyTo", "quote.hidden", "quote.notLoaded", "sender.profile", "pf.who.nothing", "notify.reply", "msg.forward", "room.offline",
      "pf.nickname", "pf.about", "pf.avatar", "pf.cover", "pf.aud.me", "pf.aud.room", "pf.aud.public", "pf.aud.room.short", "set.user.signedOut"]) used.add(k);
    for (const k of used) for (const l of ["cs", "en", "de"] as const) expect(DEFAULT_STRINGS[l][k], `${l} ${k}`).toBeTruthy();
    // Natural Czech, with its diacritics.
    expect(DEFAULT_STRINGS.cs["quote.notLoaded"]).toMatch(/[áčďéěíňóřšťúůýž]/);
    expect(DEFAULT_STRINGS.cs["me.edit"]).toBe("Upravit profil a kdo co uvidí");
  });
});
