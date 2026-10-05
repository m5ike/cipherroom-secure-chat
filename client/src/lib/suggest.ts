// The message box's suggester (6.11) — PURE: no DOM, no React (the storage
// wrappers at the end take the storage as an argument). What typing offers —
// the commands / models, the people (mentions), the tags and a command's
// argument values — ranked by a fuzzy match and by what this user picks often
// or lately, grouped in sections with a cap each; and the argument hint once a
// command is chosen (which input is being typed, its help, its values).
//
// The trigger characters stay the operator's (Modules & groups › Message
// input — ComposerPolicy.triggers): "functions" characters start a command at
// the start of the text, the others ("@" people, "#" tags…) at the start of a
// word. components/CommandSuggest.tsx draws this; the Android app ports it
// (fn/Suggestions.java) — keep it plain: strings, arrays, small records.

import type { Command, CommandInput } from "./functions";
import { commandUsage } from "./system-messenger";

/** [start, end) in the original string (UTF-16 offsets), for highlighting. */
export type Range = [number, number];

// ─── Matching ───────────────────────────────────────────────────────────────

const FOLD_EXTRA: Record<string, string> = { "ł": "l", "đ": "d", "ø": "o", "ß": "ss", "æ": "ae", "œ": "oe", "ı": "i", "ħ": "h", "þ": "th" };

/** A string folded for matching (lower case, no diacritics), with where each folded unit came from. */
export type Folded = { text: string; start: number[]; end: number[] };

/** "Příliš Žluťoučký" → "prilis zlutoucky", each unit mapped back to the original. */
export function fold(s: string): Folded {
  let text = "";
  const start: number[] = [];
  const end: number[] = [];
  let off = 0;
  for (const ch of s) {
    const lower = ch.toLowerCase();
    const f = FOLD_EXTRA[lower] ?? lower.normalize("NFD").replace(/[̀-ͯ]/g, "");
    for (let k = 0; k < f.length; k++) { text += f[k]; start.push(off); end.push(off + ch.length); }
    off += ch.length;
  }
  return { text, start, end };
}

/** How a query matched: the whole text, its start, a word's start, anywhere, or letters in order. */
export type Tier = "exact" | "prefix" | "word" | "substring" | "fuzzy";
export type Match = { tier: Tier; score: number; ranges: Range[] };

/** The base score of each tier; a tier never falls below the next one. */
export const TIER_SCORE: Record<Tier, number> = { exact: 100, prefix: 90, word: 70, substring: 50, fuzzy: 30 };

const WORD_CHAR = /[\p{L}\p{N}]/u;
const isBoundary = (t: string, i: number) => i === 0 || !WORD_CHAR.test(t[i - 1]);

