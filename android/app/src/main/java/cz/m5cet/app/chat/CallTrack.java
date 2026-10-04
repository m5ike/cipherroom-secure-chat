package cz.m5cet.app.chat;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;

/**
 * 6.8: what a room's call was for me — one record per call, not per peer —
 * worked out from what the room sees: my own audio (on / off, video) and the
 * others' audio-status ("live" / "muted" / "off"). Calls have no ringing on
 * the wire (Calls.java): someone else's audio going live is the
 * announcement, and it rings here (telecom/CallRing).
 *
 *   outgoing   I turned my audio on while nobody else was in the call
 *   incoming   I turned it on while someone was (I joined their call)
 *   missed     someone was in a call here, and it ended without me
 *   declined   …and I declined its ring (and did not join after all)
 *
 * Incoming / outgoing are recorded when I leave the call (its length is my
 * time in it); missed / declined when the call is over — nobody in it for
 * {@link #GRACE_MS}, so a connection that drops and comes back is still the
 * same call (one record, one ring). Pure (no Android): the room feeds it on
 * every change (Calls.track), CallTrackTest checks it.
 */
public final class CallTrack {
    /** How long nobody may be in a call before it is over. */
    public static final long GRACE_MS = 20_000;
    /** At most this many names in a record. */
    static final int PEOPLE_MAX = 8;

    public static final String OUT = "out", IN = "in", MISSED = "missed", DECLINED = "declined";

    /** One call as I had it. */
    public static final class Record {
        public final String kind;
        /** When I joined / started it (in, out), or when it started (missed, declined). */
        public final long at;
        /** My time in it (0 for missed / declined). */
        public final long seconds;
        public final boolean video;
        /** The others in it (their names in the room), in the order they came. */
        public final List<String> people;

        public Record(String kind, long at, long seconds, boolean video, List<String> people) {
            this.kind = kind;
            this.at = at;
            this.seconds = Math.max(0, seconds);
            this.video = video;
            this.people = Collections.unmodifiableList(new ArrayList<>(people));
        }
    }

    /** What the room does after an update. */
    public static final class Step {
        public final List<Record> records = new ArrayList<>();
        /** Someone else started a call and I am not in it: ring. */
        public boolean ring;
        /** The ring is over (I joined, declined, or the call ended). */
        public boolean ringOver;
        /** Update again at this time (when a quiet call would be over); 0 = no need. */
        public long recheckAt;
        /** Who rings (the first of the others), whether with video. */
        public String who = "";
        public boolean video;
    }

    // The call in the room (anyone's).
    private boolean call, joined, declined, ringing, callVideo;
    private long callAt, quietSince;
    private final LinkedHashSet<String> callPeople = new LinkedHashSet<>();
    // My part of it.
    private boolean me, meOutgoing, meVideo;
    private long meSince;
    private final LinkedHashSet<String> mePeople = new LinkedHashSet<>();

    /**
     * The room now: whether my audio is on (and my camera), the names of the
     * others whose audio is on, whether any of them sends video.
     */
    public synchronized Step update(long now, boolean meOn, boolean myVideo, Collection<String> live, boolean peerVideo) {
        Step s = new Step();
        boolean others = !live.isEmpty();
        boolean any = meOn || others;
        if (!call && any) {
            call = true;
            callAt = now;
            joined = declined = ringing = callVideo = false;
            callPeople.clear();
        }
        if (call) {
            add(callPeople, live);
            callVideo |= peerVideo || myVideo;
        }
        if (meOn && !me) {
            me = true;
            meSince = now;
            meOutgoing = !others;
            meVideo = false;
            mePeople.clear();
            joined = true;
        }
        if (meOn) {
            meVideo |= myVideo || peerVideo;
            add(mePeople, live);
        } else if (me) {
            me = false;
            s.records.add(new Record(meOutgoing ? OUT : IN, meSince, (now - meSince) / 1000, meVideo, new ArrayList<>(mePeople)));
        }
        if (call && others && !joined && !declined && !ringing) {
            ringing = true;
            s.ring = true;
            s.who = live.iterator().next();
            s.video = callVideo;
        }
        if (ringing && (joined || declined)) { ringing = false; s.ringOver = true; }
        if (call && !any) {
            if (quietSince == 0) quietSince = now;
            if (now - quietSince >= GRACE_MS) end(s);
            else s.recheckAt = quietSince + GRACE_MS;
        } else {
            quietSince = 0;
        }
        return s;
    }

    /** I declined the ring: the call counts as declined unless I join it after all. */
    public synchronized Step decline() {
        Step s = new Step();
        if (!call || joined) return s;
        declined = true;
        if (ringing) { ringing = false; s.ringOver = true; }
        return s;
    }

    /** The room is gone (left, closed): whatever was open is recorded now. */
    public synchronized Step flush(long now) {
        Step s = new Step();
        if (me) {
            me = false;
            s.records.add(new Record(meOutgoing ? OUT : IN, meSince, (now - meSince) / 1000, meVideo, new ArrayList<>(mePeople)));
        }
        if (call) end(s);
        return s;
    }

    /** Whether a call is ringing here now. */
    public synchronized boolean ringing() { return ringing; }

    private void end(Step s) {
        call = false;
        quietSince = 0;
        if (ringing) { ringing = false; s.ringOver = true; }
        // A call I was never in, of someone else (one I started alone and left is my outgoing record).
        if (!joined && !callPeople.isEmpty()) s.records.add(new Record(declined ? DECLINED : MISSED, callAt, 0, callVideo, new ArrayList<>(callPeople)));
        callPeople.clear();
    }

    private static void add(LinkedHashSet<String> to, Collection<String> names) {
        for (String n : names) {
            if (to.size() >= PEOPLE_MAX) return;
            if (n != null && !n.isEmpty()) to.add(n);
        }
    }
}
