// Packages and models — the operations behind the console (4.15).
//
// A package has at most one *draft* (a mutable version being edited) plus the
// *published* versions, which are immutable and sealed to a fingerprint of
// their files. Editing changes the draft; publishing copies it to a fixed
// semver that models can point at. A model points at one published entry and
// carries its input schema, limits, executors and chat keyword.

import { randomBytes } from "node:crypto";
import { fingerprint, functionsStore, newId } from "./store";
import { parseEntry, ID_RE, KEYWORD_RE, NAME_RE, SEMVER_RE, type FileMap, type Lang, type Model, type Package, type PackageManifest, type PackageVersion } from "./types";

export class PackageError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "PackageError"; }
}
const bad = (code: string, message: string): never => { throw new PackageError(code, message); };

const DRAFT = "draft";
const MAX_FILES = 100;
const MAX_FILE_BYTES = 512 * 1024;
const FILE_RE = /^[A-Za-z0-9._-][A-Za-z0-9._/-]{0,199}$/;

const starterFiles = (lang: Lang): FileMap => lang === "py"
  ? { "index.py": "# The entry function receives the model's inputs as keyword arguments.\nasync def execute(name: str = \"world\"):\n    m5.log.info(\"hello\", name=name)\n    return m5.out.markdown(f\"# Hello, {name}!\")\n", "README.md": "# New package\n" }
  : { "index.js": "// The entry function receives the model's inputs as one object.\nexport async function execute({ name = \"world\" }) {\n  m5.log.info(\"hello\", { name });\n  return m5.out.markdown(`# Hello, ${name}!`);\n}\n", "README.md": "# New package\n" };

/* -------------------------------------------------------------- templates */

export type Template = { id: string; name: string; language: Lang; description: string; files: FileMap };

/** Starter packages the console offers under "New from template". */
export const TEMPLATES: Template[] = [
  { id: "hello-js", name: "Hello (JavaScript)", language: "js", description: "A minimal command that greets.",
    files: { "index.js": "export async function execute({ name = \"world\" }) {\n  m5.log.info(\"hello\", { name });\n  return m5.out.markdown(`# Hello, ${name}!`);\n}\n", "README.md": "# Hello\n" } },
  { id: "hello-py", name: "Hello (Python)", language: "py", description: "A minimal command that greets.",
    files: { "index.py": "async def execute(name: str = \"world\"):\n    m5.log.info(\"hello\", name=name)\n    return m5.out.markdown(f\"# Hello, {name}!\")\n", "README.md": "# Hello\n" } },
  { id: "http-fetch", name: "Fetch JSON (HTTP)", language: "js", description: "Calls an HTTP API and shows a field.",
    files: { "index.js": "export async function execute({ url }) {\n  const r = await m5.http.get(url);\n  if (!r.ok) return m5.out.text(`HTTP ${r.status}`);\n  return m5.out.json(r.json ?? r.text, { title: `${r.status} ${url}` });\n}\n" } },
  { id: "qr", name: "QR code", language: "js", description: "Turns text into a QR code.",
    files: { "index.js": "export async function execute({ text }) {\n  const qr = await m5.codes.qr(text || \"https://chat.fir.ma\", { scale: 5 });\n  return m5.out.image(m5.codec.base64.decode(qr.image.$b ?? qr.image), \"image/svg+xml\", { alt: \"QR\" });\n}\n" } },
  { id: "assistant", name: "AI assistant", language: "js", description: "Answers with the instance's model.",
    files: { "index.js": "export async function execute({ question }) {\n  const r = await m5.ai.chat({ messages: [{ role: \"user\", content: question }] });\n  return m5.out.markdown(r.text);\n}\n" } },
];

/* --------------------------------------------------------------- packages */

