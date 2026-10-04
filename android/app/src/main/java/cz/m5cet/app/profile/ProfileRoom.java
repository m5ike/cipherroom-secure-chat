package cz.m5cet.app.profile;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 6.7: profiles inside a room, as the web speaks them
 * (client/src/lib/profile/room.ts). What a member marked "room members"
 * (and "public") travels as a payload {kind:"profile"} sealed with the pair
 * key to one peer at a time — never the room key, never through the server:
 *
 *   announce  {rev}              my profile's version ("" = none), to a peer
 *                                whose hello offered caps "profile", and to
 *                                everyone when it changes
 *   request   {rev, want:true}   "send me that one"
 *   full      {rev, profile}     the view (ProfileCard.normalizeShared on arrival)
 *
 * The Cache keeps what came by the sender's device key and rev, so another
 * member cannot plant a copy under someone else's version.
 */
public final class ProfileRoom {
    private ProfileRoom() {}

    public static final String CAP = "profile";
    /** A sealed frame longer than this goes again without the background. */
    public static final int FRAME_MAX_CHARS = 240_000;
    /** A peer asking for the same version again within this long gets no second copy. */
    public static final long ANSWER_EVERY_MS = 30_000;

    private static final Pattern REV = Pattern.compile("^[0-9a-z]{0,40}$");

    /** The profile part of a checked payload, or null: {rev} / {rev, want} / {rev, profile}. */
    public static JSONObject parse(JSONObject p) {
        if (p == null || !(p.opt("rev") instanceof String) || !REV.matcher(p.optString("rev")).matches()) return null;
        String rev = p.optString("rev");
        try {
            if (p.optBoolean("want")) return rev.isEmpty() ? null : new JSONObject().put("rev", rev).put("want", true);
            if (p.has("profile")) {
                JSONObject profile = ProfileCard.normalizeShared(p.opt("profile"));
                return profile == null || rev.isEmpty() ? null : new JSONObject().put("rev", rev).put("profile", profile);
            }
            return new JSONObject().put("rev", rev);
        } catch (JSONException e) { return null; }
    }

    public static JSONObject announce(JSONObject view) {
        try { return new JSONObject().put("rev", view == null ? "" : view.optString("rev")); } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    /** The full frame; `lite` leaves the background out. */
    public static JSONObject full(JSONObject view, boolean lite) {
        try {
            JSONObject v = new JSONObject(view.toString());
            if (lite) v.remove("cover");
            return new JSONObject().put("rev", view.optString("rev")).put("profile", v);
        } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    /** What this phone knows of the other members' profiles (shared by every room). */
    public static final class Cache {
        private final int max;
        private final LinkedHashMap<String, JSONObject> byKey = new LinkedHashMap<>(16, 0.75f, true);
        /** peer id → owner|rev */
        private final Map<String, String> peers = new HashMap<>();

        public Cache(int max) { this.max = max; }

        /** "cached", "request", "cleared" or "same". */
        public synchronized String announced(String peerId, String owner, String rev) {
            String before = peers.get(peerId);
            if (rev == null || rev.isEmpty() || owner == null || owner.isEmpty()) {
                if (before == null) return "same";
                peers.remove(peerId);
                return "cleared";
            }
            String key = owner + "|" + rev;
            if (key.equals(before) && byKey.containsKey(key)) return "same";
            if (byKey.containsKey(key)) { peers.put(peerId, key); byKey.get(key); return "cached"; }
            return "request";
        }

        public synchronized JSONObject received(String peerId, String owner, JSONObject frame) {
            JSONObject profile = frame == null ? null : frame.optJSONObject("profile");
            String rev = frame == null ? "" : frame.optString("rev");
            if (profile == null || rev.isEmpty() || owner == null || owner.isEmpty()) return null;
            String key = owner + "|" + rev;
            byKey.put(key, profile);
            peers.put(peerId, key);
            Iterator<String> it = byKey.keySet().iterator();
            while (byKey.size() > max && it.hasNext()) { it.next(); it.remove(); }
            return profile;
        }

        public synchronized JSONObject of(String peerId) {
            String key = peers.get(peerId);
            return key == null ? null : byKey.get(key);
        }

        public synchronized void forget(String peerId) { peers.remove(peerId); }

        public synchronized void clear() { byKey.clear(); peers.clear(); }
    }

    /** What the exchange needs from its room. */
    public interface Deps {
        /** Seals the frame with the pair key and sends it to that one peer; false when it could not go (or would not fit). */
        boolean send(String peerId, JSONObject frame);
        /** What room members may see of me now (null: nothing). */
        JSONObject myView();
        /** The peer's device key (the cache's owner) — null before its hello was accepted. */
        String ownerOf(String peerId);
        long now();
    }

    /** The protocol between this phone and the peers of one room (on the room's thread). */
    public static final class Exchange {
        public final Cache cache;
        private final Deps deps;
        private final Set<String> peers = new HashSet<>();
        private final Map<String, Long> answered = new HashMap<>();
        /** The account key that signed each peer's messages (a public profile's is compared with it). */
        private final Map<String, String> accountKeys = new java.util.concurrent.ConcurrentHashMap<>();

        public Exchange(Cache cache, Deps deps) { this.cache = cache; this.deps = deps; }

        public boolean speaks(String peerId) { return peers.contains(peerId); }

        /** Their hello was accepted: if they speak profiles, they learn my rev. */
        public void hello(String peerId, JSONArray caps) {
            boolean yes = false;
            for (int i = 0; caps != null && i < caps.length(); i++) if (CAP.equals(caps.optString(i))) yes = true;
            if (!yes) { peers.remove(peerId); return; }
            peers.add(peerId);
            deps.send(peerId, announce(deps.myView()));
        }

        public void receive(String peerId, JSONObject frame) {
            String owner = deps.ownerOf(peerId);
            if (owner == null || owner.isEmpty() || frame == null) return;
            String rev = frame.optString("rev");
            if (frame.optBoolean("want")) {
                JSONObject view = deps.myView();
                if (view == null || !rev.equals(view.optString("rev"))) return;
                String key = peerId + "|" + rev;
                Long last = answered.get(key);
                long now = deps.now();
                if (last != null && now - last < ANSWER_EVERY_MS) return;
                answered.put(key, now);
                if (!deps.send(peerId, full(view, false))) deps.send(peerId, full(view, true));
                return;
            }
            if (frame.has("profile")) { cache.received(peerId, owner, frame); return; }
            if ("request".equals(cache.announced(peerId, owner, rev))) {
                try { deps.send(peerId, new JSONObject().put("rev", rev).put("want", true)); } catch (JSONException ignored) { }
            }
        }

        /** My profile changed (saved, loaded, signed out): everyone who speaks profiles learns the new rev. */
        public void changed() {
            JSONObject frame = announce(deps.myView());
            for (String peerId : new HashSet<>(peers)) deps.send(peerId, frame);
        }

        public void signedBy(String peerId, String accountKey) { if (accountKey != null && !accountKey.isEmpty()) accountKeys.put(peerId, accountKey); }

        public String accountKey(String peerId) { return accountKeys.getOrDefault(peerId, ""); }

        public void forget(String peerId) {
            peers.remove(peerId);
            accountKeys.remove(peerId);
            cache.forget(peerId);
            answered.keySet().removeIf(k -> k.startsWith(peerId + "|"));
        }
    }
}
