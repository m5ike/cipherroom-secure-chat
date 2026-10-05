// Key transparency in the web client (docs/protocol-v4.md § 14, F-13).
//
// Per server origin: the server's KT key is pinned on first use
// (GET /api/kt/key); its newest signed tree head is fetched on connect and
// every 10 minutes and must extend the one kept (KtState.update, with the
// server's consistency proofs); a peer's head from its hello is compared
// with ours (gossip) — a fork either way is a persistent alert the security
// panel shows until the user dismisses it. An account-attested peer is looked
// up (the hub's `kt-lookup`) when first pinned: its account key and device
// must be in the log, and not revoked.
//
// A server without key transparency (no server-side storage) answers 503:
// then nothing is pinned, hellos carry no tree head, and nothing is checked —
// the panel says so.

import { KtState, deviceStatus, ktUser, type KtAlert, type KtConsistency, type KtLookup, type KtStore, type SignedTreeHead } from "./p4";

export const KT_REFRESH_MS = 10 * 60 * 1000;

export type KtStatus = { state: "off" | "ok" | "alert" | "unknown"; size?: number; alert?: KtAlert | null };

export type KtFetch = (path: string) => Promise<unknown>;

/** The server's JSON, or null for a 503 (KT off) / any failure. */
export const fetchKtJson = (base = ""): KtFetch => async (path) => {
  const res = await fetch(`${base}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`kt ${res.status}`);
  return res.json();
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

  /** Pins the key (first use) and checks the server's newest head. */
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
    } catch { /* the next refresh */ }
    const alert = await this.state.alert(this.origin);
    this.publish(alert ? { state: "alert", alert } : { state: "ok", size: this.sth?.size });
    return this.status;
  }

  /** Refreshes now and every 10 minutes. */
  start(): void {
    void this.refresh();
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => { void this.refresh(); }, KT_REFRESH_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** § 14.4 gossip: a peer's head from its hello. */
  async gossip(peerSth: unknown): Promise<"ok" | "ignored" | "split-view"> {
    if (this.off || !peerSth) return "ignored";
    try {
      const first = await this.state.gossip(this.origin, peerSth);
      let result = first;
      if (first.status === "need-consistency") result = await this.state.resolveGossip(this.origin, peerSth, this.consistency);
      if (result.status === "split-view") { this.publish({ state: "alert", alert: result.alert }); return "split-view"; }
      if (result.status === "ok") {
        const newest = await this.state.newest(this.origin);
        if (newest) this.sth = newest;
        return "ok";
      }
    } catch { /* the server could not prove it: try again with the next hello */ }
    return "ignored";
  }

  /**
   * § 14.4: is this account's device in the log (account key current, device
   * certified, not revoked)? `lookup` is the hub's `kt-lookup` answer; `user`
   * the username the peer claims (checked against the log's `u` when given).
   */
  async checkDevice(lookup: KtLookup | null, apk: string, dpk: string, user?: string): Promise<"ok" | "revoked" | "absent" | "unverified"> {
    if (this.off || !lookup) return "unverified";
    const u = user ? await ktUser(user) : undefined;
    // `u` undefined: the entries are not checked against a user (the hub answered for the member's reference).
    const run = (user?: string) => this.state.lookup(this.origin, lookup, user, this.consistency).catch(() => ({ ok: false as const, why: "error" }));
    let checked = await run(u);
    // A claimed username the server stores otherwise: the entries still say what they say.
    if (!checked.ok && checked.why === "wrong-user" && u) checked = await run(undefined);
    if (!checked.ok) {
      const alert = await this.state.alert(this.origin);
      if (alert) this.publish({ state: "alert", alert });
      return "unverified";
    }
    const status = deviceStatus(checked.entries, apk, dpk);
    if (status.revoked) return "revoked";
    return status.ok ? "ok" : "absent";
  }

  async dismiss(): Promise<void> {
    await this.state.dismissAlert(this.origin);
    this.publish(this.off ? { state: "off" } : { state: "ok", size: this.sth?.size });
  }
}