export function createPackage(name: string, language: Lang, description: string, actor: string, templateId?: string): Package {
  const clean = name.trim().toLowerCase();
  if (!NAME_RE.test(clean)) bad("bad-name", "A package name is lower-case letters, digits and hyphens (e.g. tools-net).");
  const template = templateId ? TEMPLATES.find((t) => t.id === templateId) ?? bad("no-template", "No such template.") : null;
  const lang = template ? template.language : language;
  if (lang !== "js" && lang !== "py") bad("bad-language", "The language is js or py.");
  if (functionsStore.packageByName(clean)) bad("exists", `A package named "${clean}" already exists.`);
  const now = Date.now();
  const pkg: Package = { id: newId("pkg"), name: clean, language: lang, description: (description || template?.description || "").slice(0, 500), draft: DRAFT, createdAt: now, updatedAt: now, updatedBy: actor };
  functionsStore.savePackage(pkg);
  const files = template ? { ...template.files } : starterFiles(lang);
  functionsStore.saveVersion({ packageId: pkg.id, version: DRAFT, manifest: draftManifest(pkg, files, {}), files, fingerprint: fingerprint(files), status: "draft", test: null, createdAt: now, createdBy: actor, publishedAt: null });
  return pkg;
}

function draftManifest(pkg: Package, files: FileMap, dependencies: Record<string, string>): PackageManifest {
  const main = pkg.language === "py" ? (files["index.py"] ? "index.py" : Object.keys(files).find((f) => f.endsWith(".py")) ?? "index.py") : (files["index.js"] ? "index.js" : Object.keys(files).find((f) => f.endsWith(".js")) ?? "index.js");
  return { name: pkg.name, version: DRAFT, language: pkg.language, main, dependencies, description: pkg.description };
}

function checkFiles(files: FileMap, lang: Lang): void {
  const names = Object.keys(files);
  if (!names.length) bad("empty", "A package needs at least one file.");
  if (names.length > MAX_FILES) bad("too-many", `A package has at most ${MAX_FILES} files.`);
  for (const [path, text] of Object.entries(files)) {
    if (!FILE_RE.test(path) || path.includes("..")) bad("bad-path", `"${path}" is not a valid file path.`);
    if (typeof text !== "string") bad("bad-file", `"${path}" must be text.`);
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) bad("too-big", `"${path}" is larger than ${MAX_FILE_BYTES / 1024} kB.`);
  }
  const ext = lang === "py" ? ".py" : ".js";
  if (!names.some((n) => n.endsWith(ext))) bad("no-code", `A ${lang} package needs at least one ${ext} file.`);
}

/** Saves the draft's files (and optional dependencies); creates the draft if it went missing. */
export function saveDraft(packageId: string, files: FileMap, dependencies: Record<string, string> | undefined, actor: string): PackageVersion {
  const pkg = functionsStore.package(packageId) ?? bad("no-package", "No such package.");
  checkFiles(files, pkg.language);
  const deps = sanitizeDeps(dependencies ?? {}, pkg);
  const now = Date.now();
  const manifest = draftManifest(pkg, files, deps);
  const version: PackageVersion = { packageId: pkg.id, version: DRAFT, manifest, files, fingerprint: fingerprint(files), status: "draft", test: functionsStore.version(pkg.id, DRAFT)?.test ?? null, createdAt: functionsStore.version(pkg.id, DRAFT)?.createdAt ?? now, createdBy: actor, publishedAt: null };
  functionsStore.saveVersion(version);
  functionsStore.savePackage({ ...pkg, draft: DRAFT, updatedAt: now, updatedBy: actor });
  return version;
}

function sanitizeDeps(deps: Record<string, string>, pkg: Package): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, ver] of Object.entries(deps)) {
    if (!NAME_RE.test(name)) bad("bad-dep", `"${name}" is not a package name.`);
    if (name === pkg.name) bad("bad-dep", "A package cannot depend on itself.");
    if (!SEMVER_RE.test(ver)) bad("bad-dep", `The version of "${name}" must be exact (e.g. 1.0.0).`);
    const dv = functionsStore.versionByName(name, ver);
    if (!dv || dv.status !== "published") bad("no-dep", `${name}@${ver} is not published.`);
    if (dv!.manifest.language !== pkg.language) bad("dep-language", `${name} is a ${dv!.manifest.language} package; ${pkg.name} is ${pkg.language}.`);
    out[name] = ver;
  }
  return out;
}

/** Copies the draft to an immutable version; `bump` picks the next semver. */
export function publishDraft(packageId: string, bump: "patch" | "minor" | "major" | string, actor: string): PackageVersion {
  const pkg = functionsStore.package(packageId) ?? bad("no-package", "No such package.");
  const draft = functionsStore.version(pkg.id, DRAFT) ?? bad("no-draft", "There is nothing to publish.");
  checkFiles(draft.files, pkg.language);
  const version = nextVersion(pkg, bump);
  if (functionsStore.version(pkg.id, version)) bad("exists", `Version ${version} is already published.`);
  const now = Date.now();
  const manifest = { ...draft.manifest, version };
  functionsStore.saveVersion({ packageId: pkg.id, version, manifest, files: draft.files, fingerprint: fingerprint(draft.files), status: "published", test: draft.test, createdAt: now, createdBy: actor, publishedAt: now });
  functionsStore.savePackage({ ...pkg, updatedAt: now, updatedBy: actor });
  return functionsStore.version(pkg.id, version)!;
}

