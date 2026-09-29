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
import type { InputSpec, Model } from "../types";

export type BuiltinModel = { keyword: string; name: string; summary: string; inputs: InputSpec[]; visibility: "room" | "caller"; limits?: Partial<Model["limits"]> };
export type BuiltinDef = { name: string; kind: "system" | "demo" | "library"; version: string; description: string; dependencies?: Record<string, string>; model?: BuiltinModel };

const NET = { netkit: "1.0.0" };
const SLOW = { wallMs: 120_000, stepMs: 10_000, memoryMb: 256 };

export const BUILTINS: readonly BuiltinDef[] = [
  { name: "netkit", kind: "library", version: "1.0.0", description: "Network helpers for the demo commands: DNS, RDAP (whois), HTML, technologies, security headers, e-mail checks." },
  { name: "help", kind: "system", version: "1.0.0", description: "The guide to the chat's commands: syntax, every command with its parameters and examples, webhooks, the API.",
    model: { keyword: "help", name: "Help", summary: "How to use commands, and every command you may run with its parameters", visibility: "caller",
      inputs: [{ name: "topic", type: "string", label: "Command or topic", help: "a command (e.g. dns), or: syntax, webhooks, api, tags, all, ?" }] } },
  { name: "whois", kind: "demo", version: "1.0.0", description: "Who holds a domain or an IP address: registrar, dates, status, name servers, DNSSEC, abuse contact (RDAP).", dependencies: NET,
    model: { keyword: "whois", name: "Whois", summary: "Who holds a domain or IP address (registrar, expiry, DNSSEC, abuse)", visibility: "caller", limits: SLOW,
      inputs: [{ name: "query", type: "string", label: "Domain or IP address", help: "example.com, 1.1.1.1" }] } },
  { name: "dns", kind: "demo", version: "1.0.0", description: "DNS records of a host: everything at once, or A, AAAA, CNAME, MX, NS, TXT, SOA, CAA, SRV, PTR.", dependencies: NET,
    model: { keyword: "dns", name: "DNS lookup", summary: "DNS records: full, A, AAAA, MX, NS, CNAME, TXT, SOA, CAA, SRV, PTR", visibility: "caller", limits: SLOW,
      inputs: [
        { name: "name", type: "string", label: "Host name or IP address", help: "example.com" },
        { name: "type", type: "enum", label: "Record type", values: ["full", "A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA", "CAA", "SRV", "PTR"], default: "full" },
      ] } },
  { name: "web", kind: "demo", version: "1.0.0", description: "A web page analysed: status, speed, server and technologies, security headers, meta tags, robots.txt, sitemap, links, social networks.", dependencies: NET,
    model: { keyword: "web", name: "Web analysis", summary: "A web page analysed: speed, technologies, security headers, SEO basics, links", visibility: "caller", limits: SLOW,
      inputs: [{ name: "url", type: "string", label: "Web address", help: "https://example.com or just example.com" }] } },
  { name: "mail", kind: "demo", version: "1.0.0", description: "A domain's e-mail: MX and provider, SPF, DKIM, DMARC, MTA-STS, TLS-RPT, BIMI — a score and advice.", dependencies: NET,
    model: { keyword: "mail", name: "E-mail analysis", summary: "E-mail setup of a domain: MX, SPF, DKIM, DMARC, MTA-STS — score and advice", visibility: "caller", limits: SLOW,
      inputs: [{ name: "domain", type: "string", label: "Domain", help: "example.com" }] } },
  { name: "domain", kind: "demo", version: "1.0.0", description: "The whole picture of a domain: registration, DNS, web, hosting, e-mail, social networks and links.", dependencies: NET,
    model: { keyword: "domain", name: "Domain analysis", summary: "Everything about a domain: registrar, DNS, web, hosting, e-mail, social networks, links", visibility: "caller", limits: { ...SLOW, wallMs: 180_000 },
      inputs: [{ name: "domain", type: "string", label: "Domain", help: "example.com" }] } },
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
        groups: [], enabled: opts.enableModel !== false,
      }, actor);
      modelState = "created";
    } else if (existing.entry.startsWith(`${def.name}@`) && existing.entry !== entry) {
      saveModel({ id: existing.id, entry, inputs: def.model.inputs }, actor);
      modelState = "updated";
    } else modelState = existing.entry.startsWith(`${def.name}@`) ? "unchanged" : "none";
    if (modelState === "none") out.push({ name: def.name, version: def.version, package: pkgState, model: "none", message: `/${def.model.keyword} is used by another model (“${existing!.name}”) — the package is installed without a model.` });
  }
  if (!(modelState === "none" && def.model)) out.push({ name: def.name, version: def.version, package: pkgState, model: modelState });
  return out;
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
    if (done[def.name]) continue;
    try { results.push(...installBuiltin(def.name, actor)); } catch (err) { results.push({ name: def.name, version: def.version, package: "unchanged", model: "none", message: (err as Error).message }); }
    done[def.name] = def.version;
  }
  if (results.length) {
    try { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, JSON.stringify(done, null, 2), { mode: 0o600 }); } catch { /* read-only: it retries next start */ }
  }
  return results;
}

export const builtinsSeeded = () => existsSync(markerFile());
