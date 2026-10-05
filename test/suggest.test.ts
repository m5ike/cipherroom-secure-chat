// The message box's suggester (6.11, lib/suggest.ts): the fuzzy matcher
// (tiers, order, highlights, diacritics), the usage memory, the sections and
// their caps, what picking leaves in the field, and the argument hint
// (positional and name=value, value suggestions).

import { describe, it, expect } from "vitest";
import type { Command } from "../client/src/lib/functions";
import { DEFAULT_COMPOSER } from "../client/src/lib/client-config";
import {
  applyValue, argumentHint, fold, inputExample, itemUsageKey, loadUsage, matchCommand, matchText, recordUsage, saveUsage,
  suggest, usageBoost, usageKey, usedIn, USAGE_LIMIT, type SuggestContext, type UsageMemory,
} from "../client/src/lib/suggest";

const cmd = (keyword: string, over: Partial<Command> = {}): Command => ({ keyword, name: keyword, summary: "", runtime: "node", visibility: "caller", mine: false, inputs: [], ...over });

const COMMANDS: Command[] = [
  cmd("dns", { name: "DNS lookup", summary: "Looks up the DNS records of a domain", visibility: "room", inputs: [
    { name: "domain", type: "hostname", required: true, help: "The domain to look up" },
    { name: "type", type: "enum", required: false, values: ["A", "AAAA", "MX", "TXT"], default: "A" },
  ] }),
  cmd("hlr", { name: "HLR lookup", summary: "Checks a phone number in the network", inputs: [
    { name: "number", type: "phone", required: true },
    { name: "format", type: "enum", required: false, values: ["short", "full"] },
  ] }),
  cmd("emv-history", { name: "Card history", summary: "Reads the payment history of a card" }),
  cmd("help", { name: "Help", summary: "Lists the commands" }),
  cmd("pocasi", { name: "Počasí", summary: "Předpověď počasí pro město", inputs: [{ name: "mesto", type: "text", required: true }] }),
  cmd("remind", { name: "Reminder", inputs: [
    { name: "who", type: "user", required: true },
    { name: "when", type: "duration", required: true },
    { name: "text", type: "text", required: false },
  ] }),
  cmd("dice", { name: "Dice", inputs: [{ name: "sides", type: "integer", required: false, min: 2, max: 100 }, { name: "loud", type: "boolean", required: false }] }),
];
const PEOPLE = [{ name: "Anna Nováková" }, { name: "Jan" }, { name: "Žofie" }, { name: "anna", away: true }];
const TAGS = ["release", "urgent", "release-notes", "porada"];
const NOW = Date.UTC(2026, 9, 5, 12);

const ctx = (text: string, over: Partial<SuggestContext> = {}): SuggestContext => ({
  text, triggers: DEFAULT_COMPOSER.triggers, commands: COMMANDS, commandsEnabled: true, people: PEOPLE, tags: TAGS, now: NOW, ...over,
});
const keys = (text: string, over: Partial<SuggestContext> = {}) => suggest(ctx(text, over)).list?.items.map((i) => i.id) ?? null;
const sliceAll = (s: string, ranges: Array<[number, number]>) => ranges.map(([a, b]) => s.slice(a, b));

