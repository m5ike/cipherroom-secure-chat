// Who may continue a processing session (6.7, audit V2).
//
// A model's message carries its session id (`chain`) to everyone who sees it:
// a click, a form or a reply from the app continues that session through
// POST /api/functions/event. The id is 96 random bits, but it travels inside
// room messages, and any room member can put any id into a message of their
// own. Before 6.7 the server only checked that the model was open to the
// caller and that the session belonged to the model — so a member could
// forge a message around a session opened elsewhere (their own caller-only
// run, another room's) and every viewer's click, or their browser code,
// drove it under the viewer's account.
//
// Now the session remembers who opened it and, for a model that posts to the
// room, the (blind) room it was run in — the room its outputs went to. An
// event is accepted from
//   · the opener (the same account; for a guest, the same client id), or
//   · a member of that room (the caller names the same blind room id — only
//     the room's members know it), when the model posts to the room.
// Everything else is refused as if the session were over.

import type { Caller, Chain, ChainOpener, Model } from "./types";

/** What a new session records about its first call. */
export function openerOf(model: Pick<Model, "executors">, caller: Caller, executor: string): ChainOpener {
  const shared = executor === "chat" && model.executors.chat?.visibility === "room" && Boolean(caller.room);
  return {
    kind: caller.kind,
    account: caller.account || "",
    client: caller.client || null,
    executor,
    // Only a room run records its room: a caller-only answer never reached the room.
    room: shared ? caller.room : null,
  };
}

/** Is this the session's opener? An account matches by account; a guest by its client id. */
function sameCaller(o: ChainOpener, caller: Caller): boolean {
  if (o.account) return caller.account === o.account;
  return !caller.account && Boolean(o.client) && caller.client === o.client;
}

/**
 * May `caller` continue `chain` (a reply, a click, a form, a browser report)?
 * A session without a recorded opener (made before 6.7) is not continued
 * from the app: run the command again.
 */
export function mayContinue(chain: Chain, caller: Caller, model: Pick<Model, "executors">): boolean {
  const o = chain.opener;
  if (!o) return false;
  if (sameCaller(o, caller)) return true;
  // The room it was shared to — and only while the model still posts to the room.
  return Boolean(o.room) && model.executors.chat?.visibility === "room" && caller.room === o.room;
}
