// Card numbers and track data out of sight (6.10, G-19) — the same rules as
// Android (TemplateViews.java: SENSITIVE, panOf, maskDigits, maskValue, Mask),
// so a masked view reads the same on both. A payment card's number (PAN) and
// its tracks are in more than one place and form:
//
//   5A          the PAN, BCD                         5413330089020011
//   57, 9F6B    Track 2 (equivalent) data, BCD       5413330089020011D2812…
//   56          Track 1 data, ASCII                  B5413330089020011^NOVAK/JAN^2812…
//   9F1F, 9F20  Track 1 / Track 2 discretionary data
//
// Masking keeps a PAN's first six and last four digits and hides the rest with
// "X" — in BCD hex, in ASCII hex (the digits' codes) and in text; the track data
// after the PAN (57 / 9F6B after the "D", the rest of 56, all of 9F1F / 9F20) is
// "X" throughout. Hex stays a string of the same length, so JSON stays valid.
// Pure: the card report (the server's m5.nfc.report too), the template views and
// the consent step for a model's read use it.

import { hex, unhex } from "./cards/apdu";
import type { EmvData } from "./command";

/** The elements that carry the card number or track data. */
export const PAN_TAGS = ["5A", "57", "9F6B", "56", "9F1F", "9F20"] as const;
const SENSITIVE = new Set<string>(PAN_TAGS);

const PAN_RE = /^\d{12,19}$/;
const TRACK1 = /^(%?B?)(\d{12,19})\^/;
const HEX_RE = /^([0-9A-F]{2})+$/;
const xs = (n: number) => "X".repeat(Math.max(0, n));
const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join("");
const tagHexOf = (tag: number) => { let h = tag.toString(16).toUpperCase(); if (h.length % 2) h = `0${h}`; return h; };

/** "5413330089020011" → "541333XXXXXX0011" (`ch` for display: "541333••••••0011"). */
export function maskPanDigits(pan: string, ch = "X"): string {
  return pan.length >= 10 ? `${pan.slice(0, 6)}${ch.repeat(pan.length - 10)}${pan.slice(-4)}` : pan;
}

/** BCD digits (a trailing F kept): the first six and the last four, X between (fewer than ten: all X). */
export function maskDigits(digits: string): string {
  const core = digits.replace(/F+$/, ""), pad = digits.slice(core.length);
  if (core.length < 10) return xs(core.length) + pad;
  return core.slice(0, 6) + xs(core.length - 10) + core.slice(-4) + pad;
}

