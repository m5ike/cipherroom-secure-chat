package cz.m5cet.app.voice;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.net.Server;

/**
 * The operator's gate for the voice changer (6.7): the "voiceChanger" module
 * of the client configuration (GET /api/client-config › config.modules),
 * decided like modules.ts decide() — a module off by default: no rule means
 * off; a rule that is on lets in by its default / group access and grants.
 * Asked once and again every 10 minutes (a minute after a failure); until
 * the server answered it is off.
 */
public final class FxGate {
    private FxGate() {}

    public static final String MODULE = "voiceChanger";

    /** modules.ts decide(…).allowed for a module that is off by default and has no parts. */
    public static boolean allowed(JSONObject modules, String id, List<String> groups) {
        JSONObject rule = modules == null ? null : modules.optJSONObject(id);
        if (rule == null) return false;
        if (Boolean.FALSE.equals(rule.opt("enabled"))) return false;
        List<String> access = strings(rule.optJSONArray("groups"));
        boolean in = false;
        for (String g : access) if (groups.contains(g)) { in = true; break; }
        String dflt = access(rule.opt("defaultAccess"), access.isEmpty() ? "allow" : "deny");
        String group = access(rule.opt("groupAccess"), "allow");
        if (in ? group.equals("allow") : dflt.equals("allow")) return true;
        JSONArray grants = rule.optJSONArray("grants");
        for (int i = 0; grants != null && i < grants.length(); i++) {
            JSONObject gr = grants.optJSONObject(i);
            if (gr == null || !groups.contains(gr.optString("group"))) continue;
            for (String r : strings(gr.optJSONArray("rights"))) if (!r.startsWith("-")) return true;
        }
        return false;
    }

    private static String access(Object v, String dflt) { return "allow".equals(v) || "deny".equals(v) ? (String) v : dflt; }

    private static List<String> strings(JSONArray a) {
        List<String> out = new ArrayList<>();
        for (int i = 0; a != null && i < a.length(); i++) if (a.opt(i) instanceof String) out.add(a.optString(i));
        return out;
    }

    /** This user's groups: the account's (from the server), "user" when it said none, "guest" signed out. */
    static List<String> groups(M5 app) {
        List<String> out = new ArrayList<>();
        if (app.account == null || !app.account.signedIn()) { out.add("guest"); return out; }
        out.addAll(strings(app.account.summary().optJSONArray("groups")));
        if (out.isEmpty()) out.add("user");
        return out;
    }

    /* ------------------------------------------------------------ loading */

    private static volatile JSONObject modules;
    private static volatile String modulesFor = "";
    private static volatile long nextAsk;
    private static volatile boolean asking;
    private static volatile Boolean last;
    private static final CopyOnWriteArrayList<Runnable> listeners = new CopyOnWriteArrayList<>();

    public static void addListener(Runnable r) { if (!listeners.contains(r)) listeners.add(r); }
    public static void removeListener(Runnable r) { listeners.remove(r); }

    /** Whether the voice changer may be on for this user now (asks the server when due). */
    public static boolean allowed(M5 app) {
        String server = app.config.server();
        if (server.isEmpty()) return false;
        if (System.currentTimeMillis() >= nextAsk || !modulesFor.equals(server)) ask(app, server);
        JSONObject m = modulesFor.equals(server) ? modules : null;
        boolean now = m != null && allowed(m, MODULE, groups(app));
        if (last == null || last != now) { last = now; MicFx.invalidate(); }
        return now;
    }

    /** Ask again at once (the settings screen opened). */
    public static void refresh(M5 app) { nextAsk = 0; allowed(app); }

    private static synchronized void ask(M5 app, String server) {
        if (asking) return;
        asking = true;
        nextAsk = System.currentTimeMillis() + 60_000;
        Io.bg(() -> {
            JSONObject got = null;
            try {
                JSONObject o = new JSONObject(new String(Server.send(server + "/api/client-config", "GET", null, null, null, 512 * 1024), "UTF-8"));
                JSONObject config = o.optJSONObject("config") != null ? o.optJSONObject("config") : o;
                got = config.optJSONObject("modules") != null ? config.optJSONObject("modules") : new JSONObject();
            } catch (Exception e) {
                Log.w("voice", "no module policy: " + e.getMessage());
            }
            boolean changed;
            synchronized (FxGate.class) {
                asking = false;
                changed = got != null && (modules == null || !modulesFor.equals(server) || !got.toString().equals(modules.toString()));
                if (got != null) { modules = got; modulesFor = server; nextAsk = System.currentTimeMillis() + 600_000; }
            }
            if (changed) {
                MicFx.invalidate();
                Io.main(() -> { allowed(app); for (Runnable r : listeners) r.run(); });
                app.emit("voiceFx"); // the screen on show is drawn again (the settings say whether it is allowed)
            }
        });
    }
}
