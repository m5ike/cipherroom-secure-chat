// @vitest-environment node
//
// The notification templates' shared vectors (6.7): the TypeScript renderer
// (client/src/lib/notify-template.ts — server and web) is the reference;
// its port in the service worker (client/public/sw.js) must give the same
// text for every case, and so must the Android app's (NotifyTemplateTest.java
// reads the same file). UPDATE_NOTIFY_VECTORS=1 writes the file again.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { DEFAULT_TEMPLATES, NOTIFY_KINDS, renderNotification, renderTemplate, visibleVars, type NotifyPrivacy } from "../client/src/lib/notify-template";

const FILE = join(__dirname, "fixtures", "notify-templates.json");
const VARS = { app: "M5cet", sender: "Bob", room: "Team", count: "3", time: "10:42", preview: "Hello there", channel: "android" };

function build() {
  const list: Array<{ template: string; vars: Record<string, string>; privacy: NotifyPrivacy }> = [];
  const add = (template: string, vars: Record<string, string>, privacy: NotifyPrivacy) => list.push({ template, vars, privacy });
  for (const p of ["neutral", "sender", "room", "content"] as const) {
    add("{app}[ · {room}]", VARS, p);
    add("[{sender}: ]{preview|New message}[ ({count})]", VARS, p);
    add("{sender|Someone} is calling you", VARS, p);
  }
  add("[{sender}: ]{preview|Nová zpráva}", { ...VARS, sender: "Eve\u202e\u2066gnp.exe\r\nBcc: x\u0000\u200b" }, "sender");
  add("{sender}", { sender: "{room} [x] \\{", room: "Secret" }, "room");
  add("\\{app\\} \\[{app}\\] a\\\\b", { app: "A" }, "neutral");
  add("{app", { app: "A" }, "neutral");
  add("a [b {room|r} c] d", {}, "content");
  add("x [a [b] c] y {nope}", { app: "A" }, "content");
  add("{sender}{sender}{sender}", { sender: "x".repeat(80) }, "sender");
  add("{preview}", { preview: "y".repeat(500) }, "content");
  add("{count} {count|none}", { count: "1" }, "neutral");
  add("{app|M5\\|cet} {sender|a\\}b}", {}, "neutral");
  add("  spaced  out  [{time}]  ", { time: "07:00" }, "neutral");
  add("unclosed [part {app}", { app: "A" }, "neutral");
  add("unclosed [part {room}", { app: "A" }, "neutral");
  const cases = list.map((c) => ({ ...c, text: renderTemplate(c.template, visibleVars(c.vars, c.privacy)) }));
  const notifications = NOTIFY_KINDS.flatMap((kind) => (["cs", "en", "de"] as const).map((lang) => {
    const t = DEFAULT_TEMPLATES[kind];
    return { kind, lang, privacy: "room", title: t.title[lang], body: t.body[lang], vars: VARS, expect: renderNotification(t, lang, VARS, "room") };
  }));
  return { about: "Shared vectors of the notification templates (6.7): written by test/notify-template-vectors.test.ts from client/src/lib/notify-template.ts; the service worker and android NotifyTemplateTest.java are checked against them.", cases, notifications };
}

const built = build();
if (process.env.UPDATE_NOTIFY_VECTORS === "1" || !existsSync(FILE)) writeFileSync(FILE, `${JSON.stringify(built, null, 1)}\n`);
const vectors = JSON.parse(readFileSync(FILE, "utf8")) as ReturnType<typeof build>;

describe("notification template vectors", () => {
  it("the file is what the TypeScript renderer gives (run with UPDATE_NOTIFY_VECTORS=1 after a change)", () => {
    expect(vectors).toEqual(built);
  });

  it("the service worker's port gives the same text", () => {
    const ctx: Record<string, unknown> = { self: { addEventListener: () => undefined, location: { origin: "https://x" } }, URL, Map, Date, Object, String, Number, JSON, Math };
    runInNewContext(readFileSync(join(__dirname, "..", "client", "public", "sw.js"), "utf8"), ctx);
    const render = ctx.renderTpl as (t: string, v: Record<string, string>, max?: number) => string;
    const visible = ctx.visibleVars as (v: Record<string, string>, p: string) => Record<string, string>;
    for (const c of vectors.cases) expect(render(c.template, visible(c.vars, c.privacy)), c.template).toBe(c.text);
  });
});