function toRanges(f: Folded, idx: number[]): Range[] {
  const out: Range[] = [];
  for (const i of idx) {
    const a = f.start[i], b = f.end[i];
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}
const run = (from: number, len: number) => Array.from({ length: len }, (_, k) => from + k);

/**
 * How well `query` matches `target` — case- and diacritics-insensitive:
 * exact > prefix > the start of a word > anywhere > its letters in order
 * (the first at a word's start). Null: no match. An empty query matches
 * everything with score 0. `substring` / `fuzzy` default to on for queries of
 * two or more letters (one letter would match nearly everything).
 */
export function matchText(query: string, target: string, opts: { substring?: boolean; fuzzy?: boolean } = {}): Match | null {
  const q = fold(query.trim()).text;
  if (!q) return { tier: "prefix", score: 0, ranges: [] };
  if (!target) return null;
  const f = fold(target);
  const t = f.text;
  if (t === q) return { tier: "exact", score: TIER_SCORE.exact, ranges: toRanges(f, run(0, q.length)) };
  if (t.startsWith(q)) return { tier: "prefix", score: TIER_SCORE.prefix - Math.min(5, (t.length - q.length) * 0.25), ranges: toRanges(f, run(0, q.length)) };
  for (let i = 1; i + q.length <= t.length; i++) {
    if (isBoundary(t, i) && t.startsWith(q, i)) return { tier: "word", score: TIER_SCORE.word - Math.min(5, i * 0.1), ranges: toRanges(f, run(i, q.length)) };
  }
  if (opts.substring ?? q.length >= 2) {
    const at = t.indexOf(q);
    if (at >= 0) return { tier: "substring", score: TIER_SCORE.substring - Math.min(5, at * 0.2), ranges: toRanges(f, run(at, q.length)) };
  }
  if (!(opts.fuzzy ?? q.length >= 2)) return null;
  // Its letters in order (each the next one found), the first at a word's start; the best start wins.
  let best: { score: number; idx: number[] } | null = null;
  for (let s = 0; s < t.length; s++) {
    if (t[s] !== q[0] || !isBoundary(t, s)) continue;
    const idx = [s];
    for (let k = 1; k < q.length; k++) {
      const next = t.indexOf(q[k], idx[k - 1] + 1);
      if (next < 0) break;
      idx.push(next);
    }
    if (idx.length !== q.length) continue;
    const gaps = idx[idx.length - 1] - idx[0] + 1 - q.length;
    const starts = idx.filter((i) => isBoundary(t, i)).length;
    const score = Math.max(15, Math.min(45, TIER_SCORE.fuzzy + starts * 1.5 - gaps * 0.5 - s * 0.1));
    if (!best || score > best.score) best = { score, idx };
  }
  return best ? { tier: "fuzzy", score: best.score, ranges: toRanges(f, best.idx) } : null;
}

/** A command against a query: its keyword counts most, then its name, then its summary (words only). */
export type CommandMatch = { score: number; keyword: Range[]; name: Range[]; summary: Range[] };
export const FIELD_WEIGHT = { keyword: 1, name: 0.85, summary: 0.6 } as const;

export function matchCommand(query: string, c: Pick<Command, "keyword" | "name" | "summary">): CommandMatch | null {
  const q = query.trim();
  if (!q) return { score: 0, keyword: [], name: [], summary: [] };
  const k = matchText(q, c.keyword);
  const n = c.name && c.name.toLowerCase() !== c.keyword.toLowerCase() ? matchText(q, c.name) : null;
  const s = c.summary ? matchText(q, c.summary, { fuzzy: false, substring: fold(q).text.length >= 3 }) : null;
  const ks = k ? k.score * FIELD_WEIGHT.keyword : 0, ns = n ? n.score * FIELD_WEIGHT.name : 0, ss = s ? s.score * FIELD_WEIGHT.summary : 0;
  const score = Math.max(ks, ns, ss);
  if (score <= 0) return null;
  // Highlight what decided the match: the keyword whenever it matched, else the name, else the summary
  // ("/d" marks the "d" of "dns", not every "D" of its name and summary).
  return { score, keyword: k?.ranges ?? [], name: !k && n && ns >= ss ? n.ranges : [], summary: !k && s && ss > ns ? s.ranges : [] };
}

// ─── What this user picks: a small memory ───────────────────────────────────

/** "command:dns" → how often and when last. */
export type UsageMemory = Record<string, { n: number; at: number }>;
export type UsageKind = "command" | "person" | "tag" | "value";
export const USAGE_LIMIT = 150;
const DAY = 86_400_000;

export function usageKey(kind: UsageKind, key: string): string {
  return `${kind}:${key.toLowerCase()}`;
}

export const valueUsageKey = (keyword: string, input: string, value: string) => usageKey("value", `${keyword}.${input}:${value}`);

/**
 * A rank boost of at most 10 points: how often (log) plus how lately (half
 * life a week). It reorders equally good matches and never lifts a weaker
 * tier over a better one (the tiers are 20 points apart).
 */
export function usageBoost(e: { n: number; at: number } | undefined, now: number): number {
  if (!e || !(e.n > 0)) return 0;
  const days = Math.max(0, (now - e.at) / DAY);
  return Math.min(6, 2 * Math.log2(1 + e.n)) + 4 * Math.pow(0.5, days / 7);
}

/** The memory with one more use of `key`; the least useful entries go past USAGE_LIMIT. */
export function recordUsage(mem: UsageMemory, key: string, now: number): UsageMemory {
  const next: UsageMemory = { ...mem, [key]: { n: Math.min(1000, (mem[key]?.n ?? 0) + 1), at: now } };
  const keys = Object.keys(next);
  if (keys.length > USAGE_LIMIT) {
    keys.sort((a, b) => usageBoost(next[a], now) - usageBoost(next[b], now) || next[a].at - next[b].at);
    for (const k of keys.slice(0, keys.length - USAGE_LIMIT)) delete next[k];
  }
  return next;
}

export function sanitizeUsage(raw: unknown): UsageMemory {
  const out: UsageMemory = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, USAGE_LIMIT * 2)) {
    const e = v as { n?: unknown; at?: unknown } | null;
    if (k.length > 200 || !e || typeof e.n !== "number" || typeof e.at !== "number" || !Number.isFinite(e.n) || !Number.isFinite(e.at) || e.n <= 0) continue;
    out[k] = { n: Math.min(1000, Math.round(e.n)), at: e.at };
  }
  return out;
}

