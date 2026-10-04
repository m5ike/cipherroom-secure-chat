// TSA text templates (6.9): what a TTS speaks, an SMS says, a Log writes, a
// Dial dials — text with placeholders filled in when the node runs:
//
//   {IN1} … {IN100}   the node's inputs          {$name}      a variable
//   {call.from} {call.to} {call.did} {call.direction} {call.provider} {call.id}
//   {secret:NAME}     only where a tool allows it (HTTP headers)
//
// A placeholder whose value is missing becomes "" (a text that never ran, an
// unknown variable); anything else in braces stays as it is. No expressions —
// a Formula or Text node computes, a template only fills in. Pure.

import { CALL_PROPS, textOf, type CallProp } from "./formula";
import { TSA_LIMITS } from "./types";

const PLACEHOLDER = /\{(?:IN([1-9]\d{0,2})|\$([A-Za-z_][A-Za-z0-9_]{0,31})|call\.([a-z]{2,9})|secret:([A-Za-z0-9_]{1,64}))\}/g;

export type TemplateScope = {
  inputs?: Record<string, unknown>;
  vars?: Record<string, unknown>;
  call?: Partial<Record<CallProp, string>>;
};

export type TemplateOptions = {
  /** Applied to every substituted value (an HTTP URL encodes them). */
  encode?: (value: string) => string;
  /** {secret:NAME} → its value; absent: secrets stay "" (and are never filled in elsewhere). */
  secret?: (name: string) => string | undefined;
  /** Longest result (default TSA_LIMITS.textLength). */
  max?: number;
};

const own = (o: unknown, k: string): boolean => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);

/** Fills a template in. */
export function renderTemplate(src: unknown, scope: TemplateScope, opts: TemplateOptions = {}): string {
  if (typeof src !== "string" || !src) return "";
  const max = opts.max ?? TSA_LIMITS.textLength;
  const enc = opts.encode ?? ((s: string) => s);
  const out = src.replace(PLACEHOLDER, (whole, inN: string | undefined, varName: string | undefined, callProp: string | undefined, secret: string | undefined) => {
    if (inN) {
      const n = Number(inN);
      if (n > TSA_LIMITS.dynamicInputs) return whole;
      const key = `IN${n}`;
      return enc(textOf(own(scope.inputs, key) ? scope.inputs![key] : undefined));
    }
    if (varName) return enc(textOf(own(scope.vars, varName) ? scope.vars![varName] : undefined));
    if (callProp) {
      if (!(CALL_PROPS as readonly string[]).includes(callProp)) return whole;
      return enc(textOf(own(scope.call, callProp) ? scope.call![callProp as CallProp] : ""));
    }
    if (secret) return opts.secret ? enc(opts.secret(secret) ?? "") : "";
    return whole;
  });
  return out.length > max ? out.slice(0, max) : out;
}

/** What a template reads (the validator checks inputs against the node, the editor lists them). */
export function templateRefs(src: unknown): { inputs: number[]; vars: string[]; call: string[]; secrets: string[] } {
  const inputs = new Set<number>(), vars = new Set<string>(), call = new Set<string>(), secrets = new Set<string>();
  if (typeof src === "string") {
    for (const m of src.matchAll(PLACEHOLDER)) {
      if (m[1]) inputs.add(Number(m[1]));
      else if (m[2]) vars.add(m[2]);
      else if (m[3]) call.add(m[3]);
      else if (m[4]) secrets.add(m[4]);
    }
  }
  return { inputs: [...inputs].sort((a, b) => a - b), vars: [...vars], call: [...call], secrets: [...secrets] };
}

/** Does the text contain any placeholder (so its final form is only known when it runs)? */
export function hasPlaceholders(src: unknown): boolean {
  if (typeof src !== "string") return false;
  const r = templateRefs(src);
  return r.inputs.length + r.vars.length + r.call.length + r.secrets.length > 0;
}

/** The text without its placeholders (to check what is left of a literal: digits, a URL's scheme). */
export const withoutPlaceholders = (src: string): string => src.replace(PLACEHOLDER, "");

/**
 * "Read numbers digit by digit" for text to speech: every run of two or more
 * digits is spaced out — "Your code is 1234" → "Your code is 1 2 3 4".
 */
export function spellDigits(text: string): string {
  return text.replace(/\d{2,}/g, (m) => m.split("").join(" "));
}
