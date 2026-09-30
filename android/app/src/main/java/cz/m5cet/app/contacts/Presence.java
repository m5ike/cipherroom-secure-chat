package cz.m5cet.app.contacts;

import java.util.Locale;

/**
 * 6.2 People: a person's status and connection quality, as the web's
 * recipients widget shows them (RecipientsWidget.tsx) — pure, so the unit
 * tests pin it down.
 *
 * The web knows a peer as connecting / open / closed, and a signed-in member
 * who left as "away" (the server holds their messages). The app adds what it
 * also knows: whether the connection carries an account (the server says so),
 * and whether the person is in a call. That gives the statuses
 *
 *   online      a channel is open and the person is signed in
 *   light       a channel is open, a guest without an account (P2P, "light")
 *   dnd         in a call right now (busy)
 *   away        signed in, not connected — the server holds messages for them
 *   connecting  the channel is being set up
 *   offline     the connection failed or closed
 */
public final class Presence {
    private Presence() {}

    public static final String ONLINE = "online", LIGHT = "light", DND = "dnd", AWAY = "away", CONNECTING = "connecting", OFFLINE = "offline";

    /**
     * channel: "open", "connecting", "closed" or "away"; signedIn: the server
     * reports an account on the connection; audio: the call state the person
     * announced ("off", "live", "muted").
     */
    public static String status(String channel, boolean signedIn, String audio) {
        if ("away".equals(channel)) return AWAY;
        if ("open".equals(channel)) {
            if ("live".equals(audio) || "muted".equals(audio)) return DND;
            return signedIn ? ONLINE : LIGHT;
        }
        if ("connecting".equals(channel)) return CONNECTING;
        return OFFLINE;
    }

    /** The order of the list: connected people first, away next (the server answers for them), the rest last. */
    public static int rank(String status) {
        switch (status) {
            case ONLINE: case LIGHT: case DND: return 0;
            case AWAY: return 1;
            case CONNECTING: return 2;
            default: return 3;
        }
    }

    /** A lucide icon for the status. */
    public static String icon(String status) {
        switch (status) {
            case ONLINE: return "circle-check";
            case LIGHT: return "circle-dot";
            case DND: return "circle-minus";
            case AWAY: return "moon";
            case CONNECTING: return "loader-circle";
            default: return "circle-off";
        }
    }

    /** The status's colour: a theme token, or a fixed colour where the theme has none (light = sky blue). */
    public static String color(String status) {
        switch (status) {
            case ONLINE: return "@success";
            case LIGHT: return "#0ea5e9";
            case DND: return "@danger";
            case AWAY: return "@warning";
            default: return "@muted";
        }
    }

    /**
     * The latency meter of RecipientsWidget.tsx: 0–4 bars. Not open: 0; the
     * round trip not known yet: 2; under 60 ms: 4, 120: 3, 250: 2, slower: 1.
     * rttMs < 0 = not known.
     */
    public static int bars(boolean open, long rttMs) {
        if (!open) return 0;
        if (rttMs < 0) return 2;
        return rttMs < 60 ? 4 : rttMs < 120 ? 3 : rttMs < 250 ? 2 : 1;
    }

    /** The web's tone of the meter: good (4), ok (2–3), bad (1), off (0). */
    public static String tone(int bars) { return bars >= 4 ? "good" : bars >= 2 ? "ok" : bars >= 1 ? "bad" : "off"; }

    public static String signalIcon(int bars) {
        switch (Math.max(0, Math.min(4, bars))) {
            case 4: return "signal";
            case 3: return "signal-high";
            case 2: return "signal-medium";
            case 1: return "signal-low";
            default: return "signal-zero";
        }
    }

    public static String signalColor(int bars) {
        switch (tone(bars)) {
            case "good": return "@success";
            case "ok": return "@warning";
            case "bad": return "@danger";
            default: return "@muted";
        }
    }

    /** "direct" (host / server-reflexive candidates), "relay" (TURN on either side) or "" before a pair is chosen. */
    public static String transport(String localType, String remoteType) {
        if (empty(localType) && empty(remoteType)) return "";
        return "relay".equals(localType) || "relay".equals(remoteType) ? "relay" : "direct";
    }

    /** How long, as the web's user info says it (UserInfoModal dur()): "2 h 5 min", "3 min 12 s", "40 s"; "—" when unknown. */
    public static String duration(long ms, String h, String m, String s) {
        if (ms < 0) return "—";
        long sec = ms / 1000;
        long hh = sec / 3600, mm = (sec % 3600) / 60, ss = sec % 60;
        if (hh > 0) return hh + " " + h + " " + mm + " " + m;
        if (mm > 0) return mm + " " + m + " " + ss + " " + s;
        return ss + " " + s;
    }

    /** Bytes as the web's user info shows them: "512 B", "1.5 kB", "2.25 MB". */
    public static String bytes(long n) {
        if (n < 1024) return n + " B";
        if (n < 1024 * 1024) return String.format(Locale.ROOT, "%.1f kB", n / 1024.0);
        return String.format(Locale.ROOT, "%.2f MB", n / (1024.0 * 1024.0));
    }

    private static boolean empty(String s) { return s == null || s.isEmpty(); }
}
