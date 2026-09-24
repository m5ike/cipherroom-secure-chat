// Validating a model's inputs (4.15): the chat command, the console's test
// form and a webhook all hand the runner raw values; this turns them into the
// typed, checked object the function receives — or refuses the run with a
// message that names the offending field.
//
// Coercion is deliberate: chat and query strings bring everything as text, so
// "443" becomes 443 for an integer input and "true" becomes true for a
// boolean. What cannot be made to fit is an error, not a silent default.

import { RunRefused } from "./runner";
import type { InputSpec } from "./types";

const HOSTNAME_RE = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IPV4_RE = /^(\d{1,3})(\.\d{1,3}){3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;
const DURATION_RE = /^\d+\s*(ms|s|m|h|d)$/;

function fail(field: string, why: string): never {
  throw new RunRefused("bad-input", `${field}: ${why}`);
}

function toNumber(field: string, v: unknown, integer: boolean): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) fail(field, `must be a ${integer ? "whole number" : "number"}`);
  if (integer && !Number.isInteger(n)) fail(field, "must be a whole number");
  return n;
}

function toBoolean(field: string, v: unknown): boolean {
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["true", "1", "yes", "on", "ano"].includes(s)) return true;
  if (["false", "0", "no", "off", "ne", ""].includes(s)) return false;
  fail(field, "must be yes or no");
}

function checkRange(field: string, n: number, spec: InputSpec): void {
  if (typeof spec.min === "number" && n < spec.min) fail(field, `must be at least ${spec.min}`);
  if (typeof spec.max === "number" && n > spec.max) fail(field, `must be at most ${spec.max}`);
}

function checkPattern(field: string, s: string, spec: InputSpec): void {
  if (!spec.pattern) return;
  let re: RegExp;
  try { re = new RegExp(spec.pattern); } catch { return; }
  if (!re.test(s)) fail(field, "does not match the required pattern");
}

function coerce(spec: InputSpec, value: unknown): unknown {
  const field = spec.label || spec.name;
  switch (spec.type) {
    case "string": case "text": {
      const s = typeof value === "string" ? value : String(value);
      if (typeof spec.min === "number" && s.length < spec.min) fail(field, `must be at least ${spec.min} characters`);
      if (typeof spec.max === "number" && s.length > spec.max) fail(field, `must be at most ${spec.max} characters`);
      checkPattern(field, s, spec);
      return s;
    }
    case "integer": { const n = toNumber(field, value, true); checkRange(field, n, spec); return n; }
    case "number": { const n = toNumber(field, value, false); checkRange(field, n, spec); return n; }
    case "boolean": return toBoolean(field, value);
    case "enum": {
      const s = String(value);
      if (!spec.values?.includes(s)) fail(field, `must be one of: ${(spec.values ?? []).join(", ")}`);
      return s;
    }
    case "url": {
      const s = String(value);
      let u: URL; try { u = new URL(s); } catch { fail(field, "must be a URL"); }
      if (u.protocol !== "http:" && u.protocol !== "https:") fail(field, "must be an http(s) URL");
      return s;
    }
    case "hostname": { const s = String(value).trim(); if (!HOSTNAME_RE.test(s)) fail(field, "must be a hostname"); return s.toLowerCase(); }
    case "email": { const s = String(value).trim(); if (!EMAIL_RE.test(s)) fail(field, "must be an e-mail address"); return s; }
    case "ip": {
      const s = String(value).trim();
      const ok = IPV4_RE.test(s) ? s.split(".").every((p) => Number(p) <= 255) : s.includes(":");
      if (!ok) fail(field, "must be an IP address");
      return s;
    }
    case "date": { const s = String(value).trim(); if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s))) fail(field, "must be a date (YYYY-MM-DD)"); return s; }
    case "time": { const s = String(value).trim(); if (!TIME_RE.test(s)) fail(field, "must be a time (HH:MM)"); return s; }
    case "duration": { const s = String(value).trim(); if (!DURATION_RE.test(s)) fail(field, "must be a duration (e.g. 30s, 5m, 1h)"); return s; }
    case "json": {
      if (typeof value !== "string") return value;
      try { return JSON.parse(value); } catch { fail(field, "must be valid JSON"); }
      return value;
    }
    case "user": case "file": case "secret": return value; // resolved by the executor (chat, webhook); passed through here
    default: return value;
  }
}

/** The checked, typed inputs — or a RunRefused naming the field. Values not in
 *  the schema are dropped, so a function only ever sees what it declared. */
export function validateInputs(specs: InputSpec[], raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of specs) {
    const given = Object.prototype.hasOwnProperty.call(raw, spec.name) ? raw[spec.name] : undefined;
    if (given === undefined || given === null || given === "") {
      if (spec.default !== undefined) { out[spec.name] = spec.default; continue; }
      if (spec.required) fail(spec.label || spec.name, "is required");
      continue;
    }
    out[spec.name] = coerce(spec, given);
  }
  return out;
}