function nextVersion(pkg: Package, bump: string): string {
  if (SEMVER_RE.test(bump)) return bump;
  const published = functionsStore.versions(pkg.id).filter((v) => v.status === "published").map((v) => v.version.split(".").map(Number));
  const [maj = 0, min = 0, pat = 0] = published.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2])[0] ?? [0, 0, 0];
  if (bump === "major") return `${maj + 1}.0.0`;
  if (bump === "minor") return `${maj}.${min + 1}.0`;
  return published.length ? `${maj}.${min}.${pat + 1}` : "1.0.0";
}

export function deletePackage(packageId: string, actor: string): void {
  const pkg = functionsStore.package(packageId) ?? bad("no-package", "No such package.");
  const users = functionsStore.models().filter((m) => parseEntry(m.entry)?.pkg === pkg.name);
  if (users.length) bad("in-use", `These models use ${pkg.name}: ${users.map((m) => m.name).join(", ")}. Point them elsewhere first.`);
  functionsStore.deletePackage(pkg.id);
}

/* ----------------------------------------------------------------- models */

const DEFAULT_EXECUTORS: Model["executors"] = { chat: { enabled: false, visibility: "room" }, console: { enabled: true } };

export function saveModel(input: Partial<Model> & { id?: string }, actor: string): Model {
  const now = Date.now();
  const existing = input.id ? functionsStore.model(input.id) : null;
  const id = existing?.id ?? (input.id?.trim() || newId("mdl"));
  if (!existing && input.id && !ID_RE.test(input.id)) bad("bad-id", "A model id is lower-case letters, digits and hyphens.");
  const keyword = (input.keyword ?? existing?.keyword ?? "").trim().toLowerCase();
  if (keyword && !KEYWORD_RE.test(keyword)) bad("bad-keyword", "A keyword is lower-case letters, digits, - and _ (no slash).");
  if (keyword) { const clash = functionsStore.modelByKeyword(keyword); if (clash && clash.id !== id) bad("keyword-clash", `The keyword /${keyword} is already used by "${clash.name}".`); }
  const entry = (input.entry ?? existing?.entry ?? "").trim();
  const parsed = entry ? parseEntry(entry) : null;
  if (entry && !parsed) bad("bad-entry", 'The entry is "package@version:file#function".');
  if (parsed) {
    const v = functionsStore.versionByName(parsed.pkg, parsed.version);
    if (!v || v.status !== "published") bad("no-entry", `${parsed.pkg}@${parsed.version} is not published.`);
    if (!Object.prototype.hasOwnProperty.call(v!.files, parsed.file)) bad("no-entry", `${parsed.pkg}@${parsed.version} has no file ${parsed.file}.`);
  }
  const model: Model = {
    id,
    name: (input.name ?? existing?.name ?? "").trim() || bad("bad-name", "A model needs a name."),
    keyword,
    summary: (input.summary ?? existing?.summary ?? "").slice(0, 500),
    entry,
    onEvent: (input.onEvent ?? existing?.onEvent ?? "").trim(),
    runtime: input.runtime ?? existing?.runtime ?? "auto",
    inputs: Array.isArray(input.inputs) ? input.inputs : existing?.inputs ?? [],
    outputs: Array.isArray(input.outputs) ? input.outputs : existing?.outputs ?? ["markdown"],
    limits: input.limits ?? existing?.limits ?? {},
    executors: normalizeExecutors(input.executors ?? existing?.executors ?? DEFAULT_EXECUTORS, existing?.executors),
    groups: Array.isArray(input.groups) ? input.groups.filter((g) => typeof g === "string") : existing?.groups ?? [],
    enabled: input.enabled ?? existing?.enabled ?? false,
    revision: (existing?.revision ?? 0) + 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    updatedBy: actor,
  };
  functionsStore.saveModel(model);
  return model;
}