const USAGE_STORE = "m5.suggest.usage.v1:";
type KeyStore = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const defaultStore = (): KeyStore | null => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };

/** This user's memory on this device (empty when storage is off or broken). */
export function loadUsage(user: string, store: KeyStore | null = defaultStore()): UsageMemory {
  try {
    const raw = store?.getItem(USAGE_STORE + (user || "local"));
    return raw ? sanitizeUsage(JSON.parse(raw)) : {};
  } catch { return {}; }
}

export function saveUsage(user: string, mem: UsageMemory, store: KeyStore | null = defaultStore()): void {
  try { store?.setItem(USAGE_STORE + (user || "local"), JSON.stringify(mem)); } catch { /* storage full or off: the memory is a nicety */ }
}

// ─── The argument hint ──────────────────────────────────────────────────────

/** An input as the hint describes it. */
export type ArgInput = {
  name: string;
  label: string;
  type: string;
  /** Needed, and no default stands in. */
  required: boolean;
  help?: string;
  values?: string[];
  default?: unknown;
  min?: number;
  max?: number;
  pattern?: string;
  /** An example value (the model's, its default, its first value, or one for the type). */
  example?: string;
  /** Filled by position; false: only as name=value (user, file, secret — as the server parses). */
  positional: boolean;
  /** What the line gives it before the caret. */
  given?: string;
};

export type ArgHint = {
  command: Command;
  /** The character the command was typed with. */
  trigger: string;
  /** "/dns <domain> [type]" */
  usage: string;
  /** The usage in parts, for drawing: the keyword, then one part per input. */
  parts: Array<{ text: string; input?: string; required?: boolean; active?: boolean; given?: boolean }>;
  inputs: ArgInput[];
  /** The input being typed (null: the line is past every input). */
  current: ArgInput | null;
  /** Typed as name=value. */
  byKey: boolean;
  /** The current value as typed so far. */
  partial: string;
  /** Every value the current input takes (its values, true / false, the people for a user input). */
  choices: string[];
  /** The choices matching `partial`, best first. */
  values: Array<{ value: string; ranges: Range[]; score: number; isDefault: boolean }>;
  /** `partial` is one of the choices exactly. */
  exact: boolean;
  /** Required inputs not given yet (the current one aside). */
  missing: string[];
  /** More is typed than the command takes. */
  extra: boolean;
  /** Where the current token sits in the text: picking a value replaces it. */
  replace: { start: number; end: number };
};

/** Inputs a bare word never fills (the server's buildInputs). */
const NAMED_ONLY = new Set(["user", "file", "secret"]);
const isFreeText = (i: CommandInput) => i.type === "text" || i.type === "string";
const TYPE_EXAMPLE: Record<string, string> = {
  url: "https://example.com", hostname: "example.com", email: "name@example.com", ip: "192.0.2.1", date: "2026-01-31", time: "14:30",
  duration: "15m", phone: "+420601234567", integer: "10", number: "1.5", boolean: "true", json: "{\"a\":1}",
};

/** Required in the sense the hint shows: needed and no default stands in. */
export const inputRequired = (i: CommandInput) => Boolean(i.required) && i.default === undefined;

export function inputExample(i: CommandInput): string | undefined {
  const own = (i as { example?: unknown }).example;
  if (typeof own === "string" && own) return own;
  if (i.default !== undefined && i.default !== null && i.default !== "") return String(i.default);
  if (i.values && i.values.length) return i.values[0];
  if ((i.type === "integer" || i.type === "number") && i.min !== undefined) return String(i.min);
  return TYPE_EXAMPLE[i.type];
}

type Token = { text: string; start: number; end: number; quoted: boolean; open: boolean };

/** The argument line in tokens as the server reads them ("quoted values" whole), with where each sits. */
function scanArgs(s: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i])) { i++; continue; }
    const q = s[i];
    if (q === "\"" || q === "'") {
      const close = s.indexOf(q, i + 1);
      if (close < 0) { out.push({ text: s.slice(i + 1), start: i, end: s.length, quoted: true, open: true }); break; }
      out.push({ text: s.slice(i + 1, close), start: i, end: close + 1, quoted: true, open: false });
      i = close + 1;
      continue;
    }
    let j = i;
    while (j < s.length && !/\s/.test(s[j])) j++;
    out.push({ text: s.slice(i, j), start: i, end: j, quoted: false, open: false });
    i = j;
  }
  return out;
}

