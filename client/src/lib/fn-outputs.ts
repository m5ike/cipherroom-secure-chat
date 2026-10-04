// The outputs of a function run (4.15; 5.3 adds audio, video, buttons,
// forms and browser JavaScript) — one shared, pure description. The server
// checks what a sandbox returns with it (sandbox/protocol.ts), and the app
// checks what a peer sends in a message with it (validate.ts): the same rules
// on both sides, so a result that renders for the caller renders for the room.
//
// A function returns one output, or a list of them; each becomes one record
// the app shows (text, a table…), plays (audio), runs (browser JavaScript in a
// sandbox) or lets someone answer (a button, a form — they call the model's
// "button" / "form" entry point). 6.6 adds formatted HTML (fn-html.ts).

import { FN_HTML_MAX, fnHtmlText, parseFnHtml, sanitizeFnHtml } from "./fn-html";

export type FlashLevel = "info" | "success" | "warning" | "error";

export type FormOption = { value: string; label: string; icon?: string };
export const FORM_FIELD_TYPES = [
  "text", "textarea", "number", "range", "tel", "email", "url", "password",
  "date", "time", "datetime", "month", "color", "masked",
  "select", "multiselect", "radio", "checkbox", "switch",
  "hidden", "static", "separator",
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];
export type FormField = {
  name: string;
  type: FormFieldType;
  label?: string;
  placeholder?: string;
  default?: unknown;
  required?: boolean;
  help?: string;
  min?: number;
  max?: number;
  step?: number;
  pattern?: string;
  /** masked: 0 a digit, a a letter, * a letter or digit, anything else as it is ("+420 000 000 000"). */
  mask?: string;
  rows?: number;
  options?: FormOption[];
  /** Columns the field takes in a multi-column panel (1–4). */
  span?: number;
  /** Where its label goes (overrides the panel and the form). */
  labels?: "top" | "left";
  readonly?: boolean;
  /** static: the text shown (Markdown). */
  text?: string;
};
export type FormPanel = {
  title?: string;
  text?: string;
  /** rows: one field under another; columns: side by side (`columns` of them). */
  layout?: "rows" | "columns";
  columns?: number;
  labels?: "top" | "left";
  collapsed?: boolean;
  fields: FormField[];
};
export type FormSpec = {
  name: string;
  title?: string;
  text?: string;
  submit?: string;
  labels?: "top" | "left";
  columns?: number;
  fields?: FormField[];
  panels?: FormPanel[];
  /** Answered once: the form locks after a successful submit. */
  once?: boolean;
};

export const BUTTON_CLASSES = ["primary", "secondary", "success", "danger", "warning", "info", "ghost", "outline", "link", "small", "large", "block", "round"] as const;
export type ButtonStyle = { color?: string; background?: string; border?: string };
export type ButtonSpec = {
  name: string;
  title: string;
  data?: unknown;
  /** Class names from BUTTON_CLASSES, space-separated ("primary small"). */
  css?: string;
  style?: ButtonStyle;
  /** An emoji or a few characters shown before the title. */
  icon?: string;
  /** Ask before calling the model ("Really delete?"). */
  confirm?: string;
  /** Clickable once (per viewer). */
  once?: boolean;
  disabled?: boolean;
};

export type FnOutput =
  | { type: "text"; text: string }
  | { type: "markdown"; text: string }
  | { type: "code"; text: string; lang: string }
  | { type: "table"; columns: string[]; rows: unknown[][]; title?: string }
  | { type: "json"; value: unknown; title?: string }
  | { type: "image"; mime: string; data: string; alt?: string }
  | { type: "file"; name: string; mime: string; data: string }
  | { type: "flash"; text: string; level: FlashLevel }
  | { type: "window"; id: string; args: unknown }
  | { type: "audio"; mime: string; data: string; title?: string; autoplay?: boolean; loop?: boolean }
  | { type: "video"; mime: string; data: string; title?: string; autoplay?: boolean; loop?: boolean }
  | ({ type: "button" } & ButtonSpec)
  | ({ type: "form" } & FormSpec)
  | { type: "js"; code: string; args?: unknown; title?: string; height?: number; hidden?: boolean }
  /** 6.6: formatted HTML — document markup only, sanitized (fn-html.ts) by the server and again by every viewer. */
  | { type: "html"; html: string; title?: string };

