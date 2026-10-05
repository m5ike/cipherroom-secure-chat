package cz.m5cet.app.fn;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 6.11: which commands this person runs, how often and when last — the
 * suggester puts the frequent and recent ones first. Kept on this device
 * only (Fn stores it in the vault's user tier), at most {@link #KEEP}
 * keywords. Pure; thread-safe.
 */
public final class Usage {
    public static final int KEEP = 50;
    static final long HOUR = 3_600_000L, DAY = 24 * HOUR;

    /** keyword → {count, last use (ms)}. */
    private final Map<String, long[]> uses = new LinkedHashMap<>();

    public Usage() {}

    /** From what toJson() wrote: {keyword: [count, last]}; anything else is skipped. */
    public static Usage from(JSONObject o) {
        Usage u = new Usage();
        if (o == null) return u;
        for (Iterator<String> it = o.keys(); it.hasNext(); ) {
            String k = it.next();
            JSONArray a = o.optJSONArray(k);
            if (a == null || a.length() < 2 || k.length() > 40) continue;
            long count = a.optLong(0), last = a.optLong(1);
            if (count > 0 && last > 0) u.uses.put(k, new long[]{Math.min(count, 1_000_000), last});
        }
        u.trim();
        return u;
    }

    /** A command ran (or was asked for). */
    public synchronized void used(String keyword, long now) {
        if (keyword == null || keyword.isEmpty()) return;
        long[] u = uses.remove(keyword);
        uses.put(keyword, u == null ? new long[]{1, now} : new long[]{Math.min(u[0] + 1, 1_000_000), now});
        trim();
    }

    /**
     * How much a keyword leads (0: never used): its uses (up to 20) weighed
     * by how recent the last one is — this hour ×8, today ×4, this week ×2,
     * this month ×1, older ×0.5.
     */
    public synchronized double score(String keyword, long now) {
        long[] u = uses.get(keyword);
        if (u == null) return 0;
        long age = Math.max(0, now - u[1]);
        double w = age < HOUR ? 8 : age < DAY ? 4 : age < 7 * DAY ? 2 : age < 30 * DAY ? 1 : 0.5;
        return Math.min(u[0], 20) * w;
    }

    public synchronized int count(String keyword) { long[] u = uses.get(keyword); return u == null ? 0 : (int) u[0]; }

    public synchronized JSONObject toJson() {
        JSONObject o = new JSONObject();
        try { for (Map.Entry<String, long[]> e : uses.entrySet()) o.put(e.getKey(), new JSONArray().put(e.getValue()[0]).put(e.getValue()[1])); }
        catch (JSONException e) { throw new IllegalStateException(e); }
        return o;
    }

    /** The newest KEEP only. */
    private void trim() {
        if (uses.size() <= KEEP) return;
        List<Map.Entry<String, long[]>> all = new ArrayList<>(uses.entrySet());
        all.sort((x, y) -> Long.compare(y.getValue()[1], x.getValue()[1]));
        uses.clear();
        for (int i = 0; i < KEEP; i++) uses.put(all.get(i).getKey(), all.get(i).getValue());
    }
}