/** Splits the text at the caret: "/kw args" with a known command → its parts; null otherwise. */
function commandAtStart(before: string, commands: readonly Command[], commandChars: readonly string[]) {
  const first = [...before][0] ?? "";
  if (!first || !commandChars.includes(first)) return null;
  const m = /^([a-z0-9_-]{1,40})(\s+)([\s\S]*)$/i.exec(before.slice(first.length));
  if (!m) return null;
  const command = commands.find((c) => c.keyword.toLowerCase() === m[1].toLowerCase());
  if (!command) return null;
  return { command, trigger: first, args: m[3], argsAt: first.length + m[1].length + m[2].length };
}

/**
 * Once a command is chosen ("/kw " and its arguments up to the caret): which
 * input is being typed — by position (bare values fill the positional inputs
 * in order, the last free-text one takes the rest) or as name=value — what it
 * expects, and the values it takes that match what is typed.
 */
export function argumentHint(opts: { text: string; caret?: number; commands: readonly Command[]; commandChars: readonly string[]; people?: readonly SuggestPerson[] }): ArgHint | null {
  const text = opts.text ?? "";
  const caret = clampCaret(opts.caret, text);
  const before = text.slice(0, caret);
  const at = commandAtStart(before, opts.commands, opts.commandChars);
  if (!at) return null;
  const { command, trigger, args, argsAt } = at;
  const specs = command.inputs ?? [];
  const byName = new Map(specs.map((i) => [i.name, i]));
  const tokens = scanArgs(args);
  const last = tokens[tokens.length - 1];
  const typing = last && (last.open || last.end === args.length) ? last : null;
  const done = typing ? tokens.slice(0, -1) : tokens;
  const cur: Token = typing ?? { text: "", start: args.length, end: args.length, quoted: false, open: false };

  const given: Record<string, string> = {};
  const bare: string[] = [];
  for (const tok of done) {
    const eq = tok.text.indexOf("=");
    if (eq > 0 && byName.has(tok.text.slice(0, eq))) given[tok.text.slice(0, eq)] = tok.text.slice(eq + 1);
    else bare.push(tok.text);
  }
  let current: CommandInput | null = null;
  let byKey = false;
  let partial = cur.text;
  const eq = cur.text.indexOf("=");
  if (eq > 0 && byName.has(cur.text.slice(0, eq))) { current = byName.get(cur.text.slice(0, eq)) ?? null; byKey = true; partial = cur.text.slice(eq + 1); }

  const positional = specs.filter((s) => !NAMED_ONLY.has(s.type) && !(s.name in given) && !(byKey && current?.name === s.name));
  const pos: Record<string, string> = {};
  let pi = 0;
  positional.forEach((spec, k) => {
    if (pi >= bare.length) return;
    if (isFreeText(spec) && k === positional.length - 1) { pos[spec.name] = bare.slice(pi).join(" "); pi = bare.length; }
    else pos[spec.name] = bare[pi++];
  });
  let extra = false;
  if (!byKey) {
    const next = positional.find((s) => !(s.name in pos));
    const tail = positional[positional.length - 1];
    if (next) current = next;
    else if (tail && isFreeText(tail) && tail.name in pos) current = tail; // the free text goes on
    else { current = null; extra = cur.text !== "" || pi < bare.length; }
  }

  const people = (opts.people ?? []).map((p) => p.name).filter(Boolean);
  const choices = !current ? [] : current.values && current.values.length ? [...current.values] : current.type === "boolean" ? ["true", "false"] : current.type === "user" ? [...new Set(people)] : [];
  const def = current && current.default !== undefined ? String(current.default) : undefined;
  const fq = fold(partial).text;
  const exact = fq !== "" && choices.some((v) => fold(v).text === fq);
  const values = choices
    .map((value, order) => ({ value, order, m: matchText(partial, value) }))
    .filter((x): x is { value: string; order: number; m: Match } => x.m !== null)
    .sort((a, b) => b.m.score - a.m.score || a.order - b.order)
    .map((x) => ({ value: x.value, ranges: x.m.ranges, score: x.m.score, isDefault: x.value === def }));

  const filled = (name: string) => (name in given ? given[name] : name in pos ? pos[name] : undefined);
  const inputs: ArgInput[] = specs.map((i) => ({
    name: i.name,
    label: i.label || i.name,
    type: i.type,
    required: inputRequired(i),
    ...(i.help ? { help: i.help } : {}),
    ...(i.values && i.values.length ? { values: [...i.values] } : {}),
    ...(i.default !== undefined ? { default: i.default } : {}),
    ...(i.min !== undefined ? { min: i.min } : {}),
    ...(i.max !== undefined ? { max: i.max } : {}),
    ...(i.pattern ? { pattern: i.pattern } : {}),
    ...(inputExample(i) !== undefined ? { example: inputExample(i) } : {}),
    positional: !NAMED_ONLY.has(i.type),
    ...(filled(i.name) !== undefined ? { given: filled(i.name) } : {}),
  }));
  const currentInfo = current ? inputs.find((i) => i.name === current?.name) ?? null : null;
  const restLen = cur.open ? text.length - caret : (/^\S*/.exec(text.slice(caret))?.[0].length ?? 0);
  return {
    command,
    trigger,
    usage: commandUsage(command, trigger),
    parts: [
      { text: `${trigger}${command.keyword}` },
      ...inputs.map((i) => ({ text: i.required ? `<${i.name}>` : `[${i.name}]`, input: i.name, required: i.required, active: currentInfo?.name === i.name, given: i.given !== undefined })),
    ],
    inputs,
    current: currentInfo,
    byKey,
    partial,
    choices,
    values,
    exact,
    missing: inputs.filter((i) => i.required && i.given === undefined && i.name !== currentInfo?.name).map((i) => i.name),
    extra,
    replace: { start: argsAt + cur.start, end: caret + restLen },
  };
}

