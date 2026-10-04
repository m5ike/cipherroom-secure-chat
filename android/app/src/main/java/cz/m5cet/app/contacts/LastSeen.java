package cz.m5cet.app.contacts;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * 6.7 presence: online, away or far away — from whether a member is
 * connected with the app in the foreground, else from when they were last
 * seen (the last time they had the app open while connected). The web's
 * client/src/lib/presence.ts (the server uses it too), mirrored with the
 * same thresholds, so the app and the web show the same colour:
 *
 *   connected and in the foreground     online   (green, @success)
 *   last seen at most 5 minutes ago     online
 *   last seen 5 to 60 minutes ago       away     (yellow, @warning)
 *   last seen more than an hour ago     far      (orange — the theme has no token for it)
 *
 * Pure, so the unit tests pin it down.
 */
public final class LastSeen {
    private LastSeen() {}

    public static final long ONLINE_MS = 5 * 60_000L;
    public static final long AWAY_MS = 60 * 60_000L;
    public static final String ONLINE = "online", AWAY = "away", FAR = "far";
    /** Far away: orange (Tailwind orange-500, as the web's dot in a dark tone). */
    public static final String ORANGE = "#f97316";

    /** The presence at `now`; lastSeen 0 = unknown, which counts as far away unless in the foreground. */
    public static String state(boolean connected, boolean foreground, long lastSeen, long now) {
        if (connected && foreground) return ONLINE;
        if (lastSeen <= 0) return FAR;
        long age = now - lastSeen;
        if (age <= ONLINE_MS) return ONLINE;
        if (age <= AWAY_MS) return AWAY;
        return FAR;
    }

    /** When the member was last seen as of `now`: now while connected in the foreground. */
    public static long seenAt(boolean connected, boolean foreground, long lastSeen, long now) {
        return connected && foreground ? now : lastSeen;
    }

    /** Milliseconds until state() changes by itself; -1 when it does not without news. */
    public static long changeIn(boolean connected, boolean foreground, long lastSeen, long now) {
        if ((connected && foreground) || lastSeen <= 0) return -1;
        long age = now - lastSeen;
        if (age <= ONLINE_MS) return ONLINE_MS - age + 1;
        if (age <= AWAY_MS) return AWAY_MS - age + 1;
        return -1;
    }

    /** The dot's colour: a theme token, orange where the theme has none. */
    public static String color(String state) {
        switch (state) {
            case ONLINE: return "@success";
            case AWAY: return "@warning";
            default: return ORANGE;
        }
    }

    /** "How long ago": a unit — "now" (under a minute), "min", "h" or "d" — and how many. */
    public static final class Ago {
        public final String unit;
        public final long n;
        Ago(String unit, long n) { this.unit = unit; this.n = n; }
    }

    public static Ago ago(long lastSeen, long now) {
        long ms = Math.max(0, now - lastSeen);
        if (ms < 60_000L) return new Ago("now", 0);
        if (ms < 60 * 60_000L) return new Ago("min", ms / 60_000L);
        if (ms < 24 * 60 * 60_000L) return new Ago("h", ms / (60 * 60_000L));
        return new Ago("d", ms / (24 * 60 * 60_000L));
    }

    /** The app's words for a key (app.t). */
    public interface Words { String t(String key); }

    /** "Last seen 12 min ago", "In the app right now", or that it is not known. */
    public static String seenText(boolean connected, boolean foreground, long lastSeen, long now, Words w) {
        if (connected && foreground) return w.t("presence.now");
        if (lastSeen <= 0) return w.t("presence.seen.unknown");
        Ago a = ago(lastSeen, now);
        String ago = "now".equals(a.unit) ? w.t("presence.ago.now") : w.t("presence.ago." + a.unit).replace("{n}", String.valueOf(a.n));
        return w.t("presence.seen").replace("{ago}", ago);
    }

    /**
     * Adds what the People widget draws of a person's presence — .presence,
     * .presenceColor, .presenceLabel, .seenText — from the room's facts
     * (.connected, .foreground, .lastSeen; RoomSession.peopleScope). A member
     * whose connection went (channel "held") shows the presence as their status.
     */
    public static JSONObject decorate(JSONObject u, Words w, long now) {
        if (u == null || !u.has("lastSeen")) return u;
        boolean connected = u.optBoolean("connected", true), foreground = u.optBoolean("foreground", true);
        long lastSeen = (long) u.optDouble("lastSeen", 0);
        String state = state(connected, foreground, lastSeen, now);
        try {
            u.put("presence", state).put("presenceColor", color(state)).put("presenceLabel", w.t("presence." + state))
                .put("seenText", seenText(connected, foreground, lastSeen, now, w));
            if ("held".equals(u.optString("channel"))) {
                u.put("statusIcon", "moon").put("statusColor", color(state)).put("statusLabel", w.t("presence." + state));
            }
        } catch (JSONException ignored) { }
        return u;
    }
}
