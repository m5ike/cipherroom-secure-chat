// A model's answer in the chat (6.11): it arrives as an INCOMING message from
// "system-messenger" — the app's own internal sender of everything a Functions
// model says — shown with the model's name as the nickname and the model's icon
// as its avatar, as a reply to the command message that started it.
//
// This file is the CONTRACT the web (App.tsx, MessageBubble, the suggester),
// the Android app (a Java port: fn/ModelIdentity.java) and the server
// (commandView: icon, usage, input pattern / min / max) share. Pure, no I/O.
//
// Honesty: a model's answer that goes to the whole room is still sent by the
// caller's own client (end-to-end encrypted, signed by them). Peers show it
// under the model's identity WITH "via <caller>" — a member cannot pass a
// message off as the system's (validate.ts reserves "system-messenger" and
// "function:*" as sender ids a peer may not use).

import type { Command, CommandInput } from "./functions";

/** The internal sender of model answers (never a real member). */
export const SYSTEM_MESSENGER_ID = "system-messenger";
export const SYSTEM_MESSENGER_NAME = "system-messenger";

/** A command run without any sign of life from the server (no progress, no question, no answer) for this long fails: the loader goes, an error chip and a flash say so. An open question (a form, an NFC tap) pauses it. */
export const FN_RUN_TIMEOUT_MS = 30_000;

/** How a model appears as the sender of its answers. */
export type ModelIdentity = {
  keyword: string;
  /** The nickname: the model's name. */
  name: string;
  /** Lucide icon name, or one emoji. */
  icon: string;
  /** The avatar's colour (#rrggbb), stable per keyword. */
  color: string;
};

/** Icons for models that do not name one, by keyword (built-ins and common words). */
export const DEFAULT_MODEL_ICONS: Record<string, string> = {
  mail: "mail", email: "mail", hlr: "phone", lookup: "search", number: "hash", phone: "phone", call: "phone-call", sms: "message-square-text",
  dns: "globe", whois: "globe", ip: "network", ping: "activity", http: "globe", url: "link", ssl: "shield-check", cert: "shield-check",
  weather: "cloud-sun", time: "clock", calc: "calculator", translate: "languages", ai: "sparkles", ask: "sparkles", summary: "file-text",
  emv: "credit-card", "emv-history": "receipt", eid: "id-card", nfc: "nfc", qr: "qr-code", code: "code", run: "play", help: "circle-help",
  phone_bridge: "phone-forwarded", "phone-bridge": "phone-forwarded", remind: "bell", poll: "chart-bar", dice: "dice-5",
};
const FALLBACK_ICON = "bot";

/** A stable colour for a keyword (the same on the web and Android). */
export function modelColor(keyword: string): string {
  let h = 0;
  for (let i = 0; i < keyword.length; i++) h = (h * 31 + keyword.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  // HSL(hue, 55%, 45%) → #rrggbb, readable with white text.
  const s = 0.55, l = 0.45;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((hue / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  const to = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

export function modelIdentity(cmd: Pick<Command, "keyword" | "name"> & { icon?: string }): ModelIdentity {
  const kw = cmd.keyword.toLowerCase();
  return {
    keyword: cmd.keyword,
    name: cmd.name || `/${cmd.keyword}`,
    icon: (cmd.icon && cmd.icon.trim()) || DEFAULT_MODEL_ICONS[kw] || DEFAULT_MODEL_ICONS[kw.split(/[-_]/)[0]] || FALLBACK_ICON,
    color: modelColor(kw),
  };
}

/** "/hlr <number> [format]" — the command's signature from its inputs (required in <>, optional in []). */
export function commandUsage(cmd: Pick<Command, "keyword" | "inputs">, trigger = "/"): string {
  const args = cmd.inputs.map((i) => (i.required && i.default === undefined ? `<${i.name}>` : `[${i.name}]`));
  return [`${trigger}${cmd.keyword}`, ...args].join(" ");
}

export type InputProblem = { input: string; label: string; problem: "missing" | "type" | "pattern" | "range" | "values"; expected: string };

/** What expectation an input states, for an error line ("an E.164 phone number", "one of a, b", "a number 1–10"). */
export function inputExpectation(i: CommandInput & { pattern?: string; min?: number; max?: number }): string {
  if (i.values && i.values.length) return `one of: ${i.values.join(", ")}`;
  if (i.type === "number" || i.type === "integer") return `a ${i.type}${i.min !== undefined || i.max !== undefined ? ` ${i.min ?? "…"}–${i.max ?? "…"}` : ""}`;
  if (i.type === "phone" || i.pattern === "^\\+[1-9]\\d{1,14}$") return "a phone number in international form (+420…)";
  if (i.type === "boolean") return "true / false";
  if (i.pattern) return `text matching ${i.pattern}`;
  return i.type ? `a ${i.type}` : "a value";
}

/**
 * The inputs of a call that cannot go to the server as they are: a required
 * input without a value or default (unless the model handles an EMPTY call
 * itself — a model whose inputs are all optional answers an empty call with
 * its own form), a value of the wrong type, outside its range or pattern.
 */
export function checkCommandInputs(cmd: Pick<Command, "inputs">, values: Record<string, unknown>): InputProblem[] {
  const out: InputProblem[] = [];
  for (const raw of cmd.inputs) {
    const i = raw as CommandInput & { pattern?: string; min?: number; max?: number };
    const v = values[i.name];
    const empty = v === undefined || v === null || (typeof v === "string" && v.trim() === "");
    if (empty) {
      if (i.required && i.default === undefined) out.push({ input: i.name, label: i.label || i.name, problem: "missing", expected: inputExpectation(i) });
      continue;
    }
    const s = String(v).trim();
    if ((i.type === "number" || i.type === "integer") && (!Number.isFinite(Number(s)) || (i.type === "integer" && !Number.isInteger(Number(s))))) { out.push({ input: i.name, label: i.label || i.name, problem: "type", expected: inputExpectation(i) }); continue; }
    if ((i.type === "number" || i.type === "integer") && ((i.min !== undefined && Number(s) < i.min) || (i.max !== undefined && Number(s) > i.max))) { out.push({ input: i.name, label: i.label || i.name, problem: "range", expected: inputExpectation(i) }); continue; }
    if (i.type === "boolean" && !/^(true|false|1|0|yes|no|ano|ne)$/i.test(s)) { out.push({ input: i.name, label: i.label || i.name, problem: "type", expected: inputExpectation(i) }); continue; }
    if (i.values && i.values.length && !i.values.includes(s)) { out.push({ input: i.name, label: i.label || i.name, problem: "values", expected: inputExpectation(i) }); continue; }
    if (i.type === "phone" && !/^\+[1-9]\d{1,14}$/.test(s.replace(/[\s().-]/g, ""))) { out.push({ input: i.name, label: i.label || i.name, problem: "pattern", expected: inputExpectation(i) }); continue; }
    if (i.pattern) {
      let re: RegExp | null = null;
      try { re = i.pattern.length <= 200 ? new RegExp(i.pattern) : null; } catch { re = null; }
      if (re && !re.test(s)) out.push({ input: i.name, label: i.label || i.name, problem: "pattern", expected: inputExpectation(i) });
    }
  }
  return out;
}