// ─── The suggestions ────────────────────────────────────────────────────────

export type SuggestPerson = { name: string; avatar?: string; away?: boolean };
export type SuggestTrigger = { char: string; action: string };

export type SuggestItem = {
  /** Unique in the list ("command:dns", "more:people"). */
  id: string;
  kind: "command" | "person" | "tag" | "value" | "more";
  /** The keyword, the name, the tag, the value. */
  key: string;
  /** The trigger in front of the key as the row shows it ("/", "@", "#"; "" for a value). */
  prefix: string;
  /** Matched parts of `key`. */
  ranges: Range[];
  nameRanges?: Range[];
  summaryRanges?: Range[];
  score: number;
  /** This user picked it before. */
  used?: boolean;
  command?: Command;
  person?: SuggestPerson;
  /** A value: the command and input it is for, and whether it is the input's default. */
  value?: { keyword: string; input: string; isDefault: boolean };
  /** A "n more" row: the section it opens, and how many more it shows. */
  section?: string;
  more?: number;
  /** The composer's text and caret once this is picked (not for "more"). */
  apply?: { text: string; caret: number };
};

export type SuggestSection = {
  /** "recent", "commands", "people", "tags", "values", or the action of a trigger the app does not know. */
  id: string;
  /** An i18n key, and its placeholders. */
  title: string;
  titleVars?: Record<string, string | number>;
  items: SuggestItem[];
  /** How many match in all (items may be fewer: the cap). */
  total: number;
};

export type SuggestNotice = { kind: "off" | "none" | "loading" | "noMatch" | "nothing"; query: string; trigger: string };

export type SuggestList = {
  mode: "commands" | "mentions" | "tags" | "values" | "palette";
  query: string;
  sections: SuggestSection[];
  /** Every row the keys move through, in order ("n more" rows too). */
  items: SuggestItem[];
  notice?: SuggestNotice;
  /** The first row starts selected (Enter picks it); false: Enter still sends until a row is chosen. */
  autoSelect: boolean;
};

export type Suggestions = { list: SuggestList | null; hint: ArgHint | null };

export const DEFAULT_CAPS = { commands: 8, recent: 3, people: 8, tags: 8, values: 8, palette: 5 } as const;
export const EXPANDED_CAP = 60;

export type SuggestContext = {
  text: string;
  /** Where the caret is (default: the end). */
  caret?: number;
  triggers: readonly SuggestTrigger[];
  commands: readonly Command[];
  /** false: the Functions module is off; null: not known yet. */
  commandsEnabled: boolean | null;
  people: readonly SuggestPerson[];
  /** Tags to offer, best first (the operator's, then the room's). */
  tags: readonly string[];
  usage?: UsageMemory;
  now?: number;
  /** Ctrl+Space: open even with no trigger typed (everything that fits the word), or a value list for an empty value. */
  forced?: boolean;
  /** Sections showing all their rows ("n more" picked). */
  expanded?: readonly string[];
};

export function clampCaret(caret: number | undefined | null, text: string): number {
  return typeof caret === "number" && Number.isFinite(caret) ? Math.max(0, Math.min(text.length, Math.floor(caret))) : text.length;
}

/** The text with [start, end) replaced by `token` and one space after it (a space already there is not doubled). */
export function replaceToken(text: string, start: number, end: number, token: string): { text: string; caret: number } {
  let rest = text.slice(end);
  if (/^\s/.test(rest)) rest = rest.slice(1);
  const head = `${text.slice(0, start)}${token} `;
  return { text: head + rest, caret: head.length };
}

