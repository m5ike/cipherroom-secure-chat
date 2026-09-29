// The built-in packages (5.2): /help — the guide to the chat's commands — and
// the demo commands whois, dns, web, mail and domain on their shared library
// netkit. Their files are in ./src (real JavaScript; ./sources.ts is generated
// from them). On first start the main service installs them — packages,
// published versions and switched-on models — once; the console's gallery
// (Functions › Packages) installs or updates them again on request.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SOURCES } from "./sources";
import { functionsStore } from "../store";
import { createPackage, publishDraft, saveDraft, saveModel } from "../packages";
import type { Endpoint, EndpointType, InputSpec, Model } from "../types";
import { endpointsOf } from "../endpoints";

/** 5.3: the other entry points a built-in answers (its package exports a function of each name). */
export type BuiltinEndpoint = { type: Exclude<EndpointType, "execute" | "webhook">; inputs?: InputSpec[] };
export type BuiltinModel = { keyword: string; name: string; summary: string; inputs: InputSpec[]; visibility: "room" | "caller"; limits?: Partial<Model["limits"]>; endpoints?: BuiltinEndpoint[] };
export type BuiltinDef = { name: string; kind: "system" | "demo" | "library"; version: string; description: string; dependencies?: Record<string, string>; model?: BuiltinModel };

const V = "1.2.0";
const NET = { netkit: V };
const SLOW = { wallMs: 120_000, stepMs: 10_000, memoryMb: 256 };
// 1.1 (5.3): a reply, a click, a form and an error reach every command.
const EVENTS = (reply: InputSpec[] = [], form: InputSpec[] = []): BuiltinEndpoint[] => [{ type: "response", inputs: reply }, { type: "button" }, { type: "form", inputs: form }, { type: "error" }];

export const BUILTINS: readonly BuiltinDef[] = [
  { name: "netkit", kind: "library", version: V, description: "Network helpers for the demo commands: DNS, RDAP (whois), HTML, technologies, security headers, e-mail checks." },
  { name: "help", kind: "system", version: V, description: "The guide to the chat's commands: syntax, every command with its parameters and examples, webhooks, the API.",
    model: { keyword: "help", name: "Help", summary: "How to use commands, and every command you may run with its parameters", visibility: "caller",
      inputs: [{ name: "topic", type: "string", label: "Command or topic", help: "a command (e.g. dns), or: syntax, results, endpoints, buttons, forms, browser, model, webhooks, tags, rooms, android, all, ?" }],
      endpoints: [{ type: "response" }, { type: "button" }, { type: "error" }] } },
  { name: "whois", kind: "demo", version: V, description: "Who holds a domain or an IP address: registrar, dates, status, name servers, DNSSEC, abuse contact (RDAP).", dependencies: NET,
    model: { keyword: "whois", name: "Whois", summary: "Who holds a domain or IP address (registrar, expiry, DNSSEC, abuse)", visibility: "caller", limits: SLOW,
      inputs: [{ name: "query", type: "string", label: "Domain or IP address", help: "example.com, 1.1.1.1" }],
      endpoints: EVENTS([], [{ name: "query", type: "string", required: true }]) } },
  { name: "dns", kind: "demo", version: V, description: "DNS records of a host: everything at once, or A, AAAA, CNAME, MX, NS, TXT, SOA, CAA, SRV, PTR.", dependencies: NET,
    model: { keyword: "dns", name: "DNS lookup", summary: "DNS records: full, A, AAAA, MX, NS, CNAME, TXT, SOA, CAA, SRV, PTR", visibility: "caller", limits: SLOW,
      inputs: [
        { name: "name", type: "string", label: "Host name or IP address", help: "example.com" },
        { name: "type", type: "enum", label: "Record type", values: ["full", "A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA", "CAA", "SRV", "PTR"], default: "full" },
      ],
      // A reply "example.org MX" fills name and type; the form checks the host.
      endpoints: EVENTS([{ name: "name", type: "string" }, { name: "type", type: "string" }], [{ name: "name", type: "string", required: true }]) } },
  { name: "web", kind: "demo", version: V, description: "A web page analysed: status, speed, server and technologies, security headers, meta tags, robots.txt, sitemap, links, social networks.", dependencies: NET,
    model: { keyword: "web", name: "Web analysis", summary: "A web page analysed: speed, technologies, security headers, SEO basics, links", visibility: "caller", limits: SLOW,
      inputs: [{ name: "url", type: "string", label: "Web address", help: "https://example.com or just example.com" }],
      endpoints: EVENTS([], [{ name: "url", type: "string", required: true }]) } },
  { name: "mail", kind: "demo", version: V, description: "A domain's e-mail: MX and provider, SPF, DKIM, DMARC, MTA-STS, TLS-RPT, BIMI — a score and advice.", dependencies: NET,
    model: { keyword: "mail", name: "E-mail analysis", summary: "E-mail setup of a domain: MX, SPF, DKIM, DMARC, MTA-STS — score and advice", visibility: "caller", limits: SLOW,
      inputs: [{ name: "domain", type: "string", label: "Domain", help: "example.com" }],
      endpoints: EVENTS([], [{ name: "domain", type: "string", required: true }]) } },
  { name: "domain", kind: "demo", version: V, description: "The whole picture of a domain: registration, DNS, web, hosting, e-mail, social networks and links.", dependencies: NET,
    model: { keyword: "domain", name: "Domain analysis", summary: "Everything about a domain: registrar, DNS, web, hosting, e-mail, social networks, links", visibility: "caller", limits: { ...SLOW, wallMs: 180_000 },
      inputs: [{ name: "domain", type: "string", label: "Domain", help: "example.com" }],
      endpoints: EVENTS([], [{ name: "domain", type: "string", required: true }]) } },
];