describe("matching", () => {
  it("folds case and diacritics, mapping back to the original", () => {
    const f = fold("Příliš Žluťoučký");
    expect(f.text).toBe("prilis zlutoucky");
    expect(f.start[1]).toBe(1);
    expect(fold("Łódź straße").text).toBe("lodz strasse");
  });

  it("ranks exact > prefix > word start > substring > letters in order", () => {
    const tiers = ["dns", "dnsx", "my-dns", "adnsb", "d-n-s"].map((t) => matchText("dns", t));
    expect(tiers.map((m) => m?.tier)).toEqual(["exact", "prefix", "word", "substring", "fuzzy"]);
    const scores = tiers.map((m) => m?.score ?? 0);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(matchText("xyz", "dns")).toBeNull();
  });

  it("highlights what matched, in the original string", () => {
    expect(sliceAll("Počasí v Brně", matchText("pocasi", "Počasí v Brně")!.ranges)).toEqual(["Počasí"]);
    expect(sliceAll("Předpověď počasí", matchText("poc", "Předpověď počasí")!.ranges)).toEqual(["poč"]);
    expect(sliceAll("emv-history", matchText("emh", "emv-history")!.ranges)).toEqual(["em", "h"]);
    expect(matchText("brne", "Počasí v Brně")?.tier).toBe("word");
  });

  it("a single letter matches only a start (not anything with that letter)", () => {
    expect(matchText("n", "dns")).toBeNull();
    expect(matchText("n", "dns", { substring: true })?.tier).toBe("substring");
    expect(matchText("d", "dns")?.tier).toBe("prefix");
    expect(matchText("", "anything")?.score).toBe(0);
  });

  it("a command: its keyword counts most, then its name, then its summary's words", () => {
    const kw = matchCommand("look", cmd("lookup"))!;
    const name = matchCommand("look", cmd("hlr", { name: "Lookup" }))!;
    const sum = matchCommand("look", cmd("x", { summary: "Looks a thing up" }))!;
    expect(kw.score).toBeGreaterThan(name.score);
    expect(name.score).toBeGreaterThan(sum.score);
    expect(sum.summary).toEqual([[0, 4]]);
    // a summary is never matched letter by letter, nor in the middle of a word for short queries
    expect(matchCommand("lk", cmd("x", { summary: "Looks a thing up" }))).toBeNull();
    expect(matchCommand("ook", cmd("x", { summary: "Looks" }))?.summary).toEqual([[1, 4]]);
    expect(matchCommand("ok", cmd("x", { summary: "Looks" }))).toBeNull();
  });
});

describe("the usage memory", () => {
  it("boosts by how often and how lately, at most 10 points", () => {
    expect(usageBoost(undefined, NOW)).toBe(0);
    const once = usageBoost({ n: 1, at: NOW }, NOW);
    const often = usageBoost({ n: 50, at: NOW }, NOW);
    const old = usageBoost({ n: 50, at: NOW - 60 * 86_400_000 }, NOW);
    expect(once).toBeGreaterThan(0);
    expect(often).toBeGreaterThan(once);
    expect(old).toBeLessThan(often);
    expect(usageBoost({ n: 1e6, at: NOW }, NOW)).toBeLessThanOrEqual(10);
  });

  it("counts uses and forgets the least useful past the limit", () => {
    let mem: UsageMemory = {};
    mem = recordUsage(mem, "command:dns", NOW);
    mem = recordUsage(mem, "command:dns", NOW + 1);
    expect(mem["command:dns"]).toEqual({ n: 2, at: NOW + 1 });
    for (let i = 0; i < USAGE_LIMIT + 10; i++) mem = recordUsage(mem, `tag:t${i}`, NOW - (USAGE_LIMIT - i) * 86_400_000);
    expect(Object.keys(mem).length).toBe(USAGE_LIMIT);
    expect(mem["command:dns"]).toBeDefined(); // used twice and lately: kept
    expect(mem["tag:t0"]).toBeUndefined(); // the oldest single use went
  });

  it("lives in the storage per user, and a broken or missing storage is just empty", () => {
    const data = new Map<string, string>();
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    saveUsage("alice", { "command:dns": { n: 3, at: NOW } }, store);
    expect(loadUsage("alice", store)).toEqual({ "command:dns": { n: 3, at: NOW } });
    expect(loadUsage("bob", store)).toEqual({});
    data.set("m5.suggest.usage.v1:bob", "{not json");
    expect(loadUsage("bob", store)).toEqual({});
    data.set("m5.suggest.usage.v1:bob", JSON.stringify({ "command:x": { n: "many" }, "tag:y": { n: 2, at: NOW } }));
    expect(loadUsage("bob", store)).toEqual({ "tag:y": { n: 2, at: NOW } });
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); } };
    expect(loadUsage("alice", broken)).toEqual({});
    expect(() => saveUsage("alice", {}, broken)).not.toThrow();
    expect(loadUsage("alice", null)).toEqual({});
  });

  it("a sent message counts its command, mentions and tags", () => {
    const got = usedIn("/dns example.com", DEFAULT_COMPOSER.triggers, COMMANDS, PEOPLE);
    expect(got).toEqual(["command:dns"]);
    expect(usedIn("ahoj @Jan a @nikdo, viz #Release.", DEFAULT_COMPOSER.triggers, COMMANDS, PEOPLE)).toEqual(["person:jan", "tag:release"]);
    expect(usedIn("/unknown x", DEFAULT_COMPOSER.triggers, COMMANDS, PEOPLE)).toEqual([]);
  });
});