const quoteIfNeeded = (v: string) => (/\s/.test(v) ? (v.includes("\"") ? `'${v}'` : `"${v}"`) : v);

/** What picking `item` counts as in the usage memory (null: nothing, a "more" row). */
export function itemUsageKey(item: SuggestItem): string | null {
  if (item.kind === "command" || item.kind === "person" || item.kind === "tag") return usageKey(item.kind, item.key);
  if (item.kind === "value" && item.value) return valueUsageKey(item.value.keyword, item.value.input, item.key);
  return null;
}

/** The text with the hint's current value set to `value` (as name=value when typed so; quoted when it has spaces). */
export function applyValue(text: string, hint: ArgHint, value: string): { text: string; caret: number } {
  const token = hint.byKey && hint.current ? `${hint.current.name}=${value}` : value;
  return replaceToken(text, hint.replace.start, hint.replace.end, quoteIfNeeded(token));
}

/**
 * The usage keys a sent message counts for: its command (when it is one the
 * user may run), the people it mentions and the tags it has — so what this
 * user writes by hand ranks up too, not only what they pick.
 */
export function usedIn(text: string, triggers: readonly SuggestTrigger[], commands: readonly Command[], people: readonly SuggestPerson[]): string[] {
  const out: string[] = [];
  const t = (text || "").trim();
  if (!t) return out;
  const first = [...t][0] ?? "";
  if (triggers.some((x) => x.action === "functions" && x.char === first)) {
    const kw = /^([a-z0-9_-]{1,40})(?:\s|$)/i.exec(t.slice(first.length))?.[1]?.toLowerCase();
    if (kw && commands.some((c) => c.keyword.toLowerCase() === kw)) out.push(usageKey("command", kw));
  }
  const names = new Set(uniquePeople(people).map((p) => p.name.toLowerCase()));
  for (const trig of triggers) {
    if (trig.action !== "mentions" && trig.action !== "tags") continue;
    const esc = trig.char.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
    for (const m of t.matchAll(new RegExp(`(?:^|\\s)${esc}([\\p{L}\\p{N}_][\\p{L}\\p{N}_.-]{0,39})`, "gu"))) {
      const word = m[1].replace(/[.-]+$/, "");
      if (trig.action === "mentions" && names.has(word.toLowerCase())) out.push(usageKey("person", word));
      if (trig.action === "tags") out.push(usageKey("tag", word));
    }
  }
  return [...new Set(out)].slice(0, 20);
}

type Ranked<T> = { item: T; score: number; boost: number; order: number };
function rank<T>(items: readonly T[], match: (x: T) => number | null, boostOf: (x: T) => number): Ranked<T>[] {
  const out: Ranked<T>[] = [];
  items.forEach((item, order) => {
    const score = match(item);
    if (score !== null) out.push({ item, score, boost: boostOf(item), order });
  });
  return out.sort((a, b) => b.score + b.boost - (a.score + a.boost) || a.order - b.order);
}

function section(id: string, title: string, items: SuggestItem[], cap: number, expanded: readonly string[], titleVars?: SuggestSection["titleVars"]): SuggestSection {
  const limit = expanded.includes(id) ? EXPANDED_CAP : cap;
  return { id, title, ...(titleVars ? { titleVars } : {}), items: items.slice(0, limit), total: items.length };
}

function flatten(sections: SuggestSection[]): SuggestItem[] {
  const out: SuggestItem[] = [];
  for (const s of sections) {
    out.push(...s.items);
    if (s.total > s.items.length) out.push({ id: `more:${s.id}`, kind: "more", key: s.id, prefix: "", ranges: [], score: 0, section: s.id, more: s.total - s.items.length });
  }
  return out;
}

function list(mode: SuggestList["mode"], query: string, sections: SuggestSection[], autoSelect = true, notice?: SuggestNotice): SuggestList {
  const kept = sections.filter((s) => s.items.length);
  return { mode, query, sections: kept, items: flatten(kept), autoSelect, ...(notice ? { notice } : {}) };
}

const notice = (mode: SuggestList["mode"], kind: SuggestNotice["kind"], query: string, trigger: string): SuggestList =>
  ({ mode, query, sections: [], items: [], autoSelect: false, notice: { kind, query, trigger } });

/** People once each by the name a mention uses (spaces → "_"); someone here wins over the same name away. */
function uniquePeople(people: readonly SuggestPerson[]): SuggestPerson[] {
  const by = new Map<string, SuggestPerson>();
  for (const p of people) {
    const name = (p.name || "").trim().replace(/\s+/g, "_");
    if (!name) continue;
    const had = by.get(name);
    if (!had || (had.away && !p.away)) by.set(name, { ...p, name });
  }
  return [...by.values()];
}

