package cz.m5cet.app.core;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;

import cz.m5cet.app.BuildConfig;
import cz.m5cet.app.security.Crypto;
import cz.m5cet.app.security.Vault;

/**
 * The app's log: a ring of the last lines in memory, written encrypted to
 * the system tier (record "log") every few seconds and on demand. Nothing
 * of it is ever in clear on the disk; the console gets it only when it asks
 * (a "status" command with logs) and when the policy sends errors.
 */
public final class Log {
    private Log() {}

    public static final int KEEP = 2000;

    public static final class Line {
        public final long at; public final char level; public final String tag; public final String text;
        Line(long at, char level, String tag, String text) { this.at = at; this.level = level; this.tag = tag; this.text = text; }
        JSONObject json() throws JSONException { return new JSONObject().put("at", at).put("l", String.valueOf(level)).put("t", tag).put("m", text); }
    }

    private static final ArrayDeque<Line> ring = new ArrayDeque<>();
    private static Vault vault;
    private static boolean dirty;
    private static boolean scheduled;
    private static Listener listener;

    /** Warnings and errors, for the event queue (policy "errors"). */
    public interface Listener { void onProblem(Line line); }

    public static synchronized void attach(Vault v, Listener l) {
        vault = v;
        listener = l;
        try {
            byte[] stored = v.get(Vault.Tier.SYS, "log");
            if (stored != null) {
                JSONArray arr = new JSONArray(Crypto.str(stored));
                ArrayDeque<Line> older = new ArrayDeque<>();
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject o = arr.getJSONObject(i);
                    String lv = o.optString("l", "i");
                    older.add(new Line(o.optLong("at"), lv.isEmpty() ? 'i' : lv.charAt(0), o.optString("t"), o.optString("m")));
                }
                older.addAll(ring);
                ring.clear();
                ring.addAll(older);
                while (ring.size() > KEEP) ring.removeFirst();
            }
        } catch (Exception e) {
            android.util.Log.w("m5", "the stored log could not be read: " + e.getMessage());
        }
    }

    private static void add(char level, String tag, String text) {
        Line line = new Line(System.currentTimeMillis(), level, tag, text.length() > 2000 ? text.substring(0, 2000) : text);
        Listener l;
        synchronized (Log.class) {
            ring.addLast(line);
            while (ring.size() > KEEP) ring.removeFirst();
            dirty = true;
            if (!scheduled && vault != null) { scheduled = true; Io.later(Log::flush, 3000); }
            l = listener;
        }
        if (BuildConfig.DEBUG || level == 'e') {
            int p = level == 'e' ? android.util.Log.ERROR : level == 'w' ? android.util.Log.WARN : level == 'd' ? android.util.Log.DEBUG : android.util.Log.INFO;
            android.util.Log.println(p, "m5/" + tag, text);
        }
        if (l != null && (level == 'w' || level == 'e')) {
            try { l.onProblem(line); } catch (Throwable ignored) { }
        }
    }

    public static void d(String tag, String text) { if (BuildConfig.DEBUG) add('d', tag, text); }
    public static void i(String tag, String text) { add('i', tag, text); }
    public static void w(String tag, String text) { add('w', tag, text); }
    public static void e(String tag, String text, Throwable t) {
        add('e', tag, t == null ? text : text + ": " + t.getClass().getSimpleName() + ": " + t.getMessage());
    }

    public static void flush() {
        List<Line> copy;
        Vault v;
        synchronized (Log.class) {
            scheduled = false;
            if (!dirty || vault == null) return;
            dirty = false;
            copy = new ArrayList<>(ring);
            v = vault;
        }
        try {
            JSONArray arr = new JSONArray();
            for (Line l : copy) arr.put(l.json());
            v.put(Vault.Tier.SYS, "log", Crypto.utf8(arr.toString()));
        } catch (Exception e) {
            android.util.Log.w("m5", "the log could not be written: " + e.getMessage());
        }
    }

    /** The last lines, newest last (for a status report or the about screen). */
    public static synchronized JSONArray tail(int n, boolean problemsOnly) {
        JSONArray out = new JSONArray();
        List<Line> list = new ArrayList<>(ring);
        for (int i = Math.max(0, list.size() - n * 4); i < list.size(); i++) {
            Line l = list.get(i);
            if (problemsOnly && l.level != 'w' && l.level != 'e') continue;
            try { out.put(l.json()); } catch (JSONException ignored) { }
        }
        while (out.length() > n) out.remove(0);
        return out;
    }

    public static synchronized void clear() {
        ring.clear();
        dirty = false;
        vault = null;
    }
}
