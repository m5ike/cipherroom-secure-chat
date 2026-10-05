// Key transparency in the web client (docs/protocol-v4.md § 14, F-13).
//
// Per server origin: the server's KT key is pinned on first use
// (GET /api/kt/key); its newest signed tree head is fetched on connect and
// every 10 minutes and must extend the one kept (KtState.update, with the
// server's consistency proofs); a peer's head from its hello is compared
// with ours (gossip) — a fork either way is a persistent alert the security
// panel shows until the user dismisses it. A consistency proof the server
// refuses (or never gives) between two heads it signed is owed: refused
// twice, or missing for a day, it is the same kind of alert — "the server
// does not prove its key log" (6.12 review P05).
//
// An account-attested peer is looked up (the hub's `kt-lookup`) when first
// pinned: its account key and device must be in the log, and not revoked —
// until that check succeeds the peer is NOT shown as account-certified or
// verified (review P04; `KtVerdict`). The signed-in user's OWN entries are
// looked up too (`checkOwn`, every refresh): a device the server certified
// for this account that the user does not know is reported, so a key the
// server adds for a user cannot go unseen by its owner.
//
// A server without key transparency (no server-side storage) answers 503:
// then nothing is pinned, hellos carry no tree head, and nothing is checked —
// the panel says so.

import { KtState, deviceStatus, ktUser, type KtAlert, type KtConsistency, type KtEntry, type KtLookup, type KtStore, type SignedTreeHead } from "./p4";

export const KT_REFRESH_MS = 10 * 60 * 1000;

export type KtStatus = { state: "off" | "ok" | "alert" | "unknown"; size?: number; alert?: KtAlert | null };

/** GET a KT path; `auth`: an account session token (the own-entries lookup needs one, § 14.3). */
export type KtFetch = (path: string, auth?: string) => Promise<unknown>;

/** An HTTP answer of the KT API that is not 2xx. `transient`: 429 / 502 / 503 / 504 (busy, not a refusal). */
export class KtHttpError extends Error {
  readonly transient: boolean;
  constructor(readonly status: number) {
    super(`kt ${status}`);
    this.name = "KtHttpError";
    this.transient = status === 429 || status === 502 || status === 503 || status === 504;
  }
}

/** The server's JSON; throws a KtHttpError for an HTTP error, the fetch's TypeError for a network failure. */
export const fetchKtJson = (base = ""): KtFetch => async (path, auth) => {
  const res = await fetch(`${base}${path}`, { cache: "no-store", ...(auth ? { headers: { Authorization: `Bearer ${auth}` } } : {}) });
  if (!res.ok) throw new KtHttpError(res.status);
  return res.json();
};

/**
 * What the key log says about an attested device (§ 14.4):
 *   ok          the account key is the user's current one, the device certified, not revoked;
 *   revoked     a `rev` entry after its certification;
 *   absent      the account key or the device is not in the log;
 *   unverified  the lookup did not verify (no answer, a head the server does not prove, …);
 *   off         this server keeps no log (nothing to check).
 * `userMismatch`: the username the peer claims is not the one the log has for
 * its account — the claim must not be shown (review P04).
 */
export type KtVerdict = { status: "ok" | "revoked" | "absent" | "unverified" | "off"; userMismatch?: boolean };

/** The user's own account in the log (review P04, self-monitoring). */
export type KtOwnCheck = {
  status: "ok" | "unverified" | "off";
  /** Devices certified for this account (not expired, not revoked) that this browser does not know. */
  unknown: Array<{ dpk: string; ts: number; exp: number }>;
  /** The log's latest account key for this user when it is not ours. */
  foreignAccount?: string;
};

export class KtClient {
  private readonly state: KtState;
  private sth: SignedTreeHead | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private off = false;
  private readonly listeners = new Set<(s: KtStatus) => void>();
  private status: KtStatus = { state: "unknown" };

  constructor(readonly origin: string, store: KtStore, private readonly get: KtFetch, now: () => number = Date.now) {
    this.state = new KtState(store, now);
    void this.state.newest(origin).then((s) => { this.sth ??= s; });
    void this.state.alert(origin).then((a) => { if (a) this.publish({ state: "alert", alert: a }); });
  }

  /** The newest verified head (what our hellos gossip), or null. */
  newest(): SignedTreeHead | null { return this.sth; }

  current(): KtStatus { return this.status; }

  /** Is this server's log being checked (its key answered)? */
  get running(): boolean { return !this.off && this.status.state !== "unknown"; }