export const BUILTIN_BY_NAME: Readonly<Record<string, BuiltinDef>> = Object.fromEntries(BUILTINS.map((b) => [b.name, b]));

function filesOf(def: BuiltinDef): Record<string, string> {
  const files = { ...(SOURCES[def.name] ?? {}) };
  if (!files["README.md"]) files["README.md"] = `# ${def.name}\n\n${def.description}\n\n${def.model ? `Chat: \`/${def.model.keyword}\`${def.model.inputs.map((i) => ` [${i.name}]`).join("")}\n` : "A library: `import { … } from \"pkg:" + def.name + "\";`\n"}\n_A built-in M5cet package (${def.kind}), version ${def.version}._\n`;
  return files;
}

export type InstallResult = { name: string; version: string; package: "created" | "updated" | "unchanged"; model: "created" | "updated" | "unchanged" | "none"; message?: string };

/**
 * Installs (or brings up to date) a built-in package: its dependencies
 * first, then the package with its files, the published version, and its
 * model (switched on, pointing at that version). A model the operator
 * changed keeps its settings — only its entry moves to the new version.
 */
export function installBuiltin(name: string, actor: string, opts: { enableModel?: boolean } = {}): InstallResult[] {
  const def = BUILTIN_BY_NAME[name];
  if (!def) throw new Error(`No built-in package ${name}.`);
  const out: InstallResult[] = [];
  for (const dep of Object.keys(def.dependencies ?? {})) if (BUILTIN_BY_NAME[dep]) out.push(...installBuiltin(dep, actor, opts).filter((r) => !out.some((x) => x.name === r.name)));
  let pkg = functionsStore.packageByName(def.name);
  let pkgState: InstallResult["package"] = "unchanged";
  if (!pkg) { pkg = createPackage(def.name, "js", def.description, actor); pkgState = "created"; }
  if (!functionsStore.version(pkg.id, def.version)) {
    saveDraft(pkg.id, filesOf(def), def.dependencies ?? {}, actor);
    publishDraft(pkg.id, def.version, actor);
    if (pkgState === "unchanged") pkgState = "updated";
  }
  let modelState: InstallResult["model"] = "none";
  if (def.model) {
    const entry = `${def.name}@${def.version}:index.js#execute`;
    const existing = functionsStore.modelByKeyword(def.model.keyword);
    if (!existing) {
      saveModel({
        name: def.model.name, keyword: def.model.keyword, summary: def.model.summary, entry, runtime: "server", inputs: def.model.inputs, outputs: ["markdown"],
        limits: def.model.limits ?? {}, executors: { chat: { enabled: true, visibility: def.model.visibility }, console: { enabled: true } } as Model["executors"],
        groups: [], enabled: opts.enableModel !== false, endpoints: builtinEndpoints(def.model, []),
      }, actor);
      modelState = "created";
    } else if (existing.entry.startsWith(`${def.name}@`) && (existing.entry !== entry || !sameEndpoints(existing, def.model))) {
      // The operator's own webhooks stay; the built-in's entry points move to the new version.
      saveModel({ id: existing.id, entry, inputs: def.model.inputs, endpoints: builtinEndpoints(def.model, endpointsOf(existing)) }, actor);
      modelState = "updated";
    } else modelState = existing.entry.startsWith(`${def.name}@`) ? "unchanged" : "none";
    if (modelState === "none") out.push({ name: def.name, version: def.version, package: pkgState, model: "none", message: `/${def.model.keyword} is used by another model (“${existing!.name}”) — the package is installed without a model.` });
  }
  if (!(modelState === "none" && def.model)) out.push({ name: def.name, version: def.version, package: pkgState, model: modelState });
  return out;
}

