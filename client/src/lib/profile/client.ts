// The signed-in user's profile card, client side (6.7).
//
// The whole card — every item with its audience — is sealed with the vault
// key and kept in the account vault's own slot ("card"), so nothing marked
// "only me" ever leaves this device readable, and the app's preference
// autosave never overwrites it. Saving also brings the server's public copy
// in line: the "public" view is PUT to /api/profile, or withdrawn (DELETE)
// when nothing is public any more. What room members see is not sent from
// here — App.tsx hands the "room" view to each member, end-to-end encrypted.

import { accountToken, vaultKey } from "../account";
import { openSlot, sealProfile } from "../passkey";
import { emptyCard, isEmptyView, normalizeCard, normalizeShared, viewFor, type ProfileCard, type SharedProfile } from "./model";

let card: ProfileCard | null = null;
const listeners = new Set<(card: ProfileCard | null) => void>();

function set(next: ProfileCard | null): void {
  card = next;
  for (const fn of listeners) fn(card);
}

/** The card of the signed-in user (null: signed out, or not loaded yet). */
export function currentCard(): ProfileCard | null {
  return card;
}

export function onCardChange(fn: (card: ProfileCard | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function call<T>(path: string, init: RequestInit = {}, token = accountToken()): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* an HTML error page */ }
  if (!res.ok) throw Object.assign(new Error(typeof json.message === "string" ? json.message : `Server error ${res.status}.`), { status: res.status, code: typeof json.code === "string" ? json.code : "" });
  return json as T;
}

/** Opens the card from the vault (an empty one when there is none yet). */
export async function loadCard(): Promise<ProfileCard | null> {
  const key = vaultKey();
  if (!key || !accountToken()) { set(null); return null; }
  const raw = await call<{ card?: { ct: string } | null }>("/api/account/vault?only=card");
  // 6.12 (F-26): a card in vault-slot format 2 opens too (the web writes 1 below until Android reads 2).
  const opened = raw.card?.ct ? normalizeCard((await openSlot<unknown>(raw.card.ct, key, "card")).value) : emptyCard();
  set(opened);
  return opened;
}

/** Signed out: the card is gone from memory (it stays sealed in the vault). */
export function clearCard(): void {
  set(null);
}

export type SaveOutcome = { card: ProfileCard; public: "published" | "withdrawn" | "none"; publicError?: string };

/**
 * Saves the card: the public view to the server first (published, or
 * withdrawn when nothing is public), then the whole card sealed into the
 * vault — with `published` telling the next save whether there is
 * something to withdraw. A failed public step still saves the card.
 */
export async function saveCard(input: ProfileCard, now = Date.now()): Promise<SaveOutcome> {
  const key = vaultKey();
  if (!key || !accountToken()) throw new Error("Not signed in.");
  const next = normalizeCard({ ...input, updatedAt: now });
  const view = viewFor(next, "public");
  let outcome: SaveOutcome["public"] = "none";
  let publicError: string | undefined;
  try {
    if (!isEmptyView(view)) {
      const { rev: _r, ...body } = view;
      await call("/api/profile", { method: "PUT", body: JSON.stringify({ profile: body }) });
      next.published = true;
      outcome = "published";
    } else if (next.published) {
      await call("/api/profile", { method: "DELETE" });
      delete next.published;
      outcome = "withdrawn";
    }
  } catch (err) {
    publicError = (err as Error).message;
  }
  // Still vault-slot format 1 (no AAD): the Android app of 6.11 opens the card too
  // (Account.loadCard). Switch to sealSlot(next, key, "card") once Android reads format 2.
  const sealed = await sealProfile(next, key);
  await call("/api/account/vault", { method: "PUT", body: JSON.stringify({ card: sealed }) });
  set(next);
  return { card: next, public: outcome, ...(publicError ? { publicError } : {}) };
}

/** What room members may see of my card (null: nothing). */
export function myRoomView(c: ProfileCard | null = card): SharedProfile | null {
  if (!c) return null;
  const view = viewFor(c, "room");
  return isEmptyView(view) ? null : view;
}

export type PublicLookup = { username: string; profile: SharedProfile; accountKey?: string; updatedAt: number };

/**
 * Someone's public profile by username — only when the viewer asks (it tells
 * the server whose profile is looked at). Null when there is none.
 */
export async function fetchPublicProfile(username: string): Promise<PublicLookup | null> {
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(username)) return null;
  try {
    const r = await call<{ username?: unknown; profile?: unknown; accountKey?: unknown; updatedAt?: unknown }>(`/api/profile/${encodeURIComponent(username)}`, {}, null);
    const profile = normalizeShared(r.profile);
    if (!profile) return null;
    return {
      username: typeof r.username === "string" ? r.username : username,
      profile,
      ...(typeof r.accountKey === "string" && /^[A-Za-z0-9+/=_-]{40,64}$/.test(r.accountKey) ? { accountKey: r.accountKey } : {}),
      updatedAt: Number(r.updatedAt) || 0,
    };
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}

/** Test seam. */
export function _setCardForTests(next: ProfileCard | null): void {
  set(next);
}
