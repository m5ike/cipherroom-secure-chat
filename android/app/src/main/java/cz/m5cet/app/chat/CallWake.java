package cz.m5cet.app.chat;

import org.json.JSONException;
import org.json.JSONObject;

import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;
import java.util.regex.Pattern;

/**
 * 6.14 — call wake (docs/api.md › Buzení při hovoru; the web's
 * client/src/lib/call-wake.ts does the same, the iOS port too).
 *
 * Calls have no ringing on the wire (Calls.java): someone's audio going live
 * is the announcement, and only members on a live data channel see it. A
 * member who is AWAY (no awake socket) never did. Now the caller's room relays
 * ONE call item to the away members when its call starts — sealed like a
 * message (P4Relay: their devices' mailboxes, else the room envelope) — and
 * the server wakes them with kind "call" (FCM "notify" with `call`, web push,
 * iOS PushKit). Hanging up before anyone answered relays a second item that
 * ends the ring.
 *
 *   payload  {kind:"call", id, createdAt, senderId, senderName,
 *             call:"<call id>", state:"ring"|"end", video, at}
 *   frame    the relay frame + {call:true | callEnd:true, callId, video?} —
 *            only to a server whose hello lists "call-wake"
 *
 * Older apps drop the payload (Payloads.validate refuses an unknown kind).
 *
 * The receiver: a pushed ring rings like a call the room shows (CallRing,
 * same notification), a relayed one (the room is connected again) waits
 * {@link #SETTLE_MS} for the room to show the call. Once the room shows a call,
 * its CallTrack has it — one record per call; a ring that never showed, or an
 * end, is a missed call (declined when I declined the pushed ring). Pure (JVM
 * tests: CallWakeTest); the room (Calls) feeds it and carries out its steps.
 */
public final class CallWake {
    private CallWake() {}

    /** The hello feature of a server that wakes for calls (server/signaling/frames.ts). */
    public static final String FEATURE = "call-wake";
    /** A ring rings at most this long (the server's push expiry on every channel; CallRing.RING_MS). */
    public static final long RING_MS = 60_000;
    /** A relayed ring (or a late push) waits this long for the room to show its call. */
    public static final long SETTLE_MS = 30_000;
    public static final String RING = "ring", END = "end";

    private static final Pattern CALL_ID = Pattern.compile("^[A-Za-z0-9_:.-]{1,90}$");
    private static final Pattern PUSHED_CALL_ID = Pattern.compile("^[A-Za-z0-9_:.-]{1,96}$");
    private static final SecureRandom RANDOM = new SecureRandom();

    /** The relay message id of a call's ring / end (the queue deduplicates a repeated one). */
    public static String messageId(String callId, String state) { return callId + (RING.equals(state) ? ":r" : ":e"); }

    /** A new call id: "cw-" and 24 hex digits. */
    public static String newCallId() {
        byte[] b = new byte[12];
        RANDOM.nextBytes(b);
        StringBuilder s = new StringBuilder("cw-");
        for (byte x : b) s.append(String.format(java.util.Locale.ROOT, "%02x", x & 0xff));
        return s.toString();
    }