export const OUTPUT_TYPES = ["text", "markdown", "code", "table", "json", "image", "file", "flash", "window", "audio", "video", "button", "form", "js", "html"] as const;
export type OutputType = FnOutput["type"];

/** How big one output may be (bytes of text / base64). The run's own limit is lower. */
export const OUTPUT_MAX_CHARS = 16 * 1024 * 1024;
const FLASH_LEVELS = new Set(["info", "success", "warning", "error"]);
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const IMAGE_MIME = /^image\/(png|jpeg|gif|webp|svg\+xml)$/;
const AUDIO_MIME = /^audio\/(mpeg|mp3|wav|x-wav|wave|ogg|webm|aac|mp4|flac|x-m4a)$/;
const VIDEO_MIME = /^video\/(mp4|webm|ogg)$/;
const NAME_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const CSS_COLOR = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+%?\s*)?\)|hsla?\(\s*[\d.]+(deg)?\s*,\s*[\d.]+%\s*,\s*[\d.]+%\s*(,\s*[\d.]+%?\s*)?\)|[a-z]{3,20})$/i;

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);
const opt = (v: unknown, max: number): string | undefined => (typeof v === "string" && v ? v.slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
const clampInt = (v: unknown, lo: number, hi: number): number | undefined => { const n = num(v); return n === undefined ? undefined : Math.max(lo, Math.min(hi, Math.round(n))); };
/** A value that survives JSON (a function's data for a button, a JS output's args). */
function plainJson(v: unknown, maxChars: number): unknown {
  if (v === undefined) return undefined;
  try { const s = JSON.stringify(v); return s === undefined || s.length > maxChars ? undefined : JSON.parse(s); } catch { return undefined; }
}

function sanitizeOptions(raw: unknown): FormOption[] {
  if (!Array.isArray(raw)) return [];
  const out: FormOption[] = [];
  for (const o of raw.slice(0, 200)) {
    if (typeof o === "string" || typeof o === "number") { out.push({ value: String(o).slice(0, 200), label: String(o).slice(0, 200) }); continue; }
    if (!isObj(o)) continue;
    const value = o.value === undefined ? o.label : o.value;
    if (value === undefined || value === null) continue;
    const icon = opt(o.icon, 16);
    out.push({ value: String(value).slice(0, 200), label: String(o.label ?? value).slice(0, 200), ...(icon ? { icon } : {}) });
  }
  return out;
}

function sanitizeField(raw: unknown): FormField | null {
  if (!isObj(raw)) return null;
  const type = (FORM_FIELD_TYPES as readonly string[]).includes(String(raw.type)) ? raw.type as FormFieldType : "text";
  const name = typeof raw.name === "string" && NAME_RE.test(raw.name) ? raw.name : type === "static" || type === "separator" ? "" : null;
  if (name === null) return null;
  const f: FormField = { name, type };
  const label = opt(raw.label, 200); if (label) f.label = label;
  const placeholder = opt(raw.placeholder, 200); if (placeholder) f.placeholder = placeholder;
  const help = opt(raw.help, 500); if (help) f.help = help;
  if (raw.default !== undefined) { const d = plainJson(raw.default, 4000); if (d !== undefined) f.default = d; }
  if (raw.required === true) f.required = true;
  if (raw.readonly === true) f.readonly = true;
  for (const k of ["min", "max", "step"] as const) { const n = num(raw[k]); if (n !== undefined) f[k] = n; }
  const pattern = opt(raw.pattern, 300); if (pattern) { try { new RegExp(pattern); f.pattern = pattern; } catch { /* dropped */ } }
  const mask = opt(raw.mask, 60); if (mask) f.mask = mask;
  const rows = clampInt(raw.rows, 1, 30); if (rows) f.rows = rows;
  const span = clampInt(raw.span, 1, 4); if (span) f.span = span;
  if (raw.labels === "top" || raw.labels === "left") f.labels = raw.labels;
  if (type === "select" || type === "multiselect" || type === "radio") f.options = sanitizeOptions(raw.options);
  const text = opt(raw.text, 8000); if (text) f.text = text;
  return f;
}

function sanitizeFields(raw: unknown, budget: { left: number }): FormField[] {
  if (!Array.isArray(raw)) return [];
  const out: FormField[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (budget.left <= 0) break;
    const f = sanitizeField(r);
    if (!f || (f.name && seen.has(f.name))) continue;
    if (f.name) seen.add(f.name);
    out.push(f);
    budget.left--;
  }
  return out;
}

/** A form as the app may render it (null: not a form). */
export function sanitizeForm(raw: Record<string, unknown>): FormSpec | null {
  const name = typeof raw.name === "string" && NAME_RE.test(raw.name) ? raw.name : "form";
  const budget = { left: 120 };
  const form: FormSpec = { name };
  const title = opt(raw.title, 300); if (title) form.title = title;
  const text = opt(raw.text, 4000); if (text) form.text = text;
  const submit = opt(raw.submit, 60); if (submit) form.submit = submit;
  if (raw.labels === "top" || raw.labels === "left") form.labels = raw.labels;
  const columns = clampInt(raw.columns, 1, 4); if (columns) form.columns = columns;
  if (raw.once === true) form.once = true;
  const fields = sanitizeFields(raw.fields, budget);
  if (fields.length) form.fields = fields;
  if (Array.isArray(raw.panels)) {
    const panels: FormPanel[] = [];
    for (const p of raw.panels.slice(0, 16)) {
      if (!isObj(p)) continue;
      const panel: FormPanel = { fields: sanitizeFields(p.fields, budget) };
      const pt = opt(p.title, 200); if (pt) panel.title = pt;
      const px = opt(p.text, 2000); if (px) panel.text = px;
      if (p.layout === "rows" || p.layout === "columns") panel.layout = p.layout;
      const pc = clampInt(p.columns, 1, 4); if (pc) panel.columns = pc;
      if (p.labels === "top" || p.labels === "left") panel.labels = p.labels;
      if (p.collapsed === true) panel.collapsed = true;
      panels.push(panel);
    }
    if (panels.length) form.panels = panels;
  }
  if (!form.fields && !form.panels) return null;
  return form;
}

/** A button as the app may render it (null: not a button). */
export function sanitizeButton(raw: Record<string, unknown>): ButtonSpec | null {
  const name = typeof raw.name === "string" && NAME_RE.test(raw.name) ? raw.name : null;
  const title = opt(raw.title ?? raw.label ?? raw.text, 120);
  if (!name || !title) return null;
  const b: ButtonSpec = { name, title };
  const data = plainJson(raw.data, 16_000); if (data !== undefined) b.data = data;
  if (typeof raw.css === "string") {
    const cls = raw.css.split(/\s+/).filter((c) => (BUTTON_CLASSES as readonly string[]).includes(c));
    if (cls.length) b.css = [...new Set(cls)].join(" ");
  }
  if (isObj(raw.style)) {
    const st: ButtonStyle = {};
    for (const k of ["color", "background", "border"] as const) { const v = raw.style[k]; if (typeof v === "string" && CSS_COLOR.test(v.trim())) st[k] = v.trim(); }
    if (Object.keys(st).length) b.style = st;
  }
  const icon = opt(raw.icon, 16); if (icon) b.icon = icon;
  const confirm = opt(raw.confirm, 300); if (confirm) b.confirm = confirm;
  if (raw.once === true) b.once = true;
  if (raw.disabled === true) b.disabled = true;
  return b;
}

export type OutputCheck = { ok: true; output: FnOutput } | { ok: false; reason: string };

/** One output checked field by field: the output, or why it is not one. */
export function checkFnOutput(v: unknown, maxChars = OUTPUT_MAX_CHARS): OutputCheck {
  if (!isObj(v)) return { ok: false, reason: "not an object" };
  const type = v.type;
  if (typeof type !== "string" || !(OUTPUT_TYPES as readonly string[]).includes(type)) return { ok: false, reason: `unknown output type ${JSON.stringify(String(type ?? "")).slice(0, 40)}` };
  const bad = (why: string): OutputCheck => ({ ok: false, reason: `${type}: ${why}` });
  switch (type) {
    case "text": case "markdown": { const text = str(v.text, maxChars); return text === null ? bad("text must be a string") : { ok: true, output: { type, text } }; }
    case "code": { const text = str(v.text, maxChars); const lang = str(v.lang ?? "", 40); return text === null || lang === null ? bad("text must be a string") : { ok: true, output: { type: "code", text, lang } }; }
    case "table": {
      if (!Array.isArray(v.columns) || !Array.isArray(v.rows) || !v.rows.every(Array.isArray)) return bad("columns and rows must be lists");
      const title = opt(v.title, 500);
      const rows = plainJson(v.rows, maxChars);
      if (rows === undefined) return bad("the rows are not plain data");
      return { ok: true, output: { type: "table", columns: v.columns.map((c) => String(c).slice(0, 200)), rows: rows as unknown[][], ...(title ? { title } : {}) } };
    }
    case "json": {
      const title = opt(v.title, 500);
      const value = v.value === undefined ? null : plainJson(v.value, maxChars);
      if (value === undefined) return bad("the value is not plain data");
      return { ok: true, output: { type: "json", value, ...(title ? { title } : {}) } };
    }
    case "image": {
      const mime = str(v.mime, 100); const data = str(v.data, maxChars);
      if (!mime || !IMAGE_MIME.test(mime)) return bad("mime must be image/png, jpeg, gif, webp or svg+xml");
      if (data === null || !B64_RE.test(data)) return bad("data must be base64 (m5.out.image takes bytes)");
      const alt = opt(v.alt, 500);
      return { ok: true, output: { type: "image", mime, data, ...(alt ? { alt } : {}) } };
    }
    case "file": {
      const name = str(v.name, 200); const mime = str(v.mime, 100); const data = str(v.data, maxChars);
      if (!name || !mime || !/^[\w.+-]+\/[\w.+-]+$/.test(mime)) return bad("a file needs a name and a mime type");
      if (data === null || !B64_RE.test(data)) return bad("data must be base64");
      return { ok: true, output: { type: "file", name: name.replace(/[\\/\0]/g, "_"), mime, data } };
    }
    case "flash": {
      const text = str(v.text, 2000);
      return text === null ? bad("text must be a string (up to 2000 characters)") : { ok: true, output: { type: "flash", text, level: typeof v.level === "string" && FLASH_LEVELS.has(v.level) ? v.level as FlashLevel : "info" } };
    }
    case "window": { const id = str(v.id, 100); return id ? { ok: true, output: { type: "window", id, args: plainJson(v.args, 16_000) ?? null } } : bad("id must be a string"); }
    case "audio": case "video": {
      const mime = str(v.mime, 100); const data = str(v.data, maxChars);
      if (!mime || !(type === "audio" ? AUDIO_MIME : VIDEO_MIME).test(mime)) return bad(type === "audio" ? "mime must be audio/mpeg, wav, ogg, webm, aac, mp4 or flac" : "mime must be video/mp4, webm or ogg");
      if (data === null || !data || !B64_RE.test(data)) return bad("data must be base64 bytes (m5.out.audio / m5.out.video take bytes)");
      const title = opt(v.title, 300);
      return { ok: true, output: { type, mime, data, ...(title ? { title } : {}), ...(v.autoplay === true ? { autoplay: true } : {}), ...(v.loop === true ? { loop: true } : {}) } };
    }
    case "button": { const b = sanitizeButton(v); return b ? { ok: true, output: { type: "button", ...b } } : bad("a button needs a name (letters, digits, _ . : -) and a title"); }
    case "form": { const f = sanitizeForm(v); return f ? { ok: true, output: { type: "form", ...f } } : bad("a form needs fields (or panels with fields)"); }
    case "js": {
      const code = str(v.code, 200_000);
      if (code === null || !code.trim()) return bad("code must be a string (up to 200 000 characters)");
      const title = opt(v.title, 200);
      const height = clampInt(v.height, 0, 2000);
      const args = plainJson(v.args, 64_000);
      return { ok: true, output: { type: "js", code, ...(args !== undefined ? { args } : {}), ...(title ? { title } : {}), ...(height !== undefined ? { height } : {}), ...(v.hidden === true ? { hidden: true } : {}) } };
    }
    case "html": {
      const html = str(v.html, Math.min(maxChars, FN_HTML_MAX));
      if (html === null) return bad(`html must be a string (up to ${FN_HTML_MAX} characters)`);
      const title = opt(v.title, 300);
      return { ok: true, output: { type: "html", html: sanitizeFnHtml(html), ...(title ? { title } : {}) } };
    }
  }
  return bad("unknown");
}

/** An output, or null (the server's check). */
export function sanitizeFnOutput(v: unknown, maxChars = OUTPUT_MAX_CHARS): FnOutput | null {
  const r = checkFnOutput(v, maxChars);
  return r.ok ? r.output : null;
}

/** Outputs a peer sent in a message: the valid ones, within a total budget. */
export function sanitizeFnOutputs(raw: unknown, maxTotal = 900_000): FnOutput[] {
  if (!Array.isArray(raw)) return [];
  const out: FnOutput[] = [];
  let used = 0;
  for (const v of raw.slice(0, 50)) {
    const o = sanitizeFnOutput(v, maxTotal);
    if (!o) continue;
    const size = JSON.stringify(o).length;
    if (used + size > maxTotal) break;
    used += size;
    out.push(o);
  }
  return out;
}

/** What goes into a room message: outputs within the size a message may carry
 *  (large media stay with the caller; the room gets a note instead). */
export function shareableOutputs(outputs: readonly FnOutput[], maxTotal = 700_000): FnOutput[] {
  const out: FnOutput[] = [];
  let used = 0;
  for (const o of outputs) {
    const size = JSON.stringify(o).length;
    if (used + size <= maxTotal) { out.push(o); used += size; continue; }
    const note: FnOutput = { type: "text", text: `(${o.type} — too large to share in the room)` };
    out.push(note);
    used += 80;
  }
  return out;
}

/** Outputs as Markdown — the text of the message (older apps, search, forwarding). */
export function outputsToMarkdown(outputs: readonly FnOutput[]): string {
  const parts: string[] = [];
  for (const o of outputs) {
    switch (o.type) {
      case "text": case "markdown": parts.push(o.text); break;
      case "code": parts.push("```" + (o.lang || "") + "\n" + o.text + "\n```"); break;
      case "json": parts.push((o.title ? `**${o.title}**\n` : "") + "```json\n" + JSON.stringify(o.value, null, 2) + "\n```"); break;
      case "table": parts.push(tableToMarkdown(o)); break;
      case "flash": parts.push(`> ${o.text}`); break;
      case "image": parts.push(`_(image: ${o.alt || o.mime})_`); break;
      case "file": parts.push(`_(file: ${o.name})_`); break;
      case "audio": case "video": parts.push(`_(${o.type}${o.title ? `: ${o.title}` : ""})_`); break;
      case "button": parts.push(`[${o.icon ? `${o.icon} ` : ""}${o.title}]`); break;
      case "form": parts.push(`**${o.title || "Form"}**${o.text ? `\n${o.text}` : ""}`); break;
      case "html": parts.push((o.title ? `**${o.title}**\n\n` : "") + fnHtmlText(parseFnHtml(o.html))); break;
      case "window": case "js": break;
    }
  }
  return parts.join("\n\n").trim();
}

function tableToMarkdown(o: { columns: string[]; rows: unknown[][]; title?: string }): string {
  const cell = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const head = `| ${o.columns.map(cell).join(" | ")} |`;
  const sep = `| ${o.columns.map(() => "---").join(" | ")} |`;
  const body = o.rows.map((r) => `| ${r.map(cell).join(" | ")} |`).join("\n");
  return (o.title ? `**${o.title}**\n\n` : "") + [head, sep, body].join("\n");
}

/** A form's fields, panels included (in order). */
export function formFields(form: FormSpec): FormField[] {
  return [...(form.fields ?? []), ...(form.panels ?? []).flatMap((p) => p.fields)];
}

/** A mask's parts: 0 a digit, a a letter, * a letter or digit; anything else is itself —
 *  and so is what is in {braces} or after a backslash ("+{420} 000 000 000", "\\0"). */
export type MaskToken = { slot: "0" | "a" | "*" } | { lit: string };
export function maskTokens(mask: string): MaskToken[] {
  const out: MaskToken[] = [];
  const chars = [...mask];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === "\\" && i + 1 < chars.length) { out.push({ lit: chars[++i] }); continue; }
    if (c === "{") { const end = chars.indexOf("}", i + 1); if (end > i) { for (const x of chars.slice(i + 1, end)) out.push({ lit: x }); i = end; continue; } }
    out.push(c === "0" || c === "a" || c === "*" ? { slot: c } : { lit: c });
  }
  return out;
}

