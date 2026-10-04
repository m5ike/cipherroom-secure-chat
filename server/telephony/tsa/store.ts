// Where the TSAs live (6.9): one JSON file next to telephony.json —
// telephony-tsa.json (TSA_DATA_FILE moves it) — written atomically with mode
// 0600 by the admin service (the console's editor) and read by the main
// service, which runs them on calls. Like the SIP trunks (store.ts) the
// readers notice a change by the file's content and reload without a restart.
//
// Why a file and not the telephony database: a TSA is configuration — edited
// rarely, read on every new call, worth exporting, diffing and backing up
// with the rest of the module's settings — while telephony.db holds what
// happens (calls, sessions). A running call never reads this file again: its
// session keeps the graph it started with (tsa/db.ts), so a publish in the
// middle of a call does not change that call.
//
// A TSA has a draft (what the editor saves) and, once published, a frozen
// copy calls run; publishing refuses a draft with errors (validate.ts) and
// increments the version.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { dataFilePath, fileSignature } from "../store";
import { telPermissions } from "../control/hooks";
import { defaultParams } from "./catalog";
import { TSA_ID, type Tsa, type TsaEdge, type TsaGraph, type TsaNode, type TsaProblem } from "./types";
import { hasErrors, validateGraph, validateStructure } from "./validate";
import { TSA_TEMPLATES } from "./templates";

/** Ids a TSA cannot have (they are paths of the console's API). */
const RESERVED = new Set(["catalog", "import", "files", "templates", "new"]);
const MAX_TSAS = 500;
const MAX_GRAPH_BYTES = 2 * 1024 * 1024;

export function tsaFilePath(): string {
  const explicit = process.env.TSA_DATA_FILE?.trim();
  if (explicit) return resolve(explicit);
  return join(dirname(dataFilePath()), "telephony-tsa.json");
}

type TsaFile = { version: 1; tsas: Tsa[] };

export class TsaStoreError extends Error {
  constructor(readonly status: number, message: string, readonly problems: TsaProblem[] = []) { super(message); this.name = "TsaStoreError"; }
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** A graph reduced to the fields the contract knows (JSON values only, bounded). */
export function cleanGraph(raw: unknown): TsaGraph {
  if (!isObj(raw)) return { nodes: [], edges: [] };
  let json = "";
  try { json = JSON.stringify(raw); } catch { throw new TsaStoreError(400, "The graph is not plain data."); }
  if (json.length > MAX_GRAPH_BYTES) throw new TsaStoreError(413, `The graph is too big (${Math.round(json.length / 1024)} kB; 2 MB at most).`);
  const g = JSON.parse(json) as { nodes?: unknown; edges?: unknown };
  const nodes = (Array.isArray(g.nodes) ? g.nodes : []).filter(isObj).map((n): TsaNode => ({
    id: n.id as string, type: n.type as TsaNode["type"], x: n.x as number, y: n.y as number,
    ...(n.w !== undefined ? { w: n.w as number } : {}),
    ...(n.label !== undefined ? { label: n.label as string } : {}),
    ...(n.note !== undefined ? { note: n.note as string } : {}),
    ...(n.inputs !== undefined ? { inputs: n.inputs as number } : {}),
    params: isObj(n.params) ? n.params : {},
  }));
  const edges = (Array.isArray(g.edges) ? g.edges : []).filter(isObj).map((e): TsaEdge => ({
    id: e.id as string,
    from: isObj(e.from) ? { node: e.from.node as string, port: e.from.port as string } : { node: "", port: "" },
    to: isObj(e.to) ? { node: e.to.node as string, port: e.to.port as string } : { node: "", port: "" },
    kind: e.kind as TsaEdge["kind"],
  }));
  return { nodes, edges };
}

/** The smallest TSA: a Start that answers, and a Hang up. */
export function emptyGraph(): TsaGraph {
  return {
    nodes: [
      { id: "start", type: "start", x: 80, y: 80, params: defaultParams("start") },
      { id: "end", type: "hangup", x: 80, y: 260, params: defaultParams("hangup") },
    ],
    edges: [{ id: "e1", from: { node: "start", port: "next" }, to: { node: "end", port: "in" }, kind: "flow" }],
  };
}

function sanitizeTsa(raw: unknown): Tsa | null {
  if (!isObj(raw) || typeof raw.id !== "string" || !TSA_ID.test(raw.id)) return null;
  let graph: TsaGraph;
  try { graph = cleanGraph(raw.graph); } catch { return null; }
  let published: Tsa["published"] = null;
  if (isObj(raw.published) && Number.isInteger(raw.published.version)) {
    try {
      published = { version: raw.published.version as number, graph: cleanGraph(raw.published.graph), at: Number(raw.published.at) || 0, by: str(raw.published.by, 120) };
    } catch { published = null; }
  }
  return {
    id: raw.id, name: str(raw.name, 120) || raw.id, description: str(raw.description, 2000), graph, published,
    version: Number.isInteger(raw.version) ? (raw.version as number) : published?.version ?? 0,
    createdAt: Number(raw.createdAt) || Date.now(), updatedAt: Number(raw.updatedAt) || Date.now(), updatedBy: str(raw.updatedBy, 120),
    tags: Array.isArray(raw.tags) ? raw.tags.map((t) => str(t, 40)).filter(Boolean).slice(0, 20) : [],
  };
}

const slug = (s: string): string => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/* ---------------------------------------------------------------- used by */

/** Who else may say which rules use a TSA (the control part can register a precise answer). */
let usageSource: ((id: string) => string[]) | null = null;
export function setTsaUsageSource(fn: ((id: string) => string[]) | null): void { usageSource = fn; }

/** Rules found in a JSON document: any list called inbound / outbound whose items target a TSA. */
function rulesIn(doc: unknown, id: string, depth = 0, found: string[] = []): string[] {
  if (!isObj(doc) || depth > 4) return found;
  for (const [k, v] of Object.entries(doc)) {
    if ((k === "inbound" || k === "outbound") && Array.isArray(v)) {
      for (const r of v) {
        if (isObj(r) && isObj(r.target) && r.target.kind === "tsa" && r.target.tsa === id) found.push(`${k} rule ${str(r.label, 80) || str(r.id, 64) || "?"}`);
      }
    } else if ((k === "inbound" || k === "outbound") && isObj(v) && v.kind === "tsa" && v.tsa === id) {
      found.push(`the default for ${k} calls`);
    } else if (isObj(v)) rulesIn(v, id, depth + 1, found);
  }
  return found;
}

/* ------------------------------------------------------------------ store */

export class TsaStore {
  private map = new Map<string, Tsa>();
  private sig = "";
  private loaded = false;
  private lastError = "";