    /** The sealed payload of a ring or an end. */
    public static JSONObject payload(String callId, String state, boolean video, long at, String senderId, String senderName, long now) {
        try {
            return new JSONObject().put("kind", "call").put("id", messageId(callId, state)).put("createdAt", now)
                .put("senderId", senderId).put("senderName", senderName).put("call", callId).put("state", state).put("video", video).put("at", at);
        } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    /** What the relay frame adds (server/signaling/frames.ts): call or callEnd, callId, video. */
    public static JSONObject relayFields(String callId, String state, boolean video) {
        try {
            JSONObject o = new JSONObject().put(RING.equals(state) ? "call" : "callEnd", true).put("callId", callId);
            if (video) o.put("video", true);
            return o;
        } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    /* ---------------------------------------------------------- receiving */

    /** A call item from the relay, checked like a message (Payloads.validate). */
    public static final class Item {
        public final String id, call, state, senderId, senderName;
        public final boolean video;
        public final long at, createdAt;
        Item(String id, String call, String state, String senderId, String senderName, boolean video, long at, long createdAt) {
            this.id = id; this.call = call; this.state = state; this.senderId = senderId; this.senderName = senderName; this.video = video; this.at = at; this.createdAt = createdAt;
        }
        public boolean end() { return END.equals(state); }
    }

    /**
     * A decrypted relayed payload that is a call item: its sender the peer the
     * server says relayed it, never us or a reserved id; bounded; a clock far
     * ahead held to now. null when it is not one (Payloads.validate decides).
     */
    public static Item parse(JSONObject p, String transportSender, String myId, long now) {
        if (p == null || !"call".equals(p.optString("kind"))) return null;
        String id = Payloads.str(p.opt("id"), Payloads.ID), senderId = Payloads.str(p.opt("senderId"), Payloads.ID);
        if (id == null || id.isEmpty() || senderId == null || senderId.isEmpty()) return null;
        if (senderId.equals("system") || senderId.equals("self") || senderId.equals("server") || senderId.equals("admin")) return null;
        if (cz.m5cet.app.fn.ModelIdentity.reservedSender(senderId)) return null;
        if (senderId.equals(myId) || (transportSender != null && !senderId.equals(transportSender))) return null;
        Object call = p.opt("call");
        if (!(call instanceof String) || !CALL_ID.matcher((String) call).matches()) return null;
        String state = p.optString("state");
        if (!RING.equals(state) && !END.equals(state)) return null;
        String name = Payloads.clean(p.opt("senderName"), Payloads.NAME, "peer-" + senderId.substring(Math.max(0, senderId.length() - 4)));
        return new Item(id, (String) call, state, senderId, name, Boolean.TRUE.equals(p.opt("video")), clamp(p.opt("at"), now), clamp(p.opt("createdAt"), now));
    }

    private static long clamp(Object v, long now) {
        if (!(v instanceof Number) || !Double.isFinite(((Number) v).doubleValue()) || ((Number) v).longValue() <= 0) return now;
        return Math.min(((Number) v).longValue(), now + Payloads.FUTURE_SKEW);
    }

    /** A call the server pushed (a "notify" control message of kind "call" with `call`). */
    public static final class Pushed {
        public final String call, room, who;
        public final boolean video, end;
        public final long at;
        Pushed(String call, String room, String who, boolean video, boolean end, long at) {
            this.call = call; this.room = room; this.who = who; this.video = video; this.end = end; this.at = at;
        }
    }

    /**
     * The call of a server notification (server/notify: `call` {id, video, at,
     * end?, room} — the room only on the app channel); null when it is not one.
     * `who`: the sender as far as the user's privacy level let it through.
     */
    public static Pushed pushed(JSONObject p, long now) {
        if (p == null || !"call".equals(p.optString("kind"))) return null;
        JSONObject c = p.optJSONObject("call");
        if (c == null) return null;
        String id = c.optString("id"), room = c.optString("room");
        if (!PUSHED_CALL_ID.matcher(id).matches() || room.isEmpty() || room.length() > 64) return null;
        JSONObject vars = p.optJSONObject("vars");
        String who = vars == null ? "" : Payloads.clean(vars.opt("sender"), Payloads.NAME, "");
        return new Pushed(id, room, who, c.optBoolean("video", false), c.optBoolean("end", false), clamp(c.opt("at"), now));
    }

    /* ------------------------------------------------------------- sending */

    /** A ring that is out: its call, video, when, and to whom (room-scoped references). */
    public static final class Ring {
        public final String callId;
        public final boolean video;
        public final long at;
        public final List<String> refs;
        Ring(String callId, boolean video, long at, List<String> refs) {
            this.callId = callId; this.video = video; this.at = at; this.refs = Collections.unmodifiableList(new ArrayList<>(refs));
        }
    }

    /** The caller's side of one call. */
    public static final class Sender {
        private Ring current;
        private boolean answered;

        /**
         * I turned my audio on. A ring when the server wakes for calls, nobody
         * else is in the call (I start it — CallTrack's outgoing) and someone
         * is away; null otherwise (joining someone's call rings nobody).
         */
        public synchronized Ring start(boolean serverWakes, int othersInCall, Collection<String> away, boolean video, long now, Supplier<String> newId) {
            current = null;
            answered = false;
            if (!serverWakes || othersInCall > 0 || away == null) return null;
            List<String> refs = new ArrayList<>(new LinkedHashSet<>(away));
            if (refs.isEmpty()) return null;
            if (refs.size() > 50) refs = refs.subList(0, 50);
            current = new Ring(newId.get(), video, now, refs);
            return current;
        }

        /** Someone else's audio went on while my ring was out: answered — no end. */
        public synchronized void answered() { if (current != null) answered = true; }

        /** The ring that is out, null when none (or answered). */
        public synchronized Ring ringing() { return current != null && !answered ? current : null; }

        /** I hung up: the end of my ring when nobody answered it — to those still away. null otherwise. */
        public synchronized Ring stop(Collection<String> awayNow) {
            Ring c = current;
            boolean was = answered;
            current = null;
            answered = false;
            if (c == null || was) return null;
            List<String> refs = new ArrayList<>();
            for (String r : c.refs) if (awayNow != null && awayNow.contains(r)) refs.add(r);
            return refs.isEmpty() ? null : new Ring(c.callId, c.video, c.at, refs);
        }
    }

    /* ------------------------------------------------------------- the inbox */

    /** What the room does now: ring (CallRing.ring), stop a ring (over), record calls, show a missed call. */
    public static final class Step {
        public boolean ring, over;
        public String who = "";
        public boolean video;
        public final List<CallTrack.Record> records = new ArrayList<>();
        /** A missed call to show (CallRing.missed) — the record's details. */
        public CallTrack.Record missed;
    }

    private static final class Pending {
        String who;
        final boolean video;
        final long at;
        long until;
        boolean rang, declined;
        Pending(String who, boolean video, long at, long until) { this.who = who; this.video = video; this.at = at; this.until = until; }
    }

    /** The receiver's side, one per room. */
    public static final class Inbox {
        private final Map<String, Pending> pending = new LinkedHashMap<>();
        private final LinkedHashSet<String> done = new LinkedHashSet<>();

        private void finish(String call) {
            pending.remove(call);
            done.add(call);
            while (done.size() > 500) done.remove(done.iterator().next());
        }

        /** A ring or an end the server pushed. `roomInCall`: someone else's audio is on in the room now. */
        public synchronized Step push(Pushed p, long now, boolean roomInCall) {
            Step s = new Step();
            if (p == null || done.contains(p.call)) return s;
            if (p.end) return end(p.call, p.who, p.video, p.at, s);
            if (roomInCall) { finish(p.call); return s; } // the room shows it: its CallTrack rings
            Pending w = pending.get(p.call);
            boolean fresh = now - p.at <= RING_MS;
            if (w == null) {
                w = new Pending(p.who, p.video, p.at, fresh ? now + RING_MS : now + SETTLE_MS);
                pending.put(p.call, w);
            } else if (w.who.isEmpty()) {
                w.who = p.who;
            }
            if (fresh && !w.rang && !w.declined) {
                w.rang = true;
                w.until = Math.max(w.until, now + RING_MS);
                s.ring = true;
                s.who = w.who;
                s.video = w.video;
            }
            return s;
        }

        /** A call item the relay delivered (the room is connected again): never rings by itself — the room does. */
        public synchronized Step relayed(Item item, long now, boolean roomInCall) {
            Step s = new Step();
            if (item == null || done.contains(item.call)) return s;
            if (item.end()) return end(item.call, item.senderName, item.video, item.at, s);
            if (roomInCall) { finish(item.call); return s; }
            Pending w = pending.get(item.call);
            if (w == null) pending.put(item.call, new Pending(item.senderName, item.video, item.at, now + SETTLE_MS));
            else if (w.who.isEmpty()) w.who = item.senderName; // the push did not name the caller; the item does
            return s;
        }

        private Step end(String call, String who, boolean video, long at, Step s) {
            Pending w = pending.get(call);
            finish(call);
            boolean declined = w != null && w.declined;
            String name = w != null && !w.who.isEmpty() ? w.who : who;
            s.over = w != null && w.rang;
            CallTrack.Record r = record(declined, w != null ? w.at : at, w != null ? w.video : video, name);
            s.records.add(r);
            if (!declined) s.missed = r;
            return s;
        }

        private static CallTrack.Record record(boolean declined, long at, boolean video, String who) {
            List<String> people = new ArrayList<>();
            if (who != null && !who.isEmpty()) people.add(who);
            return new CallTrack.Record(declined ? CallTrack.DECLINED : CallTrack.MISSED, at, 0, video, people);
        }

        /**
         * The room shows a call now: the waiting rings are that call — its
         * CallTrack records it. True when I had declined one of them (the room
         * then declines its ring: no second ring, a declined call).
         */
        public synchronized boolean roomInCall() {
            boolean declined = false;
            for (Pending w : pending.values()) declined |= w.declined;
            for (String call : new ArrayList<>(pending.keySet())) finish(call);
            return declined;
        }

        /** I declined the pushed ring (CallRing's Decline). */
        public synchronized void decline() {
            for (Pending w : pending.values()) if (w.rang) w.declined = true;
        }

        /** Whether a ring waits (for the room to show its call). */
        public synchronized boolean waiting() { return !pending.isEmpty(); }

        /** The waiting rings whose time is up: missed calls (declined when I declined them). */
        public synchronized Step due(long now) {
            Step s = new Step();
            for (Map.Entry<String, Pending> e : new ArrayList<>(pending.entrySet())) {
                Pending w = e.getValue();
                if (w.until > now) continue;
                finish(e.getKey());
                if (w.rang) s.over = true;
                CallTrack.Record r = record(w.declined, w.at, w.video, w.who);
                s.records.add(r);
                if (!w.declined && s.missed == null) s.missed = r;
            }
            return s;
        }

        /** When the next waiting ring is due (0: none). */
        public synchronized long nextDue() {
            long next = 0;
            for (Pending w : pending.values()) if (next == 0 || w.until < next) next = w.until;
            return next;
        }
    }
}
