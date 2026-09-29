// A model's entry points (5.3): which function answers which call — the
// start (execute), a reply to the model's message (response), a click on its
// button, a submitted form, an error, and any number of webhooks (each with
// its own URL). They live in one package version, the one the model's
// `entry` names; an entry point names a function in it as "file#function".
//
// Models saved before 5.3 have no list: `entry` + `inputs` are their execute
// entry point and `executors.webhook` their one webhook. endpointsOf() reads
// both shapes, and a save writes the list (keeping `entry`, `inputs` and
// `executors.webhook` in step for what still reads them).

import { randomBytes, timingSafeEqual } from "node:crypto";
import { ENDPOINT_TYPES, UNIQUE_ENDPOINTS, parseEntry, type Endpoint, type EndpointType, type InputSpec, type Model, type WebhookExecutor } from "./types";
import { validateInputs } from "./inputs";

export const FN_RE = /^([^#\s]{1,200})#([A-Za-z_$][\w$]{0,80})$/;
const WEBHOOK_ID_RE = /^wh-[a-z0-9-]{1,40}$/;
const randToken = () => randomBytes(18).toString("base64url");
export const newWebhookId = () => `wh-${randomBytes(4).toString("hex")}`;

/** What every entry point type receives besides its declared inputs (for the console, /help and the docs). */
export const EVENT_FIELDS: Record<EndpointType, Array<{ name: string; type: string; help: string }>> = {
  execute: [],
  response: [
    { name: "text", type: "string", help: "the reply someone wrote to the model's message" },
    { name: "message", type: "object", help: "the message they replied to: { text, call } (call — its index in m5.model.calls)" },
  ],
  button: [
    { name: "name", type: "string", help: "the button's name (m5.out.button({ name }))" },
    { name: "data", type: "any", help: "the button's data" },
    { name: "event", type: "object", help: "{ type: \"click\" | \"js\", at, by }" },
  ],
  form: [
    { name: "name", type: "string", help: "the form's name" },
    { name: "values", type: "object", help: "the submitted values, by field name" },
    { name: "event", type: "object", help: "{ type: \"submit\" | \"js\", at, by }" },
  ],
  error: [
    { name: "error", type: "object", help: "{ type, message, stack? } — what went wrong" },
    { name: "failed", type: "object", help: "{ call, type, parms } — the call that failed (or whose result could not be shown)" },
    { name: "source", type: "string", help: "\"server\" (the function failed, or returned a bad result) or \"client\" (the browser could not show it)" },
  ],
  webhook: [
    { name: "_webhook", type: "object", help: "{ method, headers, query, endpoint } — the HTTP request (credentials removed)" },
  ],
};

/** "index.js#execute" of an entry string "pkg@1.0.0:index.js#execute". */
export function fnOfEntry(entry: string): string {
  const p = parseEntry(entry);
  return p ? `${p.file}#${p.fn}` : "";
}

/** The full entry ("pkg@ver:file#fn") of an entry point of this model. */
export function entryOf(model: Model, ep: Endpoint): string {
  const p = parseEntry(model.entry);
  return p ? `${p.pkg}@${p.version}:${ep.fn}` : "";
}

function legacyWebhook(model: Pick<Model, "entry" | "executors">): Endpoint | null {
  const w = model.executors?.webhook;
  if (!w || (!w.enabled && !w.token)) return null;
  return { id: "wh-default", type: "webhook", fn: fnOfEntry(model.entry) || "index.js#execute", name: "Webhook", inputs: [], ...w, enabled: Boolean(w.enabled) };
}

/** The entry points of a model — the list, or (a model from before 5.3) what `entry`, `inputs` and `executors.webhook` say. */
export function endpointsOf(model: Pick<Model, "entry" | "inputs" | "executors"> & { endpoints?: Endpoint[] }): Endpoint[] {
  const list = Array.isArray(model.endpoints) ? model.endpoints.filter((e) => e && typeof e === "object" && (ENDPOINT_TYPES as readonly string[]).includes(e.type)) : [];
  const out = [...list];
  if (!out.some((e) => e.type === "execute") && model.entry) out.unshift({ id: "execute", type: "execute", fn: fnOfEntry(model.entry), inputs: model.inputs ?? [], enabled: true });
  if (!list.length) { const w = legacyWebhook(model); if (w) out.push(w); }
  return out;
}

/** The (enabled) entry point of a unique type, or null. */
export function endpointOf(model: Model, type: EndpointType): Endpoint | null {
  return endpointsOf(model).find((e) => e.type === type && e.enabled !== false) ?? null;
}

/** The types a model answers (for the app: may a reply / a click reach it?). */
export function endpointTypes(model: Model): EndpointType[] {
  return [...new Set(endpointsOf(model).filter((e) => e.enabled !== false).map((e) => e.type))];
}

/** The webhook entry point a token opens (compared in constant time), enabled or not. */
export function webhookByToken(model: Model, token: string): Endpoint | null {
  const given = Buffer.from(token);
  for (const ep of endpointsOf(model)) {
    if (ep.type !== "webhook" || !ep.token) continue;
    const want = Buffer.from(ep.token);
    if (want.length === given.length && timingSafeEqual(want, given)) return ep;
  }
  return null;
}

const INPUT_TYPES = new Set(["string", "text", "integer", "number", "boolean", "enum", "date", "time", "duration", "url", "hostname", "email", "ip", "json", "object", "array", "user", "file", "secret"]);

/** Input specs as a save may hold them: a name and a known type each (other fields as they were). */
export function sanitizeInputs(raw: unknown): InputSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: InputSpec[] = [];
  const seen = new Set<string>();
  for (const r of raw.slice(0, 60)) {
    if (!r || typeof r !== "object") continue;
    const i = r as Record<string, unknown>;
    const name = typeof i.name === "string" ? i.name.trim() : "";
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) || seen.has(name)) continue;
    seen.add(name);
    const type = INPUT_TYPES.has(String(i.type)) ? String(i.type) as InputSpec["type"] : "string";
    out.push({
      name, type,
      ...(typeof i.label === "string" && i.label ? { label: i.label.slice(0, 120) } : {}),
      ...(typeof i.help === "string" && i.help ? { help: i.help.slice(0, 300) } : {}),
      ...(i.required === true ? { required: true } : {}),
      ...(i.default !== undefined && i.default !== "" ? { default: i.default } : {}),
      ...(typeof i.min === "number" ? { min: i.min } : {}),
      ...(typeof i.max === "number" ? { max: i.max } : {}),
      ...(typeof i.pattern === "string" && i.pattern ? { pattern: i.pattern.slice(0, 300) } : {}),
      ...(type === "enum" ? { values: Array.isArray(i.values) ? i.values.map(String).slice(0, 100) : [] } : {}),
    });
  }
  return out;
}

