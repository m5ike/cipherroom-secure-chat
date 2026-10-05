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
import cz.m5cet.app.p4.Kt;
import cz.m5cet.app.p4.Mailbox;
import cz.m5cet.app.p4.P4Error;
import cz.m5cet.app.p4.Prim;

/**
 * 6.12: messages for members who are away (docs/protocol-v4.md § 7.4) — the
 * relay frame with an envelope per recipient. For each away account the
 * sender seals one mailbox item per TRUSTED device of it, an `mb-set` when it
 * has several, and falls back to the protocol-3 room envelope (which the
 * server cannot open) for recipients without one.
 *
 *   { type:"relay", messageId, to:[ref…], per?: { ref: mb | mb-set }, envelope? }
 *
 * Which devices (§ 7.4, review P01) — a bundle is never trusted because the
 * server delivered it, and the hub's member reference only routes:
 *   1. a device pinned from a valid hello v4 under that member's reference,
 *      its bundle signed by its device key and unexpired; when the member's
 *      account is pinned, the device's hello carried a valid certificate by
 *      THAT account key; not revoked in key transparency;
 *   2. a device of the key directory (`key-bundles`) with a v2 certificate
 *      by the account key pinned for the member — and, when this server runs
 *      key transparency, its `dev` entry included in a verified lookup and
 *      not revoked.
 * A member whose account this device never authenticated gets the room
 * envelope (as in 6.11). Pure (JVM tests): the room hands in the answers,
 * the pins, the time, its mailbox and the sealing.
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

    /** A key-transparency lookup of a member reference: its verified entries, or null when it did not verify. */
    private static final class KtSeen {
        final List<Kt.Entry> entries;
        final long at;
        KtSeen(List<Kt.Entry> entries, long at) { this.entries = entries; this.at = at; }
    }

    private final Map<String, Cached> directory = new HashMap<>();
    private final Map<String, Long> asked = new HashMap<>();
    private final Map<String, KtSeen> kt = new HashMap<>();
    private final Map<String, Long> ktAsked = new HashMap<>();

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
     * The hub's `key-bundles` answer: the devices whose v2 certificate by the
     * device's account key and bundle by its device key check out, unexpired.
     * Whether that account is the member's is decided when sealing
     * ({@link #devices}). Returns the reference.
     */
    String onKeyBundles(JSONObject f, long now) {
        String ref = f.optString("ref");
        if (ref.isEmpty()) return "";
        List<Device> out = new ArrayList<>();
        JSONArray list = f.optJSONArray("devices");
        if (list != null) for (int i = 0; i < list.length() && out.size() < 64; i++) {
            Device d = check(list.optJSONObject(i), now);
            if (d != null) out.add(d);
        }
        directory.put(ref, new Cached(out, now));
        asked.remove(ref);
        return ref;
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

    /* ------------------------------------------- key transparency (§ 14) */

    /** Is a key-transparency answer for this reference fresh? */
    boolean ktKnown(String ref, long now) {
        KtSeen k = kt.get(ref);
        return k != null && now - k.at < CACHE_MS;
    }

    /** Should a `kt-lookup` frame go out for this reference now (not known, not asked in the last 3 s)? */
    boolean shouldAskKt(String ref, long now) {
        if (ktKnown(ref, now)) return false;
        Long at = ktAsked.get(ref);
        if (at != null && now - at < 3_000) return false;
        ktAsked.put(ref, now);
        return true;
    }

    static JSONObject ktFrame(String ref) {
        try { return new JSONObject().put("type", "kt-lookup").put("ref", ref); } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    /** A checked lookup of a member reference (Kt.State.lookup): its entries when it verified, else nothing is confirmed by it. */
    void onKt(String ref, Kt.Checked checked, long now) {
        if (ref == null || ref.isEmpty()) return;
        kt.put(ref, new KtSeen(checked != null && checked.ok ? checked.entries : null, now));
        ktAsked.remove(ref);
    }

    /**
     * What the lookup of `ref` says of device `dpk` of account `apk`: "ok"
     * (the account key is the current one, the device is logged, unexpired
     * and not revoked), "revoked", "absent", "unverified" (the lookup did not
     * verify) or "unknown" (no lookup).
     */
    String ktStatus(String ref, String apk, String dpk, long now) {
        KtSeen k = kt.get(ref);
        if (k == null) return "unknown";
        if (k.entries == null) return "unverified";
        Kt.Status st = Kt.deviceStatus(k.entries, apk, dpk, now);
        if (st.revoked) return "revoked";
        return st.ok ? "ok" : "absent";
    }

    /**
     * The devices to seal for (§ 7.4, review P01): the member's pinned devices
     * (`remembered`, from hellos v4), then the directory's devices of its
     * pinned account `pinnedApk` ("" = none: then no directory device at all).
     * `ktOn`: this server runs key transparency — a directory device needs a
     * verified lookup that includes it. At most MAX_DEVICES.
     */
    List<Device> devices(String ref, String pinnedApk, List<P4Store.Remembered> remembered, boolean ktOn, long now) {
        Map<String, Device> out = new LinkedHashMap<>();
        boolean pinned = pinnedApk != null && !pinnedApk.isEmpty();
        if (remembered != null) for (P4Store.Remembered r : remembered) {
            if (out.size() >= MAX_DEVICES || out.containsKey(r.pk) || r.bundle == null || Mailbox.check(r.bundle, r.pk, now) != null) continue;
            String apk = null;
            if (r.acc != null) {
                Handshake.AccountCheck a = Handshake.verifyAccount(r.acc, r.pk, now);
                if (a != null && a.valid) apk = a.publicKey;
            }
            if (pinned && !pinnedApk.equals(apk)) continue; // not certified (now) by the member's account
            if (apk != null && "revoked".equals(ktStatus(ref, apk, r.pk, now))) continue;
            out.put(r.pk, new Device(r.pk, apk, r.bundle));
        }
        Cached c = directory.get(ref);
        if (pinned && c != null) for (Device d : c.devices) {
            if (out.size() >= MAX_DEVICES || out.containsKey(d.pk) || !pinnedApk.equals(d.apk) || d.bundle.exp <= now) continue;
            String st = ktStatus(ref, d.apk, d.pk, now);
            if (ktOn ? !"ok".equals(st) : "revoked".equals(st)) continue;
            out.put(d.pk, d);
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
     * `sealed` (may be null) gets the references that got per-device items.
     */
    static JSONObject frame(String messageId, List<String> refs, Map<String, List<Device>> devices, Sealer sealer, java.util.function.Supplier<JSONObject> roomEnvelope,
                            List<String> mention) throws JSONException {
        return frame(messageId, refs, devices, sealer, roomEnvelope, mention, null);
    }

    static JSONObject frame(String messageId, List<String> refs, Map<String, List<Device>> devices, Sealer sealer, java.util.function.Supplier<JSONObject> roomEnvelope,
                            List<String> mention, List<String> sealed) throws JSONException {
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
        if (sealed != null) for (String ref : to) if (per.has(ref)) sealed.add(ref);
        return frame;
    }

    /** Is this relayed envelope protocol 4 (an item or a set)? */
    static boolean isP4(JSONObject envelope) { return Mailbox.isItem(envelope) || Mailbox.isSet(envelope); }

    void clear() { directory.clear(); asked.clear(); kt.clear(); ktAsked.clear(); }
}
