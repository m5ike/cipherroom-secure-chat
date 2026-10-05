// The shapes a chat message can take, shared by the app, the history store
// and the account vault. Kept out of App.tsx so that storage code can talk
// about messages without importing the whole application.

import type { MsgFlags } from "./message-kinds";

export type AttachmentMeta = {
  kind: "file" | "image";
  name: string;
  mime: string;
  size: number;
  dataUrl: string;
  /** Set when the file was left out of the stored history (too large). */
  dropped?: boolean;
};

/** Where a message stands. The away relay's four only exist for a signed-in
 *  recipient: the server took it (stored — cached on the server, encrypted),
 *  handed it on (forwarded / delivered) or the recipient opened it (read).
 *  6.2 — the vocabulary the Android app shares (message-timeline.ts):
 *  revealed (a hold-to-read message shown), opened (a sealed one opened with
 *  its code), expired (a vanishing one ran out), hidden / unhidden (in this
 *  view only). "discarded" is what 6.1 and older recorded for "expired". */
export type MsgState =
  | "created" | "encrypted" | "sent" | "received" | "decrypted" | "displayed" | "discarded"
  /** Waiting in the local outbox for a recipient to come online (light mode). */
  | "queued"
  | "stored" | "forwarded" | "delivered" | "read"
  | "revealed" | "opened" | "expired" | "hidden" | "unhidden";

export type MessageAudit = { state: MsgState; at: number; meta?: string };

export type ChatMessage = {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  createdAt: number;
  mine: boolean;
  secure: boolean;
  attachment?: AttachmentMeta;
  expiresAt?: number;
  // Optional message kinds (see lib/message-kinds.ts).
  flags?: MsgFlags;
  /** Recipient names when the message was sent privately (not to everyone). */
  to?: string[];
  /** 6.1: the sender's position when writing it (a pin in the bubble). */
  loc?: { lat: number; lon: number; acc?: number; at?: number };
  /** Sender-only: original text + code for a sealed message, kept locally. */
  sealPlain?: string;
  sealCode?: string;
  /** "Mizející" message that has fully elapsed. */
  vanished?: boolean;
  vanishedAt?: number;
  /** Lifecycle audit trail (created → encrypted → sent → received → …). */
  audit?: MessageAudit[];
  /** The on-wire ciphertext, for the message-info view. */
  cipher?: string;
  /** Quoted message this one replies to (original text capped to 200 chars). */
  replyTo?: { id: string; senderName: string; text: string };
  /** Original author when this message was forwarded. */
  forwardedFrom?: string;
  /** Crypto version the message arrived in (envelope.ts); 4 = protocol 4 (6.12). */
  cryptoVersion?: 1 | 2 | 3 | 4;
  /** Which key sealed it: a sender key (forward secret), a pair key
   *  (private), or the room key (sender-keys.ts). 6.12, protocol 4
   *  (docs/protocol-v4.md): "p4-sk" a sender-key chain handed out over the pair
   *  ratchet, "p4-pair" the pair ratchet itself (private), "p4-mailbox" sealed
   *  for the recipient device's mailbox (relayed while away). */
  sealedWith?: SealedWith;
  /** 6.12: my message — every way it went out was sealed (the info view lists them). */
  sealedHow?: SealedWith[];
  /** Who signed it, and how that compares with what we saw before. */
  identity?: MessageIdentity;
  /** 6.2: hidden in this view since `at` until `until` (ms; 0 = until the
   *  next sign-in — for a guest, the next page load). message-hide.ts. */
  hidden?: { at: number; until: number };
  /** 6.2: deleted from this view — what is left is a tombstone without any
   *  content, kept so the message does not come back from a store or relay. */
  deletedAt?: number;
  /** 6.10: "note" — a note to myself, put into this room's history by this app
   *  (the NFC workbench's "To myself"; Android has the same kind): mine, shown
   *  only here and NEVER sent — no payload, no envelope, no recipient. Kept
   *  (and stored) with the room's history like any other message. A peer
   *  cannot make one: a received payload whose kind is not "text" is dropped
   *  (validate.ts), and a message is built from a payload field by field. */
  kind?: "note";
};

export type SealedWith = "sender-key" | "pair" | "room" | "p4-sk" | "p4-pair" | "p4-mailbox";

/** 6.12 (docs/protocol-v4.md § 12.1): new: the key is not verified (first seen
 *  with `firstSeen`, else seen before and never compared) · verified: the user
 *  compared the safety number / scanned the QR code (`checked`) · changed:
 *  another key than pinned for this name, or a revoked device — held behind a
 *  warning until accepted (`accepted`) · invalid: signature or certificate
 *  fails · unsigned: an older client. `account`: certified by an account key
 *  (the state is the account's); `protocol: 3` an older peer; `certV1` a
 *  certificate without expiry. History stored before 6.12 may say "verified"
 *  without `checked`: that meant "same key as before", and is shown so. */
export type MessageIdentity = {
  state: "new" | "verified" | "changed" | "invalid" | "unsigned";
  kid?: string; fingerprint?: string; account?: boolean; checked?: boolean;
  firstSeen?: boolean; protocol?: 3 | 4; certV1?: boolean; revoked?: boolean; accepted?: boolean;
  /** 6.12 review P04: the server's key log has not confirmed the sender's account — "pending" (not checked yet),
   *  "absent" (not in the log), "unverified" (the lookup did not verify). Then `account` is false and the state
   *  is never "verified"; `ktState` is the state it gets once confirmed, `ktSlot` names the check. */
  kt?: "pending" | "absent" | "unverified"; ktState?: "verified" | "new"; ktSlot?: string;
  /** 6.12 review P08: the account was verified under this other name — it now writes under another one. */
  verifiedAs?: string;
};