describe("commands", () => {
  it("ranks the keyword's start first, then words of the name and the summary", () => {
    expect(keys("/d")).toEqual(["command:dns", "command:dice"]);
    expect(keys("/look")).toEqual(["command:dns", "command:hlr"]); // "DNS lookup", "HLR lookup" (and dns's summary)
    expect(keys("/pocas")).toEqual(["command:pocasi"]);
    expect(keys("/predpo")).toEqual(["command:pocasi"]); // the summary "Předpověď…", without diacritics
    expect(keys("/emh")).toEqual(["command:emv-history"]); // letters in order
  });

  it("what this user runs often comes first among equal matches, never over a better one", () => {
    const usage = { [usageKey("command", "hlr")]: { n: 5, at: NOW } };
    expect(keys("/look", { usage })).toEqual(["command:hlr", "command:dns"]);
    expect(keys("/d", { usage: { [usageKey("command", "dice")]: { n: 9, at: NOW } } })).toEqual(["command:dice", "command:dns"]);
    expect(keys("/dn", { usage: { [usageKey("command", "dice")]: { n: 999, at: NOW } } })).toEqual(["command:dns"]);
    const item = suggest(ctx("/look", { usage })).list!.items[0];
    expect(item.used).toBe(true);
    expect(itemUsageKey(item)).toBe("command:hlr");
  });

  it("highlights what decided the match: the keyword, else the name, else the summary", () => {
    const [dns] = suggest(ctx("/look")).list!.items;
    expect(dns.ranges).toEqual([]);
    expect(sliceAll("DNS lookup", dns.nameRanges!)).toEqual(["look"]);
    expect(dns.summaryRanges).toEqual([]); // the name matched better
    const [p] = suggest(ctx("/predpo")).list!.items;
    expect(sliceAll(COMMANDS[4].summary, p.summaryRanges!)).toEqual(["Předpo"]);
    const [d] = suggest(ctx("/dn")).list!.items;
    expect(d.prefix).toBe("/");
    expect(d.ranges).toEqual([[0, 2]]);
    expect(d.nameRanges).toEqual([]); // not the "DN" of "DNS lookup" too
    expect(d.summaryRanges).toEqual([]);
  });

  it("an empty query: recently used first, then every command in the operator's order", () => {
    const plain = suggest(ctx("/")).list!;
    expect(plain.sections.map((s) => s.id)).toEqual(["commands"]);
    expect(plain.items.map((i) => i.key)).toEqual(COMMANDS.map((c) => c.keyword));
    const usage = { "command:remind": { n: 1, at: NOW }, "command:dice": { n: 4, at: NOW } };
    const withRecent = suggest(ctx("/", { usage })).list!;
    expect(withRecent.sections.map((s) => [s.id, s.title])).toEqual([["recent", "suggest.recent"], ["commands", "functions.commands"]]);
    expect(withRecent.sections[0].items.map((i) => i.key)).toEqual(["dice", "remind"]);
    expect(withRecent.sections[1].items.map((i) => i.key)).not.toContain("dice");
  });

  it("caps a section with an “n more” row that opens it", () => {
    const many = Array.from({ length: 20 }, (_, i) => cmd(`cmd${String(i).padStart(2, "0")}`));
    const capped = suggest(ctx("/cmd", { commands: many })).list!;
    expect(capped.sections[0].items).toHaveLength(8);
    expect(capped.sections[0].total).toBe(20);
    const more = capped.items[capped.items.length - 1];
    expect(more).toMatchObject({ kind: "more", section: "commands", more: 12 });
    const open = suggest(ctx("/cmd", { commands: many, expanded: ["commands"] })).list!;
    expect(open.items).toHaveLength(20);
    expect(open.items.some((i) => i.kind === "more")).toBe(false);
  });

  it("says when the module is off, the list is loading, nothing is there or nothing matches", () => {
    expect(suggest(ctx("/d", { commandsEnabled: false })).list?.notice?.kind).toBe("off");
    expect(suggest(ctx("/", { commands: [], commandsEnabled: null })).list?.notice?.kind).toBe("loading");
    expect(suggest(ctx("/", { commands: [] })).list?.notice?.kind).toBe("none");
    const none = suggest(ctx("/xyz")).list!;
    expect(none.notice).toEqual({ kind: "noMatch", query: "xyz", trigger: "/" });
    expect(none.items).toEqual([]);
  });

  it("the operator's characters start a command; others do not", () => {
    const triggers = [{ char: "!", action: "functions" }, { char: "@", action: "mentions" }];
    expect(keys("!dn", { triggers })).toEqual(["command:dns"]);
    expect(keys("/dn", { triggers })).toBeNull();
    expect(keys("#rel", { triggers })).toBeNull(); // no tags trigger configured
    expect(suggest(ctx("!dn", { triggers })).list!.items[0].apply).toEqual({ text: "!dns ", caret: 5 });
  });

  it("picking leaves “/keyword ” with the caret after it, keeping what follows", () => {
    expect(suggest(ctx("/dn")).list!.items[0].apply).toEqual({ text: "/dns ", caret: 5 });
    // the caret inside: the rest of the word goes, the arguments stay
    expect(suggest(ctx("/dnx example.com", { caret: 3 })).list!.items[0].apply).toEqual({ text: "/dns example.com", caret: 5 });
  });

  it("only at the start of the text", () => {
    expect(keys("hello /dn")).toBeNull();
    expect(keys("")).toBeNull();
  });
});

