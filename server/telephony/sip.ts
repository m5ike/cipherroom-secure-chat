// Legacy SIP trunk registry (config only) — now PERSISTENT.
//
// HONEST SCOPE: a browser cannot speak SIP/RTP directly, so this module does
// NOT carry any media. Real audio for a SIP trunk requires an external
// SIP<->WebRTC gateway (e.g. Asterisk/FreeSWITCH/Janus/Kamailio) sitting
// between the PSTN trunk and the WebRTC leg. What this store manages is:
//   * trunk configuration (host, credentials, DIDs, caller-id),
//   * the *intent* to dial outbound over a chosen trunk, and
//   * inbound DID -> trunk routing decisions.
// It never opens a socket and never RETURNS the SIP password.
//
// Two sources of trunks:
//   env   SIP_TRUNKS='[{"id":"prague1","label":"Prague","host":"sip.example.com",
//         "username":"u","password":"p","didNumbers":["+420123"],
//         "callerIdName":"M5cet","callerIdNumber":"+420123"}]'
//         Seeded at boot, READ-ONLY from the admin console (edit .env instead).
//   file  trunks created in the admin console, saved to the telephony data
//         file (see store.ts) so they survive a restart; the app process
//         reloads the file when its mtime changes.

import { randomUUID } from "node:crypto";
import { dataFileMtime, loadTelephonyFile, saveTelephonyFile, type PersistedTrunk } from "./store";

export const SIP_LIMITS = {
  maxTrunks: 100,
  maxDidsPerTrunk: 200,
  maxStringChars: 200,
  maxDidChars: 32,
} as const;

export type TrunkSource = "env" | "file";

/** Operator-supplied trunk config. `password` is stored but never returned. */
export type SipTrunkInput = {
  /** Optional caller-chosen id (a-z0-9_-); a random one is minted otherwise. */
  id?: string;
  label: string;
  host: string;
  port?: number;
  username: string;
  authUser?: string;
  password?: string;
  register?: boolean;
  didNumbers?: string[];
  callerIdName?: string;
  callerIdNumber?: string;
};

/** Redacted trunk as returned by list()/get(): no password, just a flag. */
export type SipTrunk = {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  authUser: string;
  register: boolean;
  didNumbers: string[];
  callerIdName: string;
  callerIdNumber: string;
  hasPassword: boolean;
  updatedAt: number;
  source: TrunkSource;
};

type StoredTrunk = SipTrunk & { password: string };

export type SipRouteDecision = { trunkId: string; label: string; did: string; source: TrunkSource };
export type SipResult = { ok: true; trunk: SipTrunk } | { ok: false; message: string };

const HOST_RE = /^[a-zA-Z0-9.:_-]{1,255}$/;
const ID_RE = /^[a-z0-9_-]{1,64}$/i;