export class EndpointError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "EndpointError"; }
}

/**
 * The entry points a save keeps: one of each unique type (the first wins),
 * webhooks with stable ids, their tokens kept (or minted when a webhook is
 * first switched on; "rotate" mints a new one) and their secrets kept when a
 * save does not send them (the console may not see them).
 */
export function normalizeEndpoints(raw: unknown, prev: Endpoint[]): Endpoint[] {
  if (!Array.isArray(raw)) return prev;
  const out: Endpoint[] = [];
  const seenTypes = new Set<string>();
  const seenIds = new Set<string>();
  for (const r of raw.slice(0, 40)) {
    if (!r || typeof r !== "object") continue;
    const e = r as Record<string, unknown>;
    const type = (ENDPOINT_TYPES as readonly string[]).includes(String(e.type)) ? e.type as EndpointType : null;
    if (!type) continue;
    const fn = typeof e.fn === "string" ? e.fn.trim() : "";
    if (!FN_RE.test(fn)) throw new EndpointError("bad-endpoint", `The ${type} entry point needs a function as "file#function" (e.g. index.js#${type}).`);
    const unique = (UNIQUE_ENDPOINTS as readonly string[]).includes(type);
    if (unique) { if (seenTypes.has(type)) throw new EndpointError("bad-endpoint", `A model has one ${type} entry point.`); seenTypes.add(type); }
    let id = unique ? type : typeof e.id === "string" && WEBHOOK_ID_RE.test(e.id) ? e.id : newWebhookId();
    while (seenIds.has(id)) id = newWebhookId();
    seenIds.add(id);
    const ep: Endpoint = { id, type, fn, inputs: sanitizeInputs(e.inputs), enabled: e.enabled !== false };
    if (type === "webhook") {
      const before = prev.find((p) => p.id === id && p.type === "webhook");
      const token = e.token === "rotate" ? randToken() : (typeof e.token === "string" && e.token && e.token === before?.token ? e.token : before?.token) || (ep.enabled ? randToken() : undefined);
      const secret = typeof e.secret === "string" && e.secret ? e.secret.slice(0, 200) : before?.secret;
      Object.assign(ep, {
        name: typeof e.name === "string" && e.name.trim() ? e.name.trim().slice(0, 60) : before?.name ?? "Webhook",
        ...(token ? { token } : {}),
        auth: e.auth === "hmac" ? "hmac" : e.auth === "none" ? "none" : before?.auth ?? "none",
        ...(secret ? { secret } : {}),
        mode: e.mode === "async" || e.mode === "auto" || e.mode === "sync" ? e.mode : before?.mode ?? "sync",
        callback: typeof e.callback === "boolean" ? e.callback : before?.callback ?? false,
        log: e.log === "meta" || e.log === "off" || e.log === "full" ? e.log : before?.log ?? "full",
      } satisfies Partial<WebhookExecutor> & { name: string });
    }
    out.push(ep);
  }
  return out;
}