describe("people and tags", () => {
  it("offers people by any part of the name, diacritics aside; here before away", () => {
    expect(keys("@an")).toEqual(["person:anna", "person:Anna_Nováková", "person:Jan"]);
    expect(keys("@nov")).toEqual(["person:Anna_Nováková"]);
    expect(keys("@zof")).toEqual(["person:Žofie"]);
    expect(keys("@")).toHaveLength(4);
    expect(suggest(ctx("@an")).list!.items[0].person).toEqual({ name: "anna", away: true });
    expect(keys("@zzz")).toBeNull();
  });

  it("someone both here and away is offered once, as here", () => {
    const list = suggest(ctx("@jan", { people: [{ name: "Jan", away: true }, { name: "Jan" }] })).list!;
    expect(list.items.map((i) => i.person)).toEqual([{ name: "Jan" }]);
  });

  it("picking a person replaces the word at the caret", () => {
    expect(suggest(ctx("hi @Ja")).list!.items[0].apply).toEqual({ text: "hi @Jan ", caret: 8 });
    expect(suggest(ctx("hi @Ja there", { caret: 6 })).list!.items[0].apply).toEqual({ text: "hi @Jan there", caret: 8 });
  });

  it("offers tags, not the one already typed whole", () => {
    expect(keys("#re")).toEqual(["tag:release", "tag:release-notes"]);
    expect(keys("#release")).toEqual(["tag:release-notes"]);
    expect(keys("ok #por")).toEqual(["tag:porada"]);
    expect(keys("#")).toHaveLength(4);
    expect(suggest(ctx("#urg")).list!.items[0].apply).toEqual({ text: "#urgent ", caret: 8 });
  });

  it("a mention inside a command's arguments works too", () => {
    const s = suggest(ctx("/remind @Ja"));
    expect(s.list?.mode).toBe("mentions");
    expect(s.hint?.command.keyword).toBe("remind");
  });
});

