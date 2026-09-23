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

/** Where a message stands. The last four only exist for a signed-in user:
 *  the server took it (stored), handed it on (forwarded / delivered) or the
 *  recipient opened it (read). */
export type MsgState =
  | "created" | "encrypted" | "sent" | "received" | "decrypted" | "displayed" | "discarded"
  /** Waiting in the local outbox for a recipient to come online (light mode). */
  | "queued"
  | "stored" | "forwarded" | "delivered" | "read";

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
  /** Crypto version the message arrived in (envelope.ts). */
  cryptoVersion?: 1 | 2;
  /** Who signed it, and how that compares with what we saw before. */
  identity?: MessageIdentity;
};

/** verified: signed, key as pinned (or first seen) · changed: signed, but
 *  another key than before for this name · invalid: signature fails ·
 *  unsigned: an older client, no signature at all. */
export type MessageIdentity = { state: "verified" | "changed" | "invalid" | "unsigned"; kid?: string; fingerprint?: string; account?: boolean };