/** The first webhook as the pre-5.3 `executors.webhook` (older callers and the API still read it). */
export function legacyWebhookOf(endpoints: Endpoint[]): WebhookExecutor | undefined {
  const w = endpoints.find((e) => e.type === "webhook");
  if (!w) return undefined;
  return { enabled: w.enabled !== false, ...(w.token ? { token: w.token } : {}), auth: w.auth ?? "none", ...(w.secret ? { secret: w.secret } : {}), mode: w.mode ?? "sync", callback: w.callback ?? false, log: w.log ?? "full" };
}

/**
 * The parameters an entry point function gets: its declared inputs read from
 * the payload (a reply's text like a command's arguments, a button's data, a
 * form's values, a webhook's JSON body) — checked and typed — and the fields
 * its type always brings (EVENT_FIELDS). Values it did not declare are kept for
 * a webhook (a body is what it is) and dropped otherwise.
 */
export function eventInputs(ep: Endpoint, source: Record<string, unknown>, system: Record<string, unknown>, opts: { keepExtra?: boolean } = {}): Record<string, unknown> {
  const declared = ep.inputs?.length ? validateInputs(ep.inputs, source) : {};
  const extra = opts.keepExtra ? Object.fromEntries(Object.entries(source).filter(([k]) => !(k in declared))) : {};
  return { ...extra, ...declared, ...system };
}

/** A reply's text read like a command's arguments: key=value pairs, then the declared
 *  inputs in order (the last text input takes the rest) — "/dns example.com MX". */
export function argsToInputs(specs: InputSpec[], text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const byName = new Set(specs.map((s) => s.name));
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) tokens.push(m[1] ?? m[2] ?? m[3]);
  const bare: string[] = [];
  for (const tok of tokens) {
    const eq = tok.indexOf("=");
    if (eq > 0 && byName.has(tok.slice(0, eq))) out[tok.slice(0, eq)] = tok.slice(eq + 1);
    else bare.push(tok);
  }
  const positional = specs.filter((s) => s.type !== "user" && s.type !== "file" && s.type !== "secret" && !(s.name in out));
  let i = 0;
  positional.forEach((spec, k) => {
    if (i >= bare.length) return;
    if ((spec.type === "text" || spec.type === "string") && k === positional.length - 1) { out[spec.name] = bare.slice(i).join(" "); i = bare.length; }
    else out[spec.name] = bare[i++];
  });
  return out;
}