describe("the argument hint", () => {
  const hint = (text: string, caret?: number) => argumentHint({ text, caret, commands: COMMANDS, commandChars: ["/"], people: PEOPLE });

  it("follows the positional inputs as they are typed", () => {
    expect(hint("/dns")).toBeNull(); // still the keyword
    expect(hint("/nope x")).toBeNull(); // not a command
    const h0 = hint("/dns ")!;
    expect(h0.usage).toBe("/dns <domain> [type]");
    expect(h0.current).toMatchObject({ name: "domain", type: "hostname", required: true, help: "The domain to look up", example: "example.com" });
    expect(h0.parts.map((p) => [p.text, Boolean(p.active)])).toEqual([["/dns", false], ["<domain>", true], ["[type]", false]]);
    expect(h0.missing).toEqual([]);
    const h1 = hint("/dns exam")!;
    expect(h1.current?.name).toBe("domain");
    expect(h1.partial).toBe("exam");
    const h2 = hint("/dns example.com ")!;
    expect(h2.current).toMatchObject({ name: "type", required: false, values: ["A", "AAAA", "MX", "TXT"], default: "A", example: "A" });
    expect(h2.inputs[0].given).toBe("example.com");
    expect(h2.parts[1].given).toBe(true);
    expect(hint("/dns example.com MX extra")).toMatchObject({ current: null, extra: true });
  });

  it("reads name=value, and the other inputs still fill by position", () => {
    const h = hint("/dns type=M")!;
    expect(h).toMatchObject({ byKey: true, partial: "M" });
    expect(h.current?.name).toBe("type");
    expect(h.values.map((v) => v.value)).toEqual(["MX"]);
    expect(h.missing).toEqual(["domain"]);
    const h2 = hint("/dns type=MX ")!;
    expect(h2.current?.name).toBe("domain"); // type is given by name, the domain comes next
    expect(h2.inputs.find((i) => i.name === "type")?.given).toBe("MX");
  });

  it("the last free-text input takes the rest of the line", () => {
    const h = hint("/pocasi Nové Město na")!;
    expect(h.current?.name).toBe("mesto");
    expect(h.extra).toBe(false);
  });

  it("people, files and secrets only by name: a bare value goes to the next one", () => {
    const h = hint("/remind ")!;
    expect(h.current?.name).toBe("when");
    expect(h.missing).toEqual(["who"]);
    expect(h.inputs[0]).toMatchObject({ name: "who", positional: false });
    const who = hint("/remind who=an")!;
    expect(who.current?.name).toBe("who");
    expect(who.choices).toEqual(["Anna Nováková", "Jan", "Žofie", "anna"]);
    expect(who.values.map((v) => v.value)).toEqual(["anna", "Anna Nováková", "Jan"]);
  });

  it("offers true / false for a yes-no input, and says which value is typed whole", () => {
    const h = hint("/dice 6 t")!;
    expect(h.current?.name).toBe("loud");
    expect(h.choices).toEqual(["true", "false"]);
    expect(h.values.map((v) => v.value)).toEqual(["true"]);
    expect(hint("/dice 6 true")!.exact).toBe(true);
    expect(hint("/dice ")!.current).toMatchObject({ name: "sides", example: "2", min: 2, max: 100 });
  });

  it("quoted values stay one value", () => {
    const h = hint("/remind who=Jan \"in 5")!;
    expect(h.current?.name).toBe("when");
    expect(h.partial).toBe("in 5");
  });

  it("picking a value replaces what is typed of it (name=value kept, spaces quoted)", () => {
    const text = "/dns example.com type=M";
    expect(applyValue(text, hint(text)!, "MX")).toEqual({ text: "/dns example.com type=MX ", caret: 25 });
    const who = "/remind who=an";
    expect(applyValue(who, hint(who)!, "Anna Nováková").text).toBe("/remind \"who=Anna Nováková\" ");
    const mid = "/dns example.com M rest";
    expect(applyValue(mid, hint(mid, 18)!, "MX")).toEqual({ text: "/dns example.com MX rest", caret: 20 });
  });

  it("examples come from the model, its default, its values or the type", () => {
    expect(inputExample({ name: "x", type: "string", required: false, example: "foo" } as never)).toBe("foo");
    expect(inputExample({ name: "x", type: "email", required: false })).toBe("name@example.com");
    expect(inputExample({ name: "x", type: "string", required: false })).toBeUndefined();
  });
});