function clean(v: unknown, max: number = SIP_LIMITS.maxStringChars): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export class SipTrunkStore {
  private map = new Map<string, StoredTrunk>();
  private persist = false;
  private loadedMtime = 0;
  private lastSaveError = "";

  private normPort(p: unknown): number | null {
    if (p === undefined || p === null || p === "") return 5060;
    const n = typeof p === "number" ? p : parseInt(String(p), 10);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
    return n;
  }

  private normDids(list: unknown): string[] | null {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) return null;
    const out: string[] = [];
    for (const d of list) {
      const v = clean(d, SIP_LIMITS.maxDidChars);
      if (v) out.push(v);
      if (out.length > SIP_LIMITS.maxDidsPerTrunk) return null;
    }
    return out;
  }

  /** Build the redacted view explicitly so a password can never slip out. */
  private redact(t: StoredTrunk): SipTrunk {
    return {
      id: t.id,
      label: t.label,
      host: t.host,
      port: t.port,
      username: t.username,
      authUser: t.authUser,
      register: t.register,
      didNumbers: [...t.didNumbers],
      callerIdName: t.callerIdName,
      callerIdNumber: t.callerIdNumber,
      hasPassword: t.hasPassword,
      updatedAt: t.updatedAt,
      source: t.source,
    };
  }

  /** Validate + normalise an input into a stored record (shared by create and seeding). */
  private build(input: SipTrunkInput, source: TrunkSource, existingId?: string): { ok: true; rec: StoredTrunk } | { ok: false; message: string } {
    const label = clean(input.label);
    const host = clean(input.host);
    const username = clean(input.username);
    if (!label) return { ok: false, message: "label required" };
    if (!HOST_RE.test(host)) return { ok: false, message: "valid host required" };
    if (!username) return { ok: false, message: "username required" };
    const port = this.normPort(input.port);
    if (port === null) return { ok: false, message: "port must be 1-65535" };
    const dids = this.normDids(input.didNumbers);
    if (dids === null) return { ok: false, message: `too many DIDs (max ${SIP_LIMITS.maxDidsPerTrunk})` };
    const password = typeof input.password === "string" ? input.password : "";
    const wantId = existingId ?? (typeof input.id === "string" ? input.id.trim() : "");
    const id = ID_RE.test(wantId) && (existingId !== undefined || !this.map.has(wantId)) ? wantId : `sip-${randomUUID()}`;
    return {
      ok: true,
      rec: {
        id, label, host, port, username,
        authUser: clean(input.authUser) || username,
        register: input.register === true,
        didNumbers: dids,
        callerIdName: clean(input.callerIdName),
        callerIdNumber: clean(input.callerIdNumber),
        hasPassword: password.length > 0,
        updatedAt: Date.now(),
        source,
        password,
      },
    };
  }

  // ---------------------------------------------------------- persistence

  /** Turn on file persistence: load what is on disk now, save after each change. */
  enablePersistence(): void {
    this.persist = true;
    this.reload();
  }

  /** Replace all file-sourced trunks with the file contents (env trunks stay). */
  private reload(): void {
    const { data, mtimeMs } = loadTelephonyFile();
    for (const [id, t] of this.map) if (t.source === "file") this.map.delete(id);
    for (const p of data.trunks) {
      if (this.map.has(p.id)) continue; // an env trunk with the same id wins
      const r = this.build({ ...p }, "file", p.id);
      if (r.ok) { r.rec.updatedAt = typeof p.updatedAt === "number" ? p.updatedAt : r.rec.updatedAt; this.map.set(r.rec.id, r.rec); }
    }
    this.loadedMtime = mtimeMs;
  }

  /** Cheap mtime check so the app process sees admin edits without a restart. */
  reloadIfChanged(): void {
    if (!this.persist) return;
    if (dataFileMtime() !== this.loadedMtime) this.reload();
  }

  private save(): void {
    if (!this.persist) return;
    // Read-modify-write: keep the settings section another writer may own.
    const { data } = loadTelephonyFile();
    const trunks: PersistedTrunk[] = Array.from(this.map.values()).filter((t) => t.source === "file").map((t) => ({
      id: t.id, label: t.label, host: t.host, port: t.port, username: t.username, authUser: t.authUser,
      password: t.password, register: t.register, didNumbers: [...t.didNumbers],
      callerIdName: t.callerIdName, callerIdNumber: t.callerIdNumber, updatedAt: t.updatedAt,
    }));
    const r = saveTelephonyFile({ ...data, trunks });
    this.lastSaveError = r.ok ? "" : r.message;
    if (r.ok) this.loadedMtime = dataFileMtime();
  }

  /** Last persistence failure (e.g. read-only container without a volume), or "". */
  get saveError(): string { return this.lastSaveError; }
  get persistent(): boolean { return this.persist; }

  /** Seed read-only trunks from SIP_TRUNKS (JSON array). Returns how many loaded + errors. */
  seedFromEnv(json: string | undefined = process.env.SIP_TRUNKS): { loaded: number; errors: string[] } {
    const errors: string[] = [];
    if (!json || !json.trim()) return { loaded: 0, errors };
    let arr: unknown;
    try { arr = JSON.parse(json); } catch (err) { return { loaded: 0, errors: [`SIP_TRUNKS is not valid JSON: ${(err as Error).message}`] }; }
    if (!Array.isArray(arr)) return { loaded: 0, errors: ["SIP_TRUNKS must be a JSON array"] };
    let loaded = 0;
    for (const [i, item] of arr.entries()) {
      const r = this.build((item ?? {}) as SipTrunkInput, "env");
      if (!r.ok) { errors.push(`SIP_TRUNKS[${i}]: ${r.message}`); continue; }
      this.map.set(r.rec.id, r.rec);
      loaded += 1;
    }
    return { loaded, errors };
  }

  // ------------------------------------------------------------------ CRUD

  create(input: SipTrunkInput): SipResult {
    this.reloadIfChanged();
    if (this.map.size >= SIP_LIMITS.maxTrunks) return { ok: false, message: "trunk store full" };
    const r = this.build(input, "file");
    if (!r.ok) return r;
    this.map.set(r.rec.id, r.rec);
    this.save();
    return { ok: true, trunk: this.redact(r.rec) };
  }

  update(id: string, patch: Partial<SipTrunkInput>): SipResult {
    this.reloadIfChanged();
    const cur = this.map.get(id);
    if (!cur) return { ok: false, message: "not found" };
    if (cur.source === "env") return { ok: false, message: "trunk is defined in .env (SIP_TRUNKS); edit the env and restart" };
    const next: StoredTrunk = { ...cur, didNumbers: [...cur.didNumbers] };
    if (patch.label !== undefined) { const v = clean(patch.label); if (!v) return { ok: false, message: "label required" }; next.label = v; }
    if (patch.host !== undefined) { const v = clean(patch.host); if (!HOST_RE.test(v)) return { ok: false, message: "valid host required" }; next.host = v; }
    if (patch.username !== undefined) { const v = clean(patch.username); if (!v) return { ok: false, message: "username required" }; next.username = v; }
    if (patch.authUser !== undefined) next.authUser = clean(patch.authUser) || next.username;
    if (patch.port !== undefined) { const p = this.normPort(patch.port); if (p === null) return { ok: false, message: "port must be 1-65535" }; next.port = p; }
    if (patch.register !== undefined) next.register = patch.register === true;
    if (patch.didNumbers !== undefined) { const d = this.normDids(patch.didNumbers); if (d === null) return { ok: false, message: `too many DIDs (max ${SIP_LIMITS.maxDidsPerTrunk})` }; next.didNumbers = d; }
    if (patch.callerIdName !== undefined) next.callerIdName = clean(patch.callerIdName);
    if (patch.callerIdNumber !== undefined) next.callerIdNumber = clean(patch.callerIdNumber);
    // An empty/absent password on update keeps the stored one (the console never echoes it back).
    if (typeof patch.password === "string" && patch.password.length > 0) { next.password = patch.password; next.hasPassword = true; }
    next.updatedAt = Date.now();
    this.map.set(id, next);
    this.save();
    return { ok: true, trunk: this.redact(next) };
  }

  get(id: string): SipTrunk | null {
    this.reloadIfChanged();
    const t = this.map.get(id);
    return t ? this.redact(t) : null;
  }

  list(): SipTrunk[] {
    this.reloadIfChanged();
    return Array.from(this.map.values()).map((t) => this.redact(t));
  }

  remove(id: string): boolean | "readonly" {
    this.reloadIfChanged();
    const cur = this.map.get(id);
    if (!cur) return false;
    if (cur.source === "env") return "readonly";
    this.map.delete(id);
    this.save();
    return true;
  }

  /** Inbound routing: which trunk owns this DID? First match wins. */
  routeInbound(did: string): SipRouteDecision | null {
    this.reloadIfChanged();
    const target = clean(did, SIP_LIMITS.maxDidChars);
    if (!target) return null;
    for (const t of this.map.values()) {
      if (t.didNumbers.includes(target)) return { trunkId: t.id, label: t.label, did: target, source: t.source };
    }
    return null;
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

/** Process-wide store: env trunks seeded first, then the persisted file. */
export const sipStore = new SipTrunkStore();
export const sipEnvSeed = sipStore.seedFromEnv();
sipStore.enablePersistence();