/** A built-in's entry points: execute and its events; what the operator added (webhooks) is kept. */
function builtinEndpoints(m: BuiltinModel, prev: Endpoint[]): Endpoint[] {
  const own: Endpoint[] = [{ id: "execute", type: "execute", fn: "index.js#execute", inputs: m.inputs, enabled: true }, ...(m.endpoints ?? []).map((e) => ({ id: e.type, type: e.type, fn: `index.js#${e.type}`, inputs: e.inputs ?? [], enabled: prev.find((p) => p.type === e.type)?.enabled ?? true }))];
  return [...own, ...prev.filter((p) => !own.some((o) => o.type === p.type))];
}
function sameEndpoints(existing: Model, m: BuiltinModel): boolean {
  const have = new Set(endpointsOf(existing).map((e) => `${e.type}:${e.fn}`));
  return (m.endpoints ?? []).every((e) => have.has(`${e.type}:index.js#${e.type}`));
}

/** What the gallery shows: each built-in, whether it is installed, and at which version. */
export function builtinCatalog() {
  return BUILTINS.map((def) => {
    const pkg = functionsStore.packageByName(def.name);
    const published = pkg ? functionsStore.versions(pkg.id).filter((v) => v.status === "published").map((v) => v.version) : [];
    const model = def.model ? functionsStore.modelByKeyword(def.model.keyword) : null;
    return { name: def.name, kind: def.kind, version: def.version, description: def.description, keyword: def.model?.keyword ?? null, summary: def.model?.summary ?? "", installed: Boolean(pkg), versions: published, current: published.includes(def.version), model: model ? { id: model.id, enabled: model.enabled, entry: model.entry } : null };
  });
}

function markerFile(): string {
  const data = process.env.DATA_DIR?.trim();
  return join(data || join(process.cwd(), ".m5cet"), "functions", "builtins.json");
}

/**
 * Once per installation (a marker file remembers it): installs /help and the
 * demos. Deleting one later does not bring it back — the gallery does.
 * FUNCTIONS_BUILTINS=0 turns it off.
 */
export async function seedBuiltins(actor = "system"): Promise<InstallResult[] | null> {
  if (process.env.FUNCTIONS_BUILTINS === "0") return null;
  const file = markerFile();
  let done: Record<string, string> = {};
  try { done = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>; } catch { /* first time */ }
  await functionsStore.ready();
  const results: InstallResult[] = [];
  for (const def of BUILTINS) {
    if (done[def.name] === def.version) continue;
    // Installed before at an older version: update it — unless the operator deleted it since.
    if (done[def.name] && !functionsStore.packageByName(def.name)) { done[def.name] = def.version; continue; }
    try { results.push(...installBuiltin(def.name, actor)); } catch (err) { results.push({ name: def.name, version: def.version, package: "unchanged", model: "none", message: (err as Error).message }); }
    done[def.name] = def.version;
  }
  if (results.length) {
    try { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, JSON.stringify(done, null, 2), { mode: 0o600 }); } catch { /* read-only: it retries next start */ }
  }
  return results;
}

export const builtinsSeeded = () => existsSync(markerFile());