describe("value suggestions in the list", () => {
  it("a typed part of a value lists the matching ones; Enter picks", () => {
    const s = suggest(ctx("/dns example.com m"));
    expect(s.list?.mode).toBe("values");
    expect(s.list?.sections[0]).toMatchObject({ id: "values", title: "suggest.values", titleVars: { label: "type" } });
    expect(s.list?.items.map((i) => i.key)).toEqual(["MX"]);
    expect(s.list?.autoSelect).toBe(true);
    expect(s.list?.items[0].apply).toEqual({ text: "/dns example.com MX ", caret: 20 });
  });

  it("nothing typed yet, or a value typed whole: no list (Enter sends) — unless opened with Ctrl+Space", () => {
    expect(suggest(ctx("/dns example.com ")).list).toBeNull();
    expect(suggest(ctx("/dns example.com MX")).list).toBeNull();
    const forced = suggest(ctx("/dns example.com ", { forced: true })).list!;
    expect(forced.items.map((i) => i.key)).toEqual(["A", "AAAA", "MX", "TXT"]);
    expect(forced.items[0].value).toEqual({ keyword: "dns", input: "type", isDefault: true });
    expect(forced.autoSelect).toBe(false);
  });

  it("values this user picks for the input rank first", () => {
    const usage = { [itemUsageKey({ id: "", kind: "value", key: "TXT", prefix: "", ranges: [], score: 0, value: { keyword: "dns", input: "type", isDefault: false } })!]: { n: 3, at: NOW } };
    expect(suggest(ctx("/dns example.com ", { forced: true, usage })).list!.items.map((i) => i.key)).toEqual(["TXT", "A", "AAAA", "MX"]);
  });
});

describe("Ctrl+Space", () => {
  it("on an empty field: commands, people and tags, a few each", () => {
    const l = suggest(ctx("", { forced: true })).list!;
    expect(l.mode).toBe("palette");
    expect(l.sections.map((s) => [s.id, s.items.length, s.total])).toEqual([["commands", 5, 7], ["people", 4, 4], ["tags", 4, 4]]);
    expect(l.items.filter((i) => i.kind === "more").map((i) => i.section)).toEqual(["commands"]);
    expect(l.items[0].apply).toEqual({ text: "/dns ", caret: 5 });
  });

  it("on a word: what fits it, inserted with its trigger; commands only at the start", () => {
    const l = suggest(ctx("hello jan", { forced: true })).list!;
    expect(l.sections.map((s) => s.id)).toEqual(["people"]);
    expect(l.items[0].apply).toEqual({ text: "hello @Jan ", caret: 11 });
    const start = suggest(ctx("rel", { forced: true })).list!;
    expect(start.sections.map((s) => s.id)).toEqual(["tags"]);
    expect(start.items[0].apply?.text).toBe("#release ");
    expect(suggest(ctx("dn", { forced: true })).list!.items[0].apply?.text).toBe("/dns ");
    expect(suggest(ctx("qqq", { forced: true })).list?.notice).toEqual({ kind: "nothing", query: "qqq", trigger: "" });
  });
});