/** Keeps a stable webhook token (capability in the URL) once the webhook is on,
 *  and mints one when it is first enabled. */
function normalizeExecutors(next: Model["executors"], prev: Model["executors"] | undefined): Model["executors"] {
  const out = { ...next };
  if (out.webhook?.enabled) {
    const token = out.webhook.token || prev?.webhook?.token || randToken();
    out.webhook = { enabled: true, token, auth: out.webhook.auth === "hmac" ? "hmac" : "none", ...(out.webhook.secret ? { secret: out.webhook.secret } : prev?.webhook?.secret ? { secret: prev.webhook.secret } : {}) };
  }
  if (out.api?.enabled) out.api = { enabled: true, token: out.api.token || prev?.api?.token || randToken() };
  return out;
}
function randToken(): string { return randomBytes(18).toString("base64url"); }

export function deleteModel(id: string): void {
  functionsStore.model(id) ?? bad("no-model", "No such model.");
  functionsStore.deleteModel(id);
}

/* -------------------------------------------------------- export / import */

export type PackageBundle = {
  format: "m5pkg";
  bundleVersion: 1;
  name: string;
  language: Lang;
  description: string;
  exportedAt: number;
  versions: Array<{ version: string; manifest: PackageManifest; files: FileMap; fingerprint: string }>;
};

/** A package with its published versions as a portable bundle (.m5pkg). */
export function exportPackage(packageId: string): PackageBundle {
  const pkg = functionsStore.package(packageId) ?? bad("no-package", "No such package.");
  const versions = functionsStore.versions(pkg.id).filter((v) => v.status === "published").sort((a, b) => (a.publishedAt ?? 0) - (b.publishedAt ?? 0));
  if (!versions.length) bad("empty", "Publish a version before exporting.");
  return {
    format: "m5pkg", bundleVersion: 1, name: pkg.name, language: pkg.language, description: pkg.description, exportedAt: Date.now(),
    versions: versions.map((v) => ({ version: v.version, manifest: v.manifest, files: v.files, fingerprint: v.fingerprint })),
  };
}

/** Creates a package from a bundle. A clashing name gets a suffix unless `name`
 *  is given; every published version comes in, and the latest becomes the draft. */
export function importPackage(bundle: unknown, actor: string, nameOverride?: string): Package {
  const b = bundle as Partial<PackageBundle>;
  if (!b || b.format !== "m5pkg" || !Array.isArray(b.versions) || !b.versions.length) bad("bad-bundle", "That is not an .m5pkg bundle.");
  const language = b.language === "py" ? "py" : "js";
  let name = (nameOverride || b.name || "imported").trim().toLowerCase();
  if (!NAME_RE.test(name)) bad("bad-name", "The package name in the bundle is not valid.");
  if (functionsStore.packageByName(name)) {
    let n = 2;
    while (functionsStore.packageByName(`${name}-${n}`)) n++;
    name = `${name}-${n}`;
  }
  const now = Date.now();
  const pkg: Package = { id: newId("pkg"), name, language, description: String(b.description ?? "").slice(0, 500), draft: DRAFT, createdAt: now, updatedAt: now, updatedBy: actor };
  functionsStore.savePackage(pkg);
  const sorted = [...b.versions!].filter((v) => v && SEMVER_RE.test(String(v.version)) && v.files && typeof v.files === "object");
  for (const v of sorted) {
    checkFiles(v.files as FileMap, language);
    const files = v.files as FileMap;
    const manifest: PackageManifest = { name, version: v.version, language, main: v.manifest?.main || (language === "py" ? "index.py" : "index.js"), dependencies: v.manifest?.dependencies ?? {}, description: pkg.description };
    functionsStore.saveVersion({ packageId: pkg.id, version: v.version, manifest, files, fingerprint: fingerprint(files), status: "published", test: null, createdAt: now, createdBy: actor, publishedAt: now });
  }
  const latest = sorted[sorted.length - 1];
  if (latest) functionsStore.saveVersion({ packageId: pkg.id, version: DRAFT, manifest: draftManifest(pkg, latest.files as FileMap, latest.manifest?.dependencies ?? {}), files: latest.files as FileMap, fingerprint: fingerprint(latest.files as FileMap), status: "draft", test: null, createdAt: now, createdBy: actor, publishedAt: null });
  return pkg;
}

export { DRAFT };