  subscribe(fn: (s: KtStatus) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private publish(s: KtStatus): void {
    this.status = s;
    for (const fn of this.listeners) fn(s);
  }

  private consistency = async (from: number, to: number): Promise<KtConsistency> =>
    (await this.get(`/api/kt/consistency?from=${from}&to=${to}`)) as KtConsistency;

  private async publishAlertOrOk(): Promise<KtStatus> {
    const alert = await this.state.alert(this.origin);
    this.publish(alert ? { state: "alert", alert } : { state: "ok", size: this.sth?.size });
    return this.status;
  }

  /** Pins the key (first use), checks the server's newest head and asks again for every proof it owes. */
  async refresh(): Promise<KtStatus> {
    let key: string;
    try {
      const answer = (await this.get("/api/kt/key")) as { key?: unknown };
      if (typeof answer?.key !== "string") throw new Error("no key");
      key = answer.key;
    } catch {
      this.off = true;
      const alert = await this.state.alert(this.origin);
      this.publish(alert ? { state: "alert", alert } : { state: "off" });
      return this.status;
    }
    this.off = false;
    await this.state.pinKey(this.origin, key).catch(() => "changed");
    try {
      const sth = await this.get("/api/kt/sth");
      const upd = await this.state.update(this.origin, sth, this.consistency);
      if (upd.status === "ok") this.sth = upd.sth.size >= (this.sth?.size ?? -1) ? upd.sth : this.sth;
    } catch { /* no head this time: the next refresh */ }
    // Review P05: a proof the server refused or never gave is asked for again; refused twice or a day late → alert.
    await this.state.retryPending(this.origin, this.consistency).catch(() => null);
    return this.publishAlertOrOk();
  }

  /** Refreshes now and every 10 minutes (and runs `each` after every refresh, e.g. the own-account check). */
  start(each?: () => void): void {
    const run = () => { void this.refresh().then(() => each?.()); };
    run();
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(run, KT_REFRESH_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** § 14.4 gossip: a peer's head from its hello. "unproven": the server owes the proof (alert after refusals / a day). */
  async gossip(peerSth: unknown): Promise<"ok" | "ignored" | "split-view" | "unproven"> {
    if (this.off || !peerSth) return "ignored";
    try {
      const first = await this.state.gossip(this.origin, peerSth);
      let result = first;
      if (first.status === "need-consistency") result = await this.state.resolveGossip(this.origin, peerSth, this.consistency);
      if (result.status === "split-view") { this.publish({ state: "alert", alert: result.alert }); return "split-view"; }
      if (result.status === "unproven") {
        if (result.alert) this.publish({ state: "alert", alert: result.alert });
        return "unproven";
      }
      if (result.status === "ok") {
        const newest = await this.state.newest(this.origin);
        if (newest) this.sth = newest;
        return "ok";
      }
    } catch { /* a store failure: the next hello */ }
    return "ignored";
  }

  /** Verified entries of a lookup (its head proven consistent with ours), or why not. */
  private async verifiedEntries(lookup: KtLookup, u: string | undefined): Promise<{ ok: true; entries: Array<{ entry: KtEntry; index: number }> } | { ok: false; why: string }> {
    const checked = await this.state.lookup(this.origin, lookup, u, this.consistency).catch(() => ({ ok: false as const, why: "error" }));
    if (!checked.ok) {
      const alert = await this.state.alert(this.origin);
      if (alert) this.publish({ state: "alert", alert });
    }
    return checked;
  }

  /**
   * § 14.4: is this account's device in the log (account key current, device
   * certified, not revoked)? `lookup` is the hub's `kt-lookup` answer; `user`
   * the username the peer claims (checked against the log's `u` when given —
   * a claim the log does not bear out is reported, never shown).
   */
  async checkDevice(lookup: KtLookup | null, apk: string, dpk: string, user?: string): Promise<KtVerdict> {
    if (this.off) return { status: "off" };
    if (!lookup) return { status: "unverified" };
    const u = user ? await ktUser(user) : undefined;
    let userMismatch = false;
    let checked = await this.verifiedEntries(lookup, u);
    // A claimed username the server stores otherwise: the entries still say what they say — the claim goes.
    if (!checked.ok && checked.why === "wrong-user" && u) { userMismatch = true; checked = await this.verifiedEntries(lookup, undefined); }
    if (!checked.ok) return { status: "unverified", ...(userMismatch ? { userMismatch } : {}) };
    const status = deviceStatus(checked.entries, apk, dpk);
    const out = status.revoked ? "revoked" as const : status.ok ? "ok" as const : "absent" as const;
    return { status: out, ...(userMismatch ? { userMismatch } : {}) };
  }

  /**
   * Review P04 (§ 14.4, self-monitoring): the signed-in user's OWN entries
   * (`GET /api/kt/lookup` with the account session — the server answers only
   * the caller's own `u`, § 14.3). The entries must be those of `u` =
   * ktUser(username) (else "unverified"). Every device the log certifies for
   * our account key that `known(dpk)` does not know is returned; a newer
   * account key than ours is `foreignAccount`.
   */
  async checkOwn(who: { username: string; u?: string; token?: string }, apk: string, known: (dpk: string) => boolean, now = Date.now()): Promise<KtOwnCheck> {
    if (this.off) return { status: "off", unknown: [] };
    // `u` as the server reports it for this account when it does, else § 14.1.
    const u = who.u ?? await ktUser(who.username);
    let lookup: KtLookup;
    try {
      lookup = (await this.get(`/api/kt/lookup?u=${encodeURIComponent(u)}`, who.token)) as KtLookup;
    } catch {
      return { status: "unverified", unknown: [] };
    }
    const checked = await this.verifiedEntries(lookup, u);
    if (!checked.ok) return { status: "unverified", unknown: [] };
    const sorted = [...checked.entries].sort((a, b) => a.index - b.index);
    const accts = sorted.filter((e) => e.entry.t === "acct");
    const latest = accts[accts.length - 1]?.entry.apk;
    const unknown: KtOwnCheck["unknown"] = [];
    const seen = new Set<string>();
    for (const e of sorted) {
      if (e.entry.t !== "dev" || e.entry.apk !== apk || seen.has(e.entry.dpk)) continue;
      const dpk = e.entry.dpk;
      seen.add(dpk);
      const st = deviceStatus(checked.entries, apk, dpk, now);
      if (!st.device || st.revoked || known(dpk)) continue;
      const last = sorted.filter((x) => x.entry.t === "dev" && x.entry.dpk === dpk && x.entry.apk === apk).pop()!.entry as Extract<KtEntry, { t: "dev" }>;
      unknown.push({ dpk, ts: last.ts, exp: last.exp });
    }
    return { status: "ok", unknown, ...(latest && latest !== apk ? { foreignAccount: latest } : {}) };
  }

  async dismiss(): Promise<void> {
    await this.state.dismissAlert(this.origin);
    this.publish(this.off ? { state: "off" } : { state: "ok", size: this.sth?.size });
  }
}