/** How the mask looks empty ("+420 ___ ___ ___"). */
export function maskPlaceholder(mask: string): string {
  return maskTokens(mask).map((t) => ("slot" in t ? "_" : t.lit)).join("");
}

/** Applies a mask to what was typed ("777123456" → "+420 777 123 456"). */
export function applyMask(mask: string, raw: string): string {
  const tokens = maskTokens(mask);
  const chars = [...raw].filter((c) => /[\p{L}\p{N}]/u.test(c));
  let out = "";
  let i = 0;
  for (const tk of tokens) {
    if (i >= chars.length) break;
    if ("slot" in tk) {
      // Skip what does not fit this slot.
      while (i < chars.length && !(tk.slot === "0" ? /\p{N}/u.test(chars[i]) : tk.slot === "a" ? /\p{L}/u.test(chars[i]) : true)) i++;
      if (i >= chars.length) break;
      out += chars[i++];
    } else {
      out += tk.lit;
      if (chars[i] === tk.lit) i++;
    }
  }
  return out;
}

/** Checks a form's values the way the app does before sending them: required, numbers, patterns, masks. */
export function checkFormValues(form: FormSpec, values: Record<string, unknown>): Record<string, string> {
  const problems: Record<string, string> = {};
  for (const f of formFields(form)) {
    if (!f.name || f.type === "static" || f.type === "separator") continue;
    const v = values[f.name];
    const empty = v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length) || (f.type === "checkbox" || f.type === "switch" ? v !== true && f.required : false);
    if (empty) { if (f.required) problems[f.name] = "required"; continue; }
    if (f.type === "number" || f.type === "range") {
      const n = Number(v);
      if (!Number.isFinite(n)) problems[f.name] = "number";
      else if (f.min !== undefined && n < f.min) problems[f.name] = `min ${f.min}`;
      else if (f.max !== undefined && n > f.max) problems[f.name] = `max ${f.max}`;
    }
    if (f.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v))) problems[f.name] = "email";
    // A masked value is complete when every part of the mask is filled.
    if (f.type === "masked" && f.mask && [...String(v)].length < maskTokens(f.mask).length) problems[f.name] = "incomplete";
    if (f.pattern && typeof v === "string") { try { if (!new RegExp(f.pattern).test(v)) problems[f.name] = "pattern"; } catch { /* ignored */ } }
  }
  return problems;
}
