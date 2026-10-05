// Validating a model's inputs (4.15): the chat command, the console's test
// form and a webhook all hand the runner raw values; this turns them into the
// typed, checked object the function receives — or refuses the run with a
// message that names the offending field.
//
// Coercion is deliberate: chat and query strings bring everything as text, so
// "443" becomes 443 for an integer input and "true" becomes true for a
// boolean. What cannot be made to fit is an error, not a silent default.
//
// 6.11: every input is checked (not only up to the first bad one), and the
// refusal carries them as `problems` — the shape of the client's pre-check
// (client/src/lib/system-messenger.ts InputProblem) plus the server's own
// words — so the chat can say what is wrong, show the model's definition and
// its guide.

import { RunRefused } from "./runner";
import type { InputSpec } from "./types";
import { RegexBudgetError, SafeRegex } from "./safe-regex";

const HOSTNAME_RE = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IPV4_RE = /^(\d{1,3})(\.\d{1,3}){3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;
const DURATION_RE = /^\d+\s*(ms|s|m|h|d)$/;

/** 6.11: what is wrong with one input (client/src/lib/system-messenger.ts InputProblem, plus `message`). */
export type InputProblemKind = "missing" | "type" | "pattern" | "range" | "values";
export type InputProblem = { input: string; label: string; problem: InputProblemKind; expected: string; message: string };

/** Patterns the client also reads as "a phone number in international form". */
const E164_PATTERNS = new Set(["^\\+[1-9]\\d{1,14}$", "^\\+[1-9][0-9]{6,14}$", "^\\+[1-9][0-9]{1,14}$"]);

/** What an input expects, in a few words ("a whole number 1–10", "one of: a, b", "a host name (example.com)"). */
export function inputExpectation(spec: InputSpec): string {
  const range = (unit = "") => (typeof spec.min === "number" || typeof spec.max === "number" ? ` ${spec.min ?? "…"}–${spec.max ?? "…"}${unit}` : "");
  if (spec.values && spec.values.length) return `one of: ${spec.values.join(", ")}`;
  switch (spec.type) {
    case "integer": return `a whole number${range()}`;
    case "number": return `a number${range()}`;
    case "boolean": return "yes / no (true, false, 1, 0)";
    case "url": return "an http(s) address (https://example.com)";
    case "hostname": return "a host name (example.com)";
    case "email": return "an e-mail address (name@example.com)";
    case "ip": return "an IP address (192.0.2.1, 2001:db8::1)";
    case "date": return "a date (YYYY-MM-DD)";
    case "time": return "a time (HH:MM)";
    case "duration": return "a duration (30s, 5m, 1h)";
    case "json": return "JSON";
    case "object": return "a JSON object";
    case "array": return "a JSON list";
    default: break;
  }
  if (spec.pattern && E164_PATTERNS.has(spec.pattern)) return "a phone number in international form (+420…)";
  if (spec.pattern) return `text matching ${spec.pattern}`;
  if ((spec.type === "string" || spec.type === "text") && (typeof spec.min === "number" || typeof spec.max === "number")) return `text of${range(" characters")}`;
  return spec.type === "text" || spec.type === "string" || !spec.type ? "text" : `a ${spec.type}`;
}

class InputFail extends Error {
  constructor(readonly kind: InputProblemKind, message: string) { super(message); this.name = "InputFail"; }
}

function fail(kind: InputProblemKind, why: string): never {
  throw new InputFail(kind, why);
}

function toNumber(v: unknown, integer: boolean): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) fail("type", `must be a ${integer ? "whole number" : "number"}`);
  if (integer && !Number.isInteger(n)) fail("type", "must be a whole number");
  return n;
}

function toBoolean(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["true", "1", "yes", "on", "ano"].includes(s)) return true;
  if (["false", "0", "no", "off", "ne", ""].includes(s)) return false;
  fail("type", "must be yes or no");
}

function checkRange(n: number, spec: InputSpec): void {
  if (typeof spec.min === "number" && n < spec.min) fail("range", `must be at least ${spec.min}`);
  if (typeof spec.max === "number" && n > spec.max) fail("range", `must be at most ${spec.max}`);
}

