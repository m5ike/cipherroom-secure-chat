// Legacy SIP trunk registry (config only).
//
// HONEST SCOPE: a browser cannot speak SIP/RTP directly, so this module does
// NOT carry any media. Real audio for a SIP trunk requires an external
// SIP<->WebRTC gateway (e.g. Asterisk/FreeSWITCH/Janus/Kamailio) sitting
// between the PSTN trunk and the WebRTC leg. What this store manages is:
//   * trunk configuration (host, credentials, DIDs, caller-id),
//   * the *intent* to dial outbound over a chosen trunk, and
//   * inbound DID -> trunk routing decisions.
// It never opens a socket and never returns the SIP password.
//
// In-memory only, capped; a real deployment should mount a KV/DB behind it.

import { randomUUID } from "node:crypto";

export const SIP_LIMITS = {
  maxTrunks: 100,
  maxDidsPerTrunk: 200,
  maxStringChars: 200,
  maxDidChars: 32,
} as const;

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
};

type StoredTrunk = SipTrunk & { password: string };

export type SipRouteDecision = { trunkId: string; label: string; did: string };
export type SipResult = { ok: true; trunk: SipTrunk } | { ok: false; message: string };

const HOST_RE = /^[a-zA-Z0-9.:_-]{1,255}$/;

function clean(v: unknown, max: number = SIP_LIMITS.maxStringChars): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export class SipTrunkStore {
  private map = new Map<string, StoredTrunk>();

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
    };
  }

  create(input: SipTrunkInput): SipResult {
    const label = clean(input.label);
    const host = clean(input.host);
    const username = clean(input.username);
    if (!label) return { ok: false, message: "label required" };
    if (!HOST_RE.test(host)) return { ok: false, message: "valid host required" };
    if (!username) return { ok: false, message: "username required" };
    if (this.map.size >= SIP_LIMITS.maxTrunks) return { ok: false, message: "trunk store full" };
    const port = this.normPort(input.port);
    if (port === null) return { ok: false, message: "port must be 1-65535" };
    const dids = this.normDids(input.didNumbers);
    if (dids === null) return { ok: false, message: `too many DIDs (max ${SIP_LIMITS.maxDidsPerTrunk})` };
    const password = typeof input.password === "string" ? input.password : "";
    // Honour a caller-chosen id (slug, not already taken); mint one otherwise.
    const wantId = typeof input.id === "string" ? input.id.trim() : "";
    const id = /^[a-z0-9_-]{1,64}$/i.test(wantId) && !this.map.has(wantId) ? wantId : `sip-${randomUUID()}`;
    const rec: StoredTrunk = {
      id,
      label,
      host,
      port,
      username,
      authUser: clean(input.authUser) || username,
      register: input.register === true,
      didNumbers: dids,
      callerIdName: clean(input.callerIdName),
      callerIdNumber: clean(input.callerIdNumber),
      hasPassword: password.length > 0,
      updatedAt: Date.now(),
      password,
    };
    this.map.set(rec.id, rec);
    return { ok: true, trunk: this.redact(rec) };
  }

  update(id: string, patch: Partial<SipTrunkInput>): SipResult {
    const cur = this.map.get(id);
    if (!cur) return { ok: false, message: "not found" };
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
    if (patch.password !== undefined) { next.password = typeof patch.password === "string" ? patch.password : ""; next.hasPassword = next.password.length > 0; }
    next.updatedAt = Date.now();
    this.map.set(id, next);
    return { ok: true, trunk: this.redact(next) };
  }

  get(id: string): SipTrunk | null {
    const t = this.map.get(id);
    return t ? this.redact(t) : null;
  }

  list(): SipTrunk[] {
    return Array.from(this.map.values()).map((t) => this.redact(t));
  }

  remove(id: string): boolean {
    return this.map.delete(id);
  }

  /** Inbound routing: which trunk owns this DID? First match wins. */
  routeInbound(did: string): SipRouteDecision | null {
    const target = clean(did, SIP_LIMITS.maxDidChars);
    if (!target) return null;
    for (const t of this.map.values()) {
      if (t.didNumbers.includes(target)) return { trunkId: t.id, label: t.label, did: target };
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

export const sipStore = new SipTrunkStore();
