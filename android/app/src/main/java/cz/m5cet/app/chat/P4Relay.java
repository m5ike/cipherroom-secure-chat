package cz.m5cet.app.chat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import cz.m5cet.app.p4.Handshake;
import cz.m5cet.app.p4.Mailbox;
import cz.m5cet.app.p4.P4;
import cz.m5cet.app.p4.P4Error;
import cz.m5cet.app.p4.Prim;

/**
 * 6.12: messages for members who are away (docs/protocol-v4.md § 7.4) — the
 * relay frame with an envelope per recipient. For each away account the
 * sender seals one mailbox item per known device of it (the key directory's
 * `key-bundles` answer, and bundles its hellos showed), an `mb-set` when it
 * has several, and falls back to the protocol-3 room envelope only for
 * recipients without any known bundle.
 *
 *   { type:"relay", messageId, to:[ref…], per?: { ref: mb | mb-set }, envelope? }
 *
 * Directory answers are checked here (the server is not trusted with keys):
 * the device certificate v2 by the account key, the bundle by the device key,
 * both unexpired, and the account key against its pin. Pure (JVM tests): the
 * room hands in the answers, the time, its mailbox and the sealing.
 */
final class P4Relay {
    /** One device of an away account that a message can be sealed for. */
    static final class Device {
        final String pk, apk;
        final Mailbox.Bundle bundle;
        Device(String pk, String apk, Mailbox.Bundle bundle) { this.pk = pk; this.apk = apk; this.bundle = bundle; }
    }

    static final long CACHE_MS = 5 * 60_000L;
    /** A set holds at most this many items (server: 1–16). */
    static final int MAX_DEVICES = 16;

    private static final class Cached {
        final List<Device> devices;
        final long at;
        Cached(List<Device> devices, long at) { this.devices = devices; this.at = at; }
    }

    private final Map<String, Cached> directory = new HashMap<>();
    private final Map<String, Long> asked = new HashMap<>();

    /** Is a directory answer for this reference fresh (or asked for moments ago)? */
    boolean known(String ref, long now) {
        Cached c = directory.get(ref);
        return c != null && now - c.at < CACHE_MS;
    }

    /** Should a `key-bundles` frame go out for this reference now (not known, not asked in the last 3 s)? */
    boolean shouldAsk(String ref, long now) {
        if (known(ref, now)) return false;
        Long at = asked.get(ref);
        if (at != null && now - at < 3_000) return false;
        asked.put(ref, now);
        return true;
    }

    static JSONObject askFrame(String ref) {
        try { return new JSONObject().put("type", "key-bundles").put("ref", ref); } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    /**
     * The hub's `key-bundles` answer: the devices that check out (certificate
     * by the account key, bundle by the device key, unexpired; an account key
     * whose pin says "changed" is skipped). Returns the reference.
     */
    String onKeyBundles(JSONObject f, long now, AccountPins pins) {
        String ref = f.optString("ref");
        if (ref.isEmpty()) return "";
        List<Device> out = new ArrayList<>();
        JSONArray list = f.optJSONArray("devices");
        if (list != null) for (int i = 0; i < list.length() && out.size() < MAX_DEVICES; i++) {
            Device d = check(list.optJSONObject(i), now);
            if (d != null && (pins == null || pins.allowed(d.apk))) out.add(d);
        }
        directory.put(ref, new Cached(out, now));
        asked.remove(ref);
        return ref;
    }

    interface AccountPins {
        /** False when this account key is not the one pinned for the user (do not seal to it). */
        boolean allowed(String apk);
    }

    /** One DirectoryDevice {pk, apk, cert:{v:2, exp, sig}, bundle}, or null when it does not check out. */
    static Device check(JSONObject d, long now) {
        if (d == null) return null;
        String pk = d.optString("pk"), apk = d.optString("apk");
        JSONObject cert = d.optJSONObject("cert");
        if (cert == null || cert.optInt("v") != 2 || !Prim.isP256Spki(pk)) return null;
        JSONObject acc;
        try { acc = new JSONObject().put("apk", apk).put("ac", cert.optString("sig")).put("cv", 2).put("exp", cert.optLong("exp")); }
        catch (JSONException e) { return null; }
        Handshake.AccountCheck a = Handshake.verifyAccount(acc, pk, now);
        if (a == null || !a.valid) return null;
        if (Mailbox.check(d.opt("bundle"), pk, now) != null) return null;
        return new Device(pk, apk, Mailbox.Bundle.parse(d.opt("bundle")));
    }

    /** The devices to seal for: the directory's, then bundles the account's hellos showed (by device key, newest first). */
    List<Device> devices(String ref, List<String[]> fromHellos, long now) {
        Map<String, Device> out = new LinkedHashMap<>();
        Cached c = directory.get(ref);
        if (c != null) for (Device d : c.devices) out.put(d.pk, d);
        if (fromHellos != null) for (String[] h : fromHellos) {
            if (out.containsKey(h[0]) || out.size() >= MAX_DEVICES) continue;
            try {
                Mailbox.Bundle b = Mailbox.Bundle.parse(new JSONObject(h[1]));
                if (b != null && Mailbox.check(b, h[0], now) == null) out.put(h[0], new Device(h[0], null, b));
            } catch (JSONException ignored) { }
        }
        return new ArrayList<>(out.values());
    }

    interface Sealer {
        /** One mailbox item for this device (Mailbox.seal with our current bundle), or throws. */
        JSONObject seal(Device d) throws P4Error;
    }

    /**
     * The relay frame for one message: per[ref] for every recipient with at
     * least one device sealed to, `envelope` (the protocol-3 room envelope,
     * made only when needed) for the rest. Null when there is no recipient.
     */
    static JSONObject frame(String messageId, List<String> refs, Map<String, List<Device>> devices, Sealer sealer, java.util.function.Supplier<JSONObject> roomEnvelope,
                            List<String> mention) throws JSONException {
        if (refs.isEmpty()) return null;
        JSONObject per = new JSONObject();
        boolean needRoom = false;
        for (String ref : refs) {
            List<JSONObject> items = new ArrayList<>();
            List<Device> ds = devices.get(ref);
            if (ds != null) for (Device d : ds) {
                try { items.add(sealer.seal(d)); } catch (P4Error e) { /* this device is left out */ }
            }
            if (items.isEmpty()) { needRoom = true; continue; }
            try { per.put(ref, items.size() == 1 ? items.get(0) : Mailbox.set(messageId, items)); }
            catch (P4Error e) { needRoom = true; }
        }
        JSONObject env = needRoom ? roomEnvelope.get() : null;
        List<String> to = new ArrayList<>();
        // Without a room envelope, a recipient without its own envelope cannot be addressed (the server would refuse the frame).
        for (String ref : refs) if (per.has(ref) || env != null) to.add(ref);
        if (to.isEmpty()) return null;
        JSONObject frame = new JSONObject().put("type", "relay").put("messageId", messageId).put("to", new JSONArray(to));
        if (per.length() > 0) frame.put("per", per);
        if (env != null) frame.put("envelope", env);
        if (mention != null) {
            JSONArray m = new JSONArray();
            for (String ref : mention) if (to.contains(ref)) m.put(ref);
            if (m.length() > 0) frame.put("mention", m);
        }
        return frame;
    }

    /** Is this relayed envelope protocol 4 (an item or a set)? */
    static boolean isP4(JSONObject envelope) { return Mailbox.isItem(envelope) || Mailbox.isSet(envelope); }

    void clear() { directory.clear(); asked.clear(); }
}