function commandItems(q: string, ctx: SuggestContext, prefix: string, replace: (kw: string) => { text: string; caret: number }, now: number): Ranked<SuggestItem>[] {
  const usage = ctx.usage ?? {};
  const matches = new Map<Command, CommandMatch>();
  return rank(ctx.commands, (c) => { const m = matchCommand(q, c); if (m) matches.set(c, m); return m ? m.score : null; }, (c) => usageBoost(usage[usageKey("command", c.keyword)], now))
    .map((r) => {
      const c = r.item, m = matches.get(c) as CommandMatch;
      return {
        ...r,
        item: {
          id: `command:${c.keyword}`, kind: "command" as const, key: c.keyword, prefix, ranges: m.keyword, nameRanges: m.name, summaryRanges: m.summary,
          score: r.score + r.boost, ...(r.boost > 0 ? { used: true } : {}), command: c, apply: replace(c.keyword),
        },
      };
    });
}

function peopleItems(q: string, ctx: SuggestContext, prefix: string, replace: (name: string) => { text: string; caret: number }, now: number): SuggestItem[] {
  const usage = ctx.usage ?? {};
  const people = uniquePeople(ctx.people);
  return rank(people, (p) => matchText(q, p.name)?.score ?? null, (p) => usageBoost(usage[usageKey("person", p.name)], now) + (p.away ? 0 : 0.5))
    .map((r) => ({
      id: `person:${r.item.name}`, kind: "person" as const, key: r.item.name, prefix, ranges: matchText(q, r.item.name)?.ranges ?? [],
      score: r.score + r.boost, ...(usage[usageKey("person", r.item.name)] ? { used: true } : {}), person: r.item, apply: replace(r.item.name),
    }));
}