/** "54…" → "3534…": text as ASCII, in hex. */
export const asciiHex = (s: string) => Array.from(s, (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("").toUpperCase();
const maskedAsciiHex = (pan: string) => asciiHex(pan.slice(0, 6)) + xs((pan.length - 10) * 2) + asciiHex(pan.slice(-4));

/** Every BER-TLV element of `b` and where its value lies — [tag, start, length], nested ones too; a malformed tail ends the walk. */
export function tlvNodes(b: Uint8Array): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  const walk = (from: number, to: number, depth: number) => {
    let off = from;
    while (off < to && depth < 16) {
      const first = b[off];
      if (first === 0x00 || first === 0xff) { off++; continue; }
      let i = off + 1, tag = first;
      if ((first & 0x1f) === 0x1f) {
        let guard = 0;
        for (;;) { if (i >= to || guard++ > 3) return; const c = b[i++]; tag = (tag << 8) | c; if (!(c & 0x80)) break; }
      }
      if (i >= to) return;
      let len = b[i++];
      if (len > 0x80) {
        const k = len & 0x7f;
        if (k > 3 || i + k > to) return;
        len = 0;
        for (let j = 0; j < k; j++) len = (len << 8) | b[i + j];
        i += k;
      } else if (len === 0x80) return;
      if (len < 0 || i + len > to) return;
      out.push([tag >>> 0, i, len]);
      if (first & 0x20) walk(i, i + len, depth + 1);
      off = i + len;
    }
  };
  walk(0, b.length, 0);
  return out;
}

/** The whole buffer is BER-TLV (every object complete, constructed ones too). */
export function isTlv(b: Uint8Array): boolean {
  let off = 0, objects = 0;
  const n = b.length;
  while (off < n) {
    const first = b[off];
    if (first === 0x00 || first === 0xff) { off++; continue; }
    let i = off + 1;
    if ((first & 0x1f) === 0x1f) { let guard = 0; do { if (i >= n || guard++ > 3) return false; } while (b[i++] & 0x80); }
    if (i >= n) return false;
    let len = b[i++];
    if (len > 0x80) {
      const k = len & 0x7f;
      if (k > 3 || i + k > n) return false;
      len = 0;
      for (let j = 0; j < k; j++) len = (len << 8) | b[i + j];
      i += k;
    } else if (len === 0x80) return false;
    if (i + len > n) return false;
    if ((first & 0x20) && len > 0 && !isTlv(b.slice(i, i + len))) return false;
    off = i + len;
    objects++;
  }
  return objects > 0;
}

/** The card number an element carries: 5A, Track 2 before its "D" (57, 9F6B), Track 1 between "B" and "^" (56). */
export function panOfElement(tag: string, v: Uint8Array): string | null {
  switch (tag.toUpperCase()) {
    case "5A": { const h = hex(v).replace(/F+$/, ""); return PAN_RE.test(h) ? h : null; }
    case "57": case "9F6B": { const h = hex(v); const d = h.indexOf("D"); return d > 0 && PAN_RE.test(h.slice(0, d)) ? h.slice(0, d) : null; }
    case "56": { const m = TRACK1.exec(latin1(v)); return m ? m[2] : null; }
    default: return null;
  }
}

/** The card numbers in an answer (hex): every 5A / 57 / 9F6B / 56 it holds. */
export function pansInHex(dataHex: string): string[] {
  const h = String(dataHex ?? "").toUpperCase();
  if (!h || !HEX_RE.test(h)) return [];
  const b = unhex(h);
  const out = new Set<string>();
  for (const [tag, start, len] of tlvNodes(b)) { const p = panOfElement(tagHexOf(tag), b.slice(start, start + len)); if (p) out.add(p); }
  return [...out];
}

/** Whether an answer holds a card number or track data (masking would hide something). */
export function answerMasks(dataHex: string): boolean {
  const h = String(dataHex ?? "").toUpperCase();
  if (!h || !HEX_RE.test(h)) return false;
  return tlvNodes(unhex(h)).some(([tag]) => SENSITIVE.has(tagHexOf(tag)));
}

/** Every card number an EMV read holds: each application's PAN, and any in its elements or records. */
export function pansOfEmv(d: EmvData | undefined | null): string[] {
  const out = new Set<string>();
  if (!d || !Array.isArray(d.apps)) return [];
  for (const a of d.apps) {
    if (a.pan && PAN_RE.test(a.pan)) out.add(a.pan);
    for (const t of a.tags ?? []) {
      if (!SENSITIVE.has(t.tag)) continue;
      try { const p = panOfElement(t.tag, unhex(t.hex)); if (p) out.add(p); } catch { /* not hex */ }
    }
    for (const r of a.records ?? []) for (const p of pansInHex(r.hex)) out.add(p);
  }
  return [...out];
}

/** A sensitive element's value (hex) as a masked view shows it. */
export function maskValue(tag: string, valueHex: string): string {
  const h = valueHex.toUpperCase();
  switch (tag.toUpperCase()) {
    case "5A": return maskDigits(h);
    case "57": case "9F6B": {
      const d = h.indexOf("D");
      if (d <= 0) return h.length <= 6 ? xs(h.length) : h.slice(0, 6) + xs(h.length - 6);
      return `${maskDigits(h.slice(0, d))}D${xs(h.length - d - 1)}`;
    }
    case "56": {
      if (!HEX_RE.test(h)) return xs(h.length);
      const m = TRACK1.exec(latin1(unhex(h)));
      if (!m || m[2].length < 10) return xs(h.length);
      const head = asciiHex(m[1]) + maskedAsciiHex(m[2]);
      return head + xs(h.length - head.length);
    }
    default: return xs(h.length);
  }
}

/** An answer (hex): its sensitive elements masked (when it is BER-TLV), then every PAN in BCD or ASCII hex. */
export function maskAnswer(dataHex: string, pans: string[]): string {
  if (!dataHex) return dataHex;
  const h = dataHex.toUpperCase();
  let s = h;
  if (HEX_RE.test(h)) {
    const b = unhex(h);
    if (isTlv(b)) {
      const out = h.split("");
      for (const [tag, start, len] of tlvNodes(b)) {
        const t = tagHexOf(tag);
        if (!SENSITIVE.has(t)) continue;
        const v = maskValue(t, h.slice(start * 2, (start + len) * 2));
        for (let i = 0; i < v.length; i++) out[start * 2 + i] = v[i];
      }
      s = out.join("");
    }
  }
  return maskPans(s, pans);
}

/** Text or hex with every given card number masked — as digits (BCD hex, text) and as their ASCII codes (ASCII hex). */
export function maskPans(s: string, pans: string[]): string {
  let out = s;
  for (const p of pans) {
    if (!PAN_RE.test(p)) continue;
    out = out.split(p).join(maskDigits(p));
    out = out.replace(new RegExp(asciiHex(p), "gi"), maskedAsciiHex(p));
  }
  return out;
}
