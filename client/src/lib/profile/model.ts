// The user's profile (6.7) — a photo, a background, a public nickname, an
// about text and optional fields (names, numbers, e-mails, addresses, links,
// organisation, birthday…), each with its own audience:
//
//   me      only me — kept in the account's sealed vault (slot "card") for my
//           own devices; it never leaves them in readable form
//   room    room members — sent end-to-end encrypted inside the rooms I join
//           (a "profile" frame); the server relays ciphertext only
//   public  stored on the server (/api/profile) and readable by anyone who
//           looks me up by username — the server sees it
//
// The audiences nest: what is public is shown to room members too. Every new
// field starts as "only me"; the public nickname is public once the user
// types one and saves (that is the opt-in). One module for every side: the
// web client builds the views, the server and the receivers run the same
// normalizers over what they are handed (untrusted), the Android app mirrors
// it (ProfileCard.java).

export type Audience = "me" | "room" | "public";
export const AUDIENCES: readonly Audience[] = ["me", "room", "public"];

export const FIELD_TYPES = ["name", "phone", "email", "address", "url", "social", "org", "birthday", "other"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** One value with its audience (nickname, about, the two images). */
export type ProfileItem = { value: string; audience: Audience };

export type ProfileField = { id: string; type: FieldType; label: string; value: string; audience: Audience };

/** The whole profile as its owner keeps it (vault slot "card"). */
export type ProfileCard = {
  v: 1;
  nickname: ProfileItem;
  about: ProfileItem;
  /** data:image/jpeg;base64,… (profile-image.ts made it), or "". */
  avatar: ProfileItem;
  cover: ProfileItem;
  fields: ProfileField[];
  updatedAt: number;
  /** The public view is on the server (so an empty one is deleted there). */
  published?: boolean;
};

/** What one audience gets: only the items it may see, no audiences. */
export type SharedProfile = {
  v: 1;
  nickname?: string;
  about?: string;
  avatar?: string;
  cover?: string;
  fields: Array<{ type: FieldType; label: string; value: string }>;
  /** Changes whenever the content does (cache key). */
  rev: string;
  updatedAt: number;
};

export const PROFILE_LIMITS = {
  nicknameChars: 40,
  aboutChars: 600,
  labelChars: 32,
  valueChars: 200,
  addressChars: 300,
  fields: 24,
  /** Decoded bytes of the re-encoded images — both together keep a room's
   *  profile frame under a data channel message (256 KiB, sealed). */
  avatarBytes: 40 * 1024,
  coverBytes: 72 * 1024,
  avatarPx: 256,
  coverW: 1200,
  coverH: 400,
} as const;

/** Upper bound of a SharedProfile's JSON (images base64-encoded): the server's and a frame's cap. */
export const SHARED_PROFILE_MAX_CHARS = Math.ceil(((PROFILE_LIMITS.avatarBytes + PROFILE_LIMITS.coverBytes) * 4) / 3) + 40_000;

const IMAGE_RE = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

export function isAudience(v: unknown): v is Audience {
  return v === "me" || v === "room" || v === "public";
}

/** Who may see an item marked `item` when the viewer is `viewer`. */
export function visibleTo(item: Audience, viewer: Audience): boolean {
  if (viewer === "me") return true;
  if (viewer === "room") return item === "room" || item === "public";
  return item === "public";
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g;

/** One line: no control or bidi-override characters, single spaces, capped. */
export function cleanLine(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return Array.from(v.replace(CONTROL, "").replace(/[\t\n\r]+/g, " ").replace(/\s{2,}/g, " ").trim()).slice(0, max).join("");
}

/** Several lines (about, address): at most 3 newlines in a row, capped. */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return Array.from(v.replace(/\r\n?/g, "\n").replace(CONTROL, "").replace(/\t/g, " ").replace(/\n{3,}/g, "\n\n").trim()).slice(0, max).join("");
}

/** Decoded size of a base64 payload. */
export function base64Bytes(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/** A data: URL of a JPEG, PNG or WebP no larger than `maxBytes`, else "". */
export function cleanImage(v: unknown, maxBytes: number): string {
  if (typeof v !== "string" || v.length > Math.ceil((maxBytes * 4) / 3) + 40) return "";
  const m = IMAGE_RE.exec(v);
  if (!m) return "";
  return base64Bytes(m[2]) <= maxBytes ? v : "";
}

/** Checks a field's value by its type; "" when it is not one. */
export function cleanValue(type: FieldType, v: unknown): string {
  if (type === "address" || type === "other") return cleanText(v, PROFILE_LIMITS.addressChars);
  const s = cleanLine(v, PROFILE_LIMITS.valueChars);
  if (!s) return "";
  switch (type) {
    case "phone":
      return /^\+?[0-9][0-9 ()./-]{2,30}$/.test(s) ? s : "";
    case "email":
      return /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[^\s@<>".]{2,63}$/.test(s) ? s : "";
    case "url":
      // Shown as a link the viewer may open — never fetched by the app.
      return /^https?:\/\/[^\s<>"]{3,190}$/i.test(s) ? s : "";
    case "birthday":
      return /^(\d{4}-\d{2}-\d{2}|--\d{2}-\d{2}|\d{1,2}\.\s?\d{1,2}\.(\s?\d{4})?)$/.test(s) ? s : "";
    default:
      return s;
  }
}

const FIELD_ID = /^[A-Za-z0-9_-]{1,24}$/;

export function newFieldId(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** An empty profile: everything only for me; the nickname is meant to be public (typing one is the opt-in). */
export function emptyCard(now = 0): ProfileCard {
  return {
    v: 1,
    nickname: { value: "", audience: "public" },
    about: { value: "", audience: "me" },
    avatar: { value: "", audience: "me" },
    cover: { value: "", audience: "me" },
    fields: [],
    updatedAt: now,
  };
}

function item(v: unknown, clean: (x: unknown) => string, fallback: Audience): ProfileItem {
  const o = (v && typeof v === "object" ? v : {}) as { value?: unknown; audience?: unknown };
  return { value: clean(o.value), audience: isAudience(o.audience) ? o.audience : fallback };
}

/** A card from anywhere (the vault, an older version, the editor): every value checked, unknown audiences are "me". */
export function normalizeCard(input: unknown): ProfileCard {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const fields: ProfileField[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(o.fields) ? o.fields : []) {
    if (fields.length >= PROFILE_LIMITS.fields) break;
    const f = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const type: FieldType = (FIELD_TYPES as readonly string[]).includes(f.type as string) ? (f.type as FieldType) : "other";
    let id = typeof f.id === "string" && FIELD_ID.test(f.id) ? f.id : newFieldId();
    if (seen.has(id)) id = newFieldId();
    seen.add(id);
    fields.push({
      id, type,
      label: cleanLine(f.label, PROFILE_LIMITS.labelChars),
      // The editor keeps what is being typed; views drop what does not check out.
      value: type === "address" || type === "other" ? cleanText(f.value, PROFILE_LIMITS.addressChars) : cleanLine(f.value, PROFILE_LIMITS.valueChars),
      audience: isAudience(f.audience) ? f.audience : "me",
    });
  }
  return {
    v: 1,
    nickname: item(o.nickname, (x) => cleanLine(x, PROFILE_LIMITS.nicknameChars), "public"),
    about: item(o.about, (x) => cleanText(x, PROFILE_LIMITS.aboutChars), "me"),
    avatar: item(o.avatar, (x) => cleanImage(x, PROFILE_LIMITS.avatarBytes), "me"),
    cover: item(o.cover, (x) => cleanImage(x, PROFILE_LIMITS.coverBytes), "me"),
    fields,
    updatedAt: Number.isFinite(Number(o.updatedAt)) ? Math.max(0, Math.floor(Number(o.updatedAt))) : 0,
    ...(o.published === true ? { published: true } : {}),
  };
}

/** A short content hash (two FNV-1a passes): the cache key of a view. Not a security property. */
export function profileRev(content: string): string {
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193) >>> 0;
    b = (b ^ (b >>> 13)) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

function withRev(view: Omit<SharedProfile, "rev">): SharedProfile {
  const { updatedAt: _u, ...content } = view;
  return { ...view, rev: profileRev(JSON.stringify(content)) };
}

/**
 * What `viewer` sees of the card: room members get "room" and "public"
 * items, the public only "public" ones, "me" (the preview) everything. A
 * field whose value does not check out for its type is left out.
 */
export function viewFor(card: ProfileCard, viewer: Audience): SharedProfile {
  const show = (it: ProfileItem) => (it.value && visibleTo(it.audience, viewer) ? it.value : undefined);
  const fields = card.fields
    .filter((f) => visibleTo(f.audience, viewer))
    .map((f) => ({ type: f.type, label: f.label, value: cleanValue(f.type, f.value) }))
    .filter((f) => f.value);
  const view: Omit<SharedProfile, "rev"> = { v: 1, fields, updatedAt: card.updatedAt };
  const nickname = show(card.nickname);
  const about = show(card.about);
  const avatar = show(card.avatar);
  const cover = show(card.cover);
  if (nickname) view.nickname = nickname;
  if (about) view.about = about;
  if (avatar) view.avatar = avatar;
  if (cover) view.cover = cover;
  return withRev(view);
}

/** Nothing in it to show. */
export function isEmptyView(view: SharedProfile | null | undefined): boolean {
  return !view || (!view.nickname && !view.about && !view.avatar && !view.cover && view.fields.length === 0);
}

/**
 * A view handed to us (a room member's frame, the server's answer, a PUT
 * body): rebuilt from checked values only, its rev recomputed — what is not
 * valid is dropped, never shown. Null when it is not a profile at all.
 */
export function normalizeShared(input: unknown): SharedProfile | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  if (o.v !== 1) return null;
  if (JSON.stringify(input).length > SHARED_PROFILE_MAX_CHARS) return null;
  const fields: SharedProfile["fields"] = [];
  for (const raw of Array.isArray(o.fields) ? o.fields : []) {
    if (fields.length >= PROFILE_LIMITS.fields) break;
    const f = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const type: FieldType = (FIELD_TYPES as readonly string[]).includes(f.type as string) ? (f.type as FieldType) : "other";
    const value = cleanValue(type, f.value);
    if (value) fields.push({ type, label: cleanLine(f.label, PROFILE_LIMITS.labelChars), value });
  }
  const view: Omit<SharedProfile, "rev"> = { v: 1, fields, updatedAt: Number.isFinite(Number(o.updatedAt)) ? Math.max(0, Math.floor(Number(o.updatedAt))) : 0 };
  const nickname = cleanLine(o.nickname, PROFILE_LIMITS.nicknameChars);
  const about = cleanText(o.about, PROFILE_LIMITS.aboutChars);
  const avatar = cleanImage(o.avatar, PROFILE_LIMITS.avatarBytes);
  const cover = cleanImage(o.cover, PROFILE_LIMITS.coverBytes);
  if (nickname) view.nickname = nickname;
  if (about) view.about = about;
  if (avatar) view.avatar = avatar;
  if (cover) view.cover = cover;
  return withRev(view);
}

/**
 * The nickname a room's name field starts with (6.7): the public nickname
 * when one is set, else what the field had. The user can still change it
 * for the room; one already typed for this room wins.
 */
export function prefillNickname(card: ProfileCard | null | undefined, current: string, typedForRoom = false): string {
  if (typedForRoom && current.trim()) return current;
  const nick = card?.nickname.value.trim() ?? "";
  return nick || current;
}

/** Where a field's value leads when the viewer opens it (only these schemes). */
export function fieldHref(type: FieldType, value: string): string | null {
  if (type === "email" && cleanValue("email", value)) return `mailto:${value}`;
  if (type === "phone" && cleanValue("phone", value)) return `tel:${value.replace(/[^\d+]/g, "")}`;
  if ((type === "url" || type === "social") && /^https?:\/\/[^\s<>"]+$/i.test(value)) return value;
  return null;
}