function checkPattern(s: string, spec: InputSpec): void {
  if (!spec.pattern) return;
  // 6.7 (audit N15): the operator's pattern runs on the service's event loop
  // over an input of up to 1 MB — guarded like the m5adm filters (S1): a
  // backtracking pattern gets a time budget instead of the whole service.
  // The whole value is checked (cutting it would change the verdict).
  let re: SafeRegex;
  try { re = new SafeRegex(spec.pattern, "", { maxSubject: Number.POSITIVE_INFINITY, budgetMs: 100, stepMs: 100 }); } catch { return; }
  let ok: boolean;
  try { ok = re.test(s); } catch (err) { if (err instanceof RegexBudgetError) fail("pattern", "could not be checked against its pattern in time"); throw err; }
  if (!ok) fail("pattern", "does not match the required pattern");
}

function coerce(spec: InputSpec, value: unknown): unknown {
  switch (spec.type) {
    case "string": case "text": {
      const s = typeof value === "string" ? value : String(value);
      if (typeof spec.min === "number" && s.length < spec.min) fail("range", `must be at least ${spec.min} characters`);
      if (typeof spec.max === "number" && s.length > spec.max) fail("range", `must be at most ${spec.max} characters`);
      checkPattern(s, spec);
      return s;
    }
    case "integer": { const n = toNumber(value, true); checkRange(n, spec); return n; }
    case "number": { const n = toNumber(value, false); checkRange(n, spec); return n; }
    case "boolean": return toBoolean(value);
    case "enum": {
      const s = String(value);
      if (!spec.values?.includes(s)) fail("values", `must be one of: ${(spec.values ?? []).join(", ")}`);
      return s;
    }
    case "url": {
      const s = String(value);
      let u: URL; try { u = new URL(s); } catch { fail("type", "must be a URL"); }
      if (u.protocol !== "http:" && u.protocol !== "https:") fail("type", "must be an http(s) URL");
      return s;
    }
    case "hostname": { const s = String(value).trim(); if (!HOSTNAME_RE.test(s)) fail("type", "must be a hostname"); return s.toLowerCase(); }
    case "email": { const s = String(value).trim(); if (!EMAIL_RE.test(s)) fail("type", "must be an e-mail address"); return s; }
    case "ip": {
      const s = String(value).trim();
      const ok = IPV4_RE.test(s) ? s.split(".").every((p) => Number(p) <= 255) : s.includes(":");
      if (!ok) fail("type", "must be an IP address");
      return s;
    }
    case "date": { const s = String(value).trim(); if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s))) fail("type", "must be a date (YYYY-MM-DD)"); return s; }
    case "time": { const s = String(value).trim(); if (!TIME_RE.test(s)) fail("type", "must be a time (HH:MM)"); return s; }
    case "duration": { const s = String(value).trim(); if (!DURATION_RE.test(s)) fail("type", "must be a duration (e.g. 30s, 5m, 1h)"); return s; }
    case "json": {
      if (typeof value !== "string") return value;
      try { return JSON.parse(value); } catch { fail("type", "must be valid JSON"); }
      return value;
    }
    // 5.3: a JSON body's object or list (text is parsed).
    case "object": case "array": {
      let v = value;
      if (typeof v === "string") { try { v = JSON.parse(v); } catch { fail("type", `must be a JSON ${spec.type === "array" ? "list" : "object"}`); } }
      if (spec.type === "array" ? !Array.isArray(v) : !(v && typeof v === "object" && !Array.isArray(v))) fail("type", `must be ${spec.type === "array" ? "a list" : "an object"}`);
      return v;
    }
    case "user": case "file": case "secret": return value; // resolved by the executor (chat, webhook); passed through here
    default: return value;
  }
}

/** The checked, typed inputs — or a RunRefused ("bad-input") naming every
 *  bad field, with details.problems (6.11). Values not in the schema are
 *  dropped, so a function only ever sees what it declared. */
export function validateInputs(specs: InputSpec[], raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const problems: InputProblem[] = [];
  for (const spec of specs) {
    const label = spec.label || spec.name;
    const given = Object.prototype.hasOwnProperty.call(raw, spec.name) ? raw[spec.name] : undefined;
    if (given === undefined || given === null || given === "") {
      if (spec.default !== undefined) { out[spec.name] = spec.default; continue; }
      if (spec.required) problems.push({ input: spec.name, label, problem: "missing", expected: inputExpectation(spec), message: "is required" });
      continue;
    }
    try { out[spec.name] = coerce(spec, given); }
    catch (err) {
      if (!(err instanceof InputFail)) throw err;
      problems.push({ input: spec.name, label, problem: err.kind, expected: inputExpectation(spec), message: err.message });
    }
  }
  if (problems.length) throw new RunRefused("bad-input", problems.map((p) => `${p.label}: ${p.message}`).join("; "), { problems });
  return out;
}