function tagItems(q: string, ctx: SuggestContext, prefix: string, replace: (tag: string) => { text: string; caret: number }, now: number, dropExact: boolean): SuggestItem[] {
  const usage = ctx.usage ?? {};
  const fq = fold(q).text;
  const tags = [...new Set(ctx.tags.map((t) => t.replace(/^#/, "").trim()).filter(Boolean))].filter((t) => !(dropExact && fold(t).text === fq));
  return rank(tags, (t) => matchText(q, t)?.score ?? null, (t) => usageBoost(usage[usageKey("tag", t)], now))
    .map((r) => ({
      id: `tag:${r.item}`, kind: "tag" as const, key: r.item, prefix, ranges: matchText(q, r.item)?.ranges ?? [],
      score: r.score + r.boost, ...(usage[usageKey("tag", r.item)] ? { used: true } : {}), apply: replace(r.item),
    }));
}

/**
 * What the composer offers for `ctx.text` at the caret: a list (sections of
 * rows, or a notice) and the argument hint. In order: a command's keyword at
 * the start ("/dn"), a person or a tag at the start of a word ("@an", "#re"),
 * a command argument's values ("/dns example.com M"), and — Ctrl+Space —
 * everything that fits the word at the caret.
 */
export function suggest(ctx: SuggestContext): Suggestions {
  const text = ctx.text ?? "";
  const caret = clampCaret(ctx.caret, text);
  const before = text.slice(0, caret);
  const after = text.slice(caret);
  const now = ctx.now ?? Date.now();
  const expanded = ctx.expanded ?? [];
  const commandChars = ctx.triggers.filter((t) => t.action === "functions").map((t) => t.char);
  const hint = argumentHint({ text, caret, commands: ctx.commands, commandChars, people: ctx.people });
  if (!before && !ctx.forced) return { list: null, hint };

  // 1. "/dn" — a command at the start of the text
  const first = [...before][0] ?? "";
  if (first && commandChars.includes(first) && /^[a-z0-9_-]*$/i.test(before.slice(first.length))) {
    const q = before.slice(first.length);
    const restLen = /^[a-z0-9_-]*/i.exec(after)?.[0].length ?? 0;
    const replace = (kw: string) => replaceToken(text, 0, caret + restLen, `${first}${kw}`);
    if (ctx.commandsEnabled === false) return { list: notice("commands", "off", q, first), hint: null };
    if (!ctx.commands.length) return { list: notice("commands", ctx.commandsEnabled === null ? "loading" : "none", q, first), hint: null };
    const ranked = commandItems(q, ctx, first, replace, now);
    if (!ranked.length) return { list: notice("commands", "noMatch", q, first), hint: null };
    if (q) return { list: list("commands", q, [section("commands", "functions.commands", ranked.map((r) => r.item), DEFAULT_CAPS.commands, expanded)]), hint: null };
    // nothing typed yet: what this user ran lately first, then every command in the operator's order
    const recent = ranked.filter((r) => r.boost > 0).slice(0, DEFAULT_CAPS.recent);
    const rest = ranked.filter((r) => !recent.includes(r)).sort((a, b) => a.order - b.order);
    return {
      list: list("commands", "", [
        section("recent", "suggest.recent", recent.map((r) => r.item), DEFAULT_CAPS.recent, []),
        section("commands", "functions.commands", rest.map((r) => r.item), DEFAULT_CAPS.commands, expanded),
      ]),
      hint: null,
    };
  }

  // 2. "@an", "#re" — the start of a word with another trigger
  const w = /(^|\s)(\S)([\p{L}\p{N}_.-]*)$/u.exec(before);
  const trig = w ? ctx.triggers.find((x) => x.char === w[2] && x.action !== "functions") : undefined;
  if (w && trig) {
    const q = w[3];
    const start = before.length - w[2].length - w[3].length;
    const restLen = /^[\p{L}\p{N}_.-]*/u.exec(after)?.[0].length ?? 0;
    const replace = (token: string) => replaceToken(text, start, caret + restLen, `${trig.char}${token}`);
    if (trig.action === "mentions") {
      const items = peopleItems(q, ctx, trig.char, replace, now);
      if (items.length) return { list: list("mentions", q, [section("people", "composer.mentions", items, DEFAULT_CAPS.people, expanded)]), hint };
    } else if (trig.action === "tags") {
      const items = tagItems(q, ctx, trig.char, replace, now, true);
      if (items.length) return { list: list("tags", q, [section("tags", "composer.tags", items, DEFAULT_CAPS.tags, expanded)]), hint };
    }
    if (!ctx.forced) return { list: null, hint };
  }

  // 3. "/dns example.com M" — the values of the argument being typed
  if (hint?.current && hint.choices.length && (ctx.forced || (hint.partial !== "" && !hint.exact))) {
    const cur = hint.current;
    const usage = ctx.usage ?? {};
    const vkey = (v: string) => valueUsageKey(hint.command.keyword, cur.name, v);
    const rows = hint.values
      .map((v, order) => ({ v, order, boost: usageBoost(usage[vkey(v.value)], now) }))
      .sort((a, b) => b.v.score + b.boost - (a.v.score + a.boost) || a.order - b.order)
      .map(({ v, boost }): SuggestItem => ({
        id: `value:${cur.name}:${v.value}`, kind: "value", key: v.value, prefix: "", ranges: v.ranges, score: v.score + boost,
        ...(boost > 0 ? { used: true } : {}), value: { keyword: hint.command.keyword, input: cur.name, isDefault: v.isDefault },
        apply: applyValue(text, hint, v.value),
      }));
    if (rows.length) return { list: list("values", hint.partial, [section("values", "suggest.values", rows, DEFAULT_CAPS.values, expanded, { label: cur.label })], hint.partial !== ""), hint };
  }

  // 4. Ctrl+Space — everything that fits the word at the caret
  if (ctx.forced) {
    const word = /\S*$/.exec(before)?.[0] ?? "";
    const start = before.length - word.length;
    const restLen = /^\S*/.exec(after)?.[0].length ?? 0;
    const atStart = before.slice(0, start).trim() === "";
    const sections: SuggestSection[] = [];
    const fn = ctx.triggers.find((x) => x.action === "functions");
    if (fn && atStart && !hint && ctx.commandsEnabled !== false) {
      const items = commandItems(word, ctx, fn.char, (kw) => replaceToken(text, start, caret + restLen, `${fn.char}${kw}`), now).map((r) => r.item);
      sections.push(section("commands", "functions.commands", items, DEFAULT_CAPS.palette, expanded));
    }
    const at = ctx.triggers.find((x) => x.action === "mentions");
    if (at) sections.push(section("people", "composer.mentions", peopleItems(word, ctx, at.char, (n) => replaceToken(text, start, caret + restLen, `${at.char}${n}`), now), DEFAULT_CAPS.palette, expanded));
    const hash = ctx.triggers.find((x) => x.action === "tags");
    if (hash) sections.push(section("tags", "composer.tags", tagItems(word, ctx, hash.char, (tg) => replaceToken(text, start, caret + restLen, `${hash.char}${tg}`), now, false), DEFAULT_CAPS.palette, expanded));
    const out = list("palette", word, sections);
    return { list: out.items.length ? out : notice("palette", "nothing", word, ""), hint };
  }
  return { list: null, hint };
}