  private refresh(): void {
    const file = tsaFilePath();
    const sig = fileSignature(file);
    if (this.loaded && sig === this.sig) return;
    this.loaded = true;
    if (!sig) { if (this.sig) this.map.clear(); this.sig = ""; return; }
    try {
      const doc = JSON.parse(readFileSync(file, "utf8")) as Partial<TsaFile>;
      const next = new Map<string, Tsa>();
      for (const raw of Array.isArray(doc.tsas) ? doc.tsas : []) {
        const t = sanitizeTsa(raw);
        if (t && !next.has(t.id)) next.set(t.id, t);
      }
      this.map = next;
      this.sig = sig;
    } catch (err) {
      // A corrupt file: keep what we had (and say so).
      this.lastError = `cannot read ${file}: ${(err as Error).message}`;
      this.sig = sig;
    }
  }

  private save(): void {
    const file = tsaFilePath();
    const doc: TsaFile = { version: 1, tsas: [...this.map.values()].sort((a, b) => a.id.localeCompare(b.id)) };
    const body = JSON.stringify(doc, null, 1);
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
      writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, file);
      this.sig = createHash("sha1").update(body).digest("hex");
      this.lastError = "";
    } catch (err) {
      this.lastError = `cannot write ${file}: ${(err as Error).message} — the TSAs are kept in memory only`;
    }
  }

  status(): { file: string; exists: boolean; error: string } {
    return { file: tsaFilePath(), exists: existsSync(tsaFilePath()), error: this.lastError };
  }

  list(): Tsa[] { this.refresh(); return [...this.map.values()].sort((a, b) => a.name.localeCompare(b.name)).map(clone); }
  get(id: string): Tsa | null { this.refresh(); const t = this.map.get(id); return t ? clone(t) : null; }
  has(id: string): boolean { this.refresh(); return this.map.has(id); }

  /** A free id from a wish or a name. */
  freeId(wish: string): string {
    this.refresh();
    let base = slug(wish);
    if (!TSA_ID.test(base) || RESERVED.has(base)) base = base.length >= 2 && !RESERVED.has(base) ? `tsa-${base}`.slice(0, 40) : `tsa-${randomBytes(3).toString("hex")}`;
    if (!TSA_ID.test(base)) base = `tsa-${randomBytes(3).toString("hex")}`;
    let id = base;
    for (let i = 2; this.map.has(id); i++) id = `${base.slice(0, 44)}-${i}`;
    return id;
  }

  create(input: { id?: unknown; name?: unknown; description?: unknown; template?: unknown; tags?: unknown }, by: string): { tsa: Tsa; problems: TsaProblem[] } {
    this.refresh();
    if (this.map.size >= MAX_TSAS) throw new TsaStoreError(409, `There are ${MAX_TSAS} TSAs already.`);
    const name = str(input.name, 120).trim();
    if (!name) throw new TsaStoreError(400, "name is required.");
    let id: string;
    if (typeof input.id === "string" && input.id) {
      if (!TSA_ID.test(input.id) || RESERVED.has(input.id)) throw new TsaStoreError(400, `id "${input.id.slice(0, 48)}": 2–48 characters a-z, 0-9 and - (not ${[...RESERVED].join(", ")}).`);
      if (this.map.has(input.id)) throw new TsaStoreError(409, `A TSA "${input.id}" exists already.`);
      id = input.id;
    } else id = this.freeId(name);
    let graph = emptyGraph();
    let description = str(input.description, 2000);
    if (typeof input.template === "string" && input.template) {
      const t = TSA_TEMPLATES.find((x) => x.id === input.template);
      if (!t) throw new TsaStoreError(400, `No template "${input.template.slice(0, 40)}" (${TSA_TEMPLATES.map((x) => x.id).join(", ")}).`);
      graph = t.graph();
      if (!description) description = t.description;
    }
    const now = Date.now();
    const tsa: Tsa = { id, name, description, graph, published: null, version: 0, createdAt: now, updatedAt: now, updatedBy: by, tags: cleanTags(input.tags) };
    this.map.set(id, tsa);
    this.save();
    return { tsa: clone(tsa), problems: this.problems(graph) };
  }

  /** The editor's save: refused only when the graph's shape is broken; every problem comes back. */
  saveDraft(id: string, body: { name?: unknown; description?: unknown; graph?: unknown; tags?: unknown }, by: string): { tsa: Tsa; problems: TsaProblem[] } {
    this.refresh();
    const t = this.map.get(id);
    if (!t) throw new TsaStoreError(404, `No TSA "${id}".`);
    const graph = body.graph === undefined ? t.graph : cleanGraph(body.graph);
    const structure = validateStructure(graph);
    if (hasErrors(structure)) throw new TsaStoreError(422, "The graph has errors that keep it from being saved.", this.problems(graph));
    if (body.name !== undefined) { const n = str(body.name, 120).trim(); if (!n) throw new TsaStoreError(400, "name cannot be empty."); t.name = n; }
    if (body.description !== undefined) t.description = str(body.description, 2000);
    if (body.tags !== undefined) t.tags = cleanTags(body.tags);
    t.graph = graph;
    t.updatedAt = Date.now();
    t.updatedBy = by;
    this.save();
    return { tsa: clone(t), problems: this.problems(graph) };
  }

  /** Every problem of a graph, the HTTP tool checked against the current permissions. */
  problems(graph: unknown): TsaProblem[] {
    let hosts: string[] | undefined;
    try { hosts = telPermissions().tsa.httpHosts; } catch { hosts = undefined; }
    return validateGraph(graph, { httpHosts: hosts });
  }

  publish(id: string, by: string): { tsa: Tsa; problems: TsaProblem[] } {
    this.refresh();
    const t = this.map.get(id);
    if (!t) throw new TsaStoreError(404, `No TSA "${id}".`);
    const problems = this.problems(t.graph);
    if (hasErrors(problems)) throw new TsaStoreError(422, "The draft has errors; fix them before publishing.", problems);
    t.version += 1;
    t.published = { version: t.version, graph: clone(t.graph), at: Date.now(), by };
    t.updatedAt = Date.now();
    t.updatedBy = by;
    this.save();
    return { tsa: clone(t), problems };
  }

  duplicate(id: string, wish: { id?: unknown; name?: unknown }, by: string): Tsa {
    this.refresh();
    const t = this.map.get(id);
    if (!t) throw new TsaStoreError(404, `No TSA "${id}".`);
    if (this.map.size >= MAX_TSAS) throw new TsaStoreError(409, `There are ${MAX_TSAS} TSAs already.`);
    let newId: string;
    if (typeof wish.id === "string" && wish.id) {
      if (!TSA_ID.test(wish.id) || RESERVED.has(wish.id)) throw new TsaStoreError(400, `id "${wish.id.slice(0, 48)}" is not valid.`);
      if (this.map.has(wish.id)) throw new TsaStoreError(409, `A TSA "${wish.id}" exists already.`);
      newId = wish.id;
    } else newId = this.freeId(`${t.id}-copy`);
    const now = Date.now();
    const copy: Tsa = { ...clone(t), id: newId, name: str(wish.name, 120).trim() || `${t.name} (copy)`, published: null, version: 0, createdAt: now, updatedAt: now, updatedBy: by };
    this.map.set(newId, copy);
    this.save();
    return clone(copy);
  }

  remove(id: string): void {
    this.refresh();
    if (!this.map.has(id)) throw new TsaStoreError(404, `No TSA "${id}".`);
    const used = this.usedBy(id);
    if (used.length) throw new TsaStoreError(409, `"${id}" is used by ${used.join(", ")} — change those first.`);
    this.map.delete(id);
    this.save();
  }

  /** Which routing rules (and defaults) send calls to this TSA — read defensively from the control part's data. */
  usedBy(id: string): string[] {
    const found = new Set<string>();
    if (usageSource) { try { for (const r of usageSource(id)) found.add(r); } catch { /* the control part's problem */ } }
    try {
      const d = telPermissions().defaults;
      if (d.inbound.kind === "tsa" && d.inbound.tsa === id) found.add("the default for inbound calls");
      if (d.outbound.kind === "tsa" && d.outbound.tsa === id) found.add("the default for outbound calls");
    } catch { /* no permissions */ }
    const dir = dirname(dataFilePath());
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => /^telephony.*\.json$/.test(f) && f !== "telephony-tsa.json" && f !== "telephony-events.json"); } catch { /* no directory yet */ }
    for (const f of files) {
      const path = join(dir, f);
      try {
        if (statSync(path).size > 5 * 1024 * 1024) continue;
        for (const r of rulesIn(JSON.parse(readFileSync(path, "utf8")), id)) found.add(r);
      } catch { /* not ours to judge */ }
    }
    return [...found];
  }

  exportOne(id: string): Record<string, unknown> {
    const t = this.get(id);
    if (!t) throw new TsaStoreError(404, `No TSA "${id}".`);
    return { format: "m5cet-tsa", formatVersion: 1, exportedAt: new Date().toISOString(), tsa: { id: t.id, name: t.name, description: t.description, tags: t.tags, graph: t.graph, publishedVersion: t.published?.version ?? 0 } };
  }

  /** A TSA file (an export, or a bare Tsa / graph): a new draft, never published; the id is made free. */
  importOne(raw: unknown, by: string, wish: { id?: unknown; name?: unknown } = {}): { tsa: Tsa; problems: TsaProblem[] } {
    this.refresh();
    if (this.map.size >= MAX_TSAS) throw new TsaStoreError(409, `There are ${MAX_TSAS} TSAs already.`);
    const doc = isObj(raw) && isObj(raw.tsa) ? raw.tsa : raw;
    if (!isObj(doc)) throw new TsaStoreError(400, "Not a TSA file.");
    const graphRaw = isObj(doc.graph) ? doc.graph : Array.isArray(doc.nodes) ? doc : null;
    if (!graphRaw) throw new TsaStoreError(400, "The file has no graph.");
    const graph = cleanGraph(graphRaw);
    const structure = validateStructure(graph);
    if (hasErrors(structure)) throw new TsaStoreError(422, "The TSA in the file is broken.", this.problems(graph));
    const name = str(wish.name, 120).trim() || str(doc.name, 120).trim() || "Imported TSA";
    const id = typeof wish.id === "string" && wish.id && TSA_ID.test(wish.id) && !RESERVED.has(wish.id) && !this.map.has(wish.id)
      ? wish.id : this.freeId(typeof doc.id === "string" && doc.id ? doc.id : name);
    const now = Date.now();
    const tsa: Tsa = { id, name, description: str(doc.description, 2000), graph, published: null, version: 0, createdAt: now, updatedAt: now, updatedBy: by, tags: cleanTags(doc.tags) };
    this.map.set(id, tsa);
    this.save();
    return { tsa: clone(tsa), problems: this.problems(graph) };
  }

  /** Tests: forget what was loaded (the next read loads the file again). */
  clear(): void { this.map.clear(); this.loaded = false; this.sig = ""; }
}

function cleanTags(v: unknown): string[] {
  return Array.isArray(v) ? [...new Set(v.map((t) => str(t, 40).trim()).filter(Boolean))].slice(0, 20) : [];
}

export const tsaStore = new TsaStore();

