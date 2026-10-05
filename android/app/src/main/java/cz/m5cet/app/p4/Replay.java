package cz.m5cet.app.p4;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Replay and freshness (docs/protocol-v4.md § 11, F-21; replay.ts). Accepted
 * message ids are remembered PERSISTENTLY per room as
 *
 *   key = b64url(H(join("m5cet/p4/seen", roomId, id))[0:16])
 *
 * (the store never holds a readable id) for 31 days, at most 50 000 per room.
 * A message created before the window or more than 5 minutes ahead is refused
 * outright, so forgetting ids older than the window never re-admits a replay.
 * History the user restores from their own encrypted store is exempt.
 */
public final class Replay {
    private Replay() {}

    /** § 11: the stored form of a message id. */
    public static String key(String roomId, String id) throws P4Error {
        return Prim.b64url(java.util.Arrays.copyOf(Prim.H(Prim.join(P4.L_REPLAY, roomId, id)), 16));
    }

    public interface Store {
        boolean has(String roomId, String key);
        /** Remembers `key` with its time (the message's createdAt). */
        void add(String roomId, String key, long at);
        /** Forgets keys with at < before, then the oldest beyond max. */
        void prune(String roomId, long before, int max);
    }

    /** In memory, insertion-ordered per room; also the app's store's working copy (it persists rooms() itself). */
    public static class MemoryStore implements Store {
        protected final Map<String, LinkedHashMap<String, Long>> rooms = new HashMap<>();

        @Override public synchronized boolean has(String roomId, String key) { Map<String, Long> r = rooms.get(roomId); return r != null && r.containsKey(key); }

        @Override public synchronized void add(String roomId, String key, long at) {
            rooms.computeIfAbsent(roomId, k -> new LinkedHashMap<>()).put(key, at);
        }

        @Override public synchronized void prune(String roomId, long before, int max) {
            LinkedHashMap<String, Long> room = rooms.get(roomId);
            if (room == null) return;
            room.values().removeIf(at -> at < before);
            if (room.size() > max) {
                List<Map.Entry<String, Long>> byAge = new ArrayList<>(room.entrySet());
                byAge.sort(Map.Entry.comparingByValue());
                for (int i = 0; i < byAge.size() - max; i++) room.remove(byAge.get(i).getKey());
            }
        }

        public synchronized int size(String roomId) { Map<String, Long> r = rooms.get(roomId); return r == null ? 0 : r.size(); }
    }

    /** One incoming message's verdict: ok, replay, too-old, future or malformed. */
    public static final class Guard {
        private final Store store;
        private final int pruneEvery;
        private final Map<String, Integer> added = new HashMap<>();

        public Guard(Store store, int pruneEvery) { this.store = store; this.pruneEvery = pruneEvery <= 0 ? 256 : pruneEvery; }

        /**
         * "ok" (accepted and remembered), "replay", "too-old", "future" or
         * "malformed". `restored`: from the user's own history — no freshness or
         * replay check, only remembered.
         */
        public synchronized String check(String roomId, String id, Object createdAt, long now, boolean restored) {
            String key;
            try { key = key(roomId, id); } catch (P4Error e) { return "malformed"; }
            boolean safe = Prim.isSafeCount(createdAt);
            if (!restored) {
                if (!safe) return "malformed";
                long at = ((Number) createdAt).longValue();
                if (at < now - P4.REPLAY_WINDOW_MS) return "too-old";
                if (at > now + P4.REPLAY_FUTURE_MS) return "future";
                if (store.has(roomId, key)) return "replay";
            }
            store.add(roomId, key, safe ? ((Number) createdAt).longValue() : now);
            int count = added.getOrDefault(roomId, 0) + 1;
            added.put(roomId, count);
            if (count == 1 || count % pruneEvery == 0) store.prune(roomId, now - P4.REPLAY_WINDOW_MS, P4.REPLAY_MAX_IDS_PER_ROOM);
            return "ok";
        }
    }
}
