package cz.m5cet.app.chat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.security.Crypto;
import cz.m5cet.app.security.FileVault;
import cz.m5cet.app.security.LockBox;
import cz.m5cet.app.security.Vault;

/**
 * 6.12 (security analysis F-16): the rooms while the app is locked — the
 * default ("receive while locked"; Settings › Security › "Disconnect when
 * locked" is the strict alternative, Rooms.disconnectAll).
 *
 * At the lock the vault's data key goes (Vault.lock) but the open rooms stay
 * connected with their own keys: messages keep arriving, notifications stay
 * neutral. What would be written into the encrypted stores meanwhile goes
 * into the lock inbox instead (security/LockBox: sealed to a key pair made
 * at the lock — only its public key stays in memory, its private key is
 * sealed by the data key before that is zeroed):
 *
 *   msg     a message of a room, as the history keeps it (a new one, or one
 *           that changed: a file stored, an outbox message sent) — merged by
 *           its id, the newer state replacing the older
 *   state   a receipt / relay state for a message of mine from before the
 *           lock (the room's list holds no history then)
 *   pin     a key pinned on first sight of a name (Rooms.pin)
 *   resume  the room's peer id and resume secret (Resume)
 *   call    an ended call (CallHistory), callUri its row in the phone's log
 *   file    a received file: checked, kept encrypted under its transfer key
 *           (moved into lockbox/files), the key in the item
 *
 * At the unlock the inbox closes, every generation on the disk is opened with
 * the data key, merged into the histories, pins, resume records, call history
 * and file vault, then deleted (drain, a background thread; a lock waits for
 * it — AppLock). A crash while locked keeps the inbox on the disk, still
 * unreadable without the PIN; the next unlock drains it (merging twice is
 * harmless: by id). The history from before the lock is not in memory while
 * locked; what arrives during the lock is — the room's own keys could open it.
 */
public final class LockedRooms {
    private LockedRooms() {}

    private static final Object LOCK = new Object();
    /** The open generation (null: not locked in the receiving mode). Only the public key. */
    private static PublicKey pub;
    private static String kid;
    private static long seq;
    private static File log;
    private static volatile boolean draining;

    static File dir(M5 app) { return new File(app.vault.dir(), "lockbox"); }
    static File filesDir(M5 app) { return new File(dir(app), "files"); }

    /** Locked in the receiving mode: what would be stored goes into the inbox. */
    public static boolean active() { synchronized (LOCK) { return pub != null; } }

    /** The unlock is merging the inbox (a new lock waits — the data key is needed until it is done). */
    public static boolean draining() { return draining; }

    /**
     * At a lock, with the data key still there: a new generation — its private
     * key sealed by the data key and on the disk before that key goes.
     */
    static boolean begin(M5 app) {
        try {
            KeyPair kp = LockBox.newKeyPair();
            String k = LockBox.kid(kp.getPublic());
            byte[] pkcs8 = kp.getPrivate().getEncoded();
            byte[] wrapped;
            try { wrapped = LockBox.wrapKey(app.vault.userKey(), k, pkcs8); } finally { Crypto.wipe(pkcs8); }
            Vault.writeDurable(new File(dir(app), k + ".key"), wrapped);
            synchronized (LOCK) { pub = kp.getPublic(); kid = k; seq = 0; log = new File(dir(app), k + ".log"); }
            return true;
        } catch (GeneralSecurityException | IOException | RuntimeException e) {
            Log.e("lock", "the lock inbox could not start", e);
            return false;
        }
    }

    /** At the unlock (and a wipe): nothing more is sealed (what comes now is stored the usual way). */
    public static void close() { synchronized (LOCK) { pub = null; kid = null; log = null; seq = 0; } }

    /** Seals one item into the open generation; false when none is open or it could not be written. */
    private static boolean seal(JSONObject item) {
        synchronized (LOCK) {
            if (pub == null) return false;
            try {
                LockBox.append(log, LockBox.seal(pub, kid, ++seq, Crypto.utf8(item.toString())));
                return true;
            } catch (GeneralSecurityException | IOException | RuntimeException e) {
                Log.w("lock", "an item could not go into the lock inbox: " + e.getClass().getSimpleName());
                return false;
            }
        }
    }

    private static JSONObject item(String type, Object... kv) {
        JSONObject o = new JSONObject();
        try {
            o.put("t", type);
            for (int i = 0; i + 1 < kv.length; i += 2) o.put(String.valueOf(kv[i]), kv[i + 1]);
        } catch (JSONException ignored) { }
        return o;
    }

    static boolean message(String roomKey, ChatMessage m) { return seal(item("msg", "room", roomKey, "m", m.toJson())); }

    static boolean state(String roomKey, String id, String who, String name, String state) {
        return seal(item("state", "room", roomKey, "id", id, "who", who == null ? "" : who, "name", name == null ? "" : name, "state", state));
    }

    static boolean pin(String slot, String keyId) { return seal(item("pin", "slot", slot, "kid", keyId)); }

    static boolean resume(String roomKey, String peerId, String secret) { return seal(item("resume", "room", roomKey, "peerId", peerId, "secret", secret)); }

    static boolean call(JSONObject entry) { return seal(item("call", "e", entry)); }

    static boolean callUri(String id, String uri) { return seal(item("callUri", "id", id, "uri", uri)); }

    private static String partName(String id) { return id.replaceAll("[^A-Za-z0-9_.-]", "_") + ".part"; }

    /**
     * A received file while locked (Files.finish, already checked in full):
     * its slots file moves into the inbox (still encrypted under the transfer
     * key) and the item carries that key. False when the inbox is not open —
     * the caller then stores it the usual way (the slots file untouched).
     */
    static boolean keepFile(M5 app, String roomKey, String id, byte[] key, File tmp, RandomAccessFile slots,
                            int chunkSize, int total, long size, int[] lengths, String root) {
        synchronized (LOCK) {
            if (pub == null) return false;
            File dest = new File(filesDir(app), partName(id));
            try {
                slots.getFD().sync();
                //noinspection ResultOfMethodCallIgnored
                dest.getParentFile().mkdirs();
                if (!tmp.renameTo(dest)) return false;
                Vault.syncDir(dest.getParentFile());
                JSONArray lens = new JSONArray();
                for (int i = 0; i < total; i++) lens.put(lengths[i]);
                if (seal(item("file", "room", roomKey, "id", id, "key", Crypto.b64(key), "chunkSize", chunkSize, "total", total, "size", size, "lengths", lens, "root", root))) {
                    try { slots.close(); } catch (IOException ignored) { }
                    return true;
                }
                //noinspection ResultOfMethodCallIgnored
                dest.renameTo(tmp);
                return false;
            } catch (IOException | RuntimeException e) {
                Log.w("lock", "a file could not be kept for the unlock: " + e.getClass().getSimpleName());
                if (dest.exists() && !tmp.exists()) //noinspection ResultOfMethodCallIgnored
                    dest.renameTo(tmp);
                return false;
            }
        }
    }

    /* ======================================================== the unlock */

    /** Generations on the disk (from this lock, or one a crash left behind). */
    static boolean pending(M5 app) {
        File[] keys = dir(app).listFiles((d, n) -> n.endsWith(".key"));
        return keys != null && keys.length > 0;
    }

    /** What a drain does with the items, grouped (pure; LockedRoomsTest). */
    static final class Parsed {
        final Map<String, List<JSONObject>> rooms = new LinkedHashMap<>();
        final Map<String, String> pins = new LinkedHashMap<>();
        final Map<String, String[]> resumes = new LinkedHashMap<>();
        final List<JSONObject> calls = new ArrayList<>();
        final Map<String, String> callUris = new LinkedHashMap<>();
        final List<JSONObject> files = new ArrayList<>();
        int unknown;
    }

    static Parsed parse(List<byte[]> opened) {
        Parsed p = new Parsed();
        for (byte[] b : opened) {
            JSONObject o;
            try { o = new JSONObject(Crypto.str(b)); } catch (JSONException e) { p.unknown++; continue; }
            switch (o.optString("t")) {
                case "msg": case "state": {
                    String room = o.optString("room");
                    if (room.isEmpty()) { p.unknown++; break; }
                    List<JSONObject> l = p.rooms.get(room);
                    if (l == null) { l = new ArrayList<>(); p.rooms.put(room, l); }
                    l.add(o);
                    break;
                }
                case "pin": if (!o.optString("slot").isEmpty() && !o.optString("kid").isEmpty() && !p.pins.containsKey(o.optString("slot"))) p.pins.put(o.optString("slot"), o.optString("kid")); break;
                case "resume": p.resumes.put(o.optString("room"), new String[]{o.optString("peerId"), o.optString("secret")}); break;
                case "call": if (o.optJSONObject("e") != null) p.calls.add(o.optJSONObject("e")); break;
                case "callUri": p.callUris.put(o.optString("id"), o.optString("uri")); break;
                case "file": p.files.add(o); break;
                default: p.unknown++;
            }
        }
        return p;
    }

    /** The longest message id kept (Payloads.ID). */
    private static final int ID_MAX = 96;

    /** A message of the inbox as the history would keep it — or null when it is not one (the normal checks). */
    static ChatMessage valid(JSONObject o, String roomKey, long now) {
        if (o == null) return null;
        ChatMessage m = ChatMessage.fromJson(o);
        if (m.id == null || m.id.isEmpty() || m.id.length() > ID_MAX) return null;
        if (!"text".equals(m.kind) && !"note".equals(m.kind)) return null; // a system line is not kept in a history
        if (m.text != null && m.text.length() > 200_000) return null;
        m.roomKey = roomKey;
        if (m.createdAt > now + Payloads.FUTURE_SKEW) m.createdAt = now + Payloads.FUTURE_SKEW;
        return m;
    }

    /**
     * A room's history with the inbox's items for it, in their order: a
     * message by its id — a new one appended, a known one replaced in its
     * place by its newer state; a state raises a message of mine (as
     * RoomSession.raiseMine / applyReceipt would have). Pure.
     */
    static List<ChatMessage> merge(List<ChatMessage> history, String roomKey, List<JSONObject> items, long now) {
        LinkedHashMap<String, ChatMessage> byId = new LinkedHashMap<>();
        for (ChatMessage m : history) if (m.id != null && !byId.containsKey(m.id)) byId.put(m.id, m);
        for (JSONObject it : items) {
            if ("msg".equals(it.optString("t"))) {
                ChatMessage m = valid(it.optJSONObject("m"), roomKey, now);
                if (m != null) byId.put(m.id, m); // put keeps a known id's place
            } else if ("state".equals(it.optString("t"))) {
                ChatMessage m = byId.get(it.optString("id"));
                String state = it.optString("state"), who = it.optString("who");
                if (m == null || !m.mine || ChatMessage.rank(state) < 0) continue;
                String key = who.isEmpty() ? "relay" : who;
                try { if (ChatMessage.rank(state) > ChatMessage.rank(m.receipts.optString(key, ""))) m.receipts.put(key, state); } catch (JSONException ignored) { }
                m.raise(state, it.optString("name").isEmpty() ? key : it.optString("name"));
            }
        }
        return new ArrayList<>(byId.values());
    }

    /**
     * At the unlock (the data key back), instead of Rooms.load: stops sealing,
     * reads the saved rooms, and — when a generation is on the disk — merges
     * them on a background thread first; the rooms' lists get their histories
     * after it (a room connected now waits for it too: Rooms.connect).
     */
    public static void unlocked(M5 app, Rooms rooms) {
        close();
        boolean pend = pending(app);
        if (pend) draining = true;
        rooms.load();
        if (!pend) { rooms.restoreAll(); return; }
        cz.m5cet.app.core.Io.bg(() -> {
            try { drain(app, rooms); }
            catch (RuntimeException e) { Log.e("lock", "the lock inbox could not be merged (it stays for the next unlock)", e); }
            finally { draining = false; rooms.restoreAll(); }
        });
    }

    private static void drain(M5 app, Rooms rooms) {
        byte[] dek;
        try { dek = app.vault.userKey(); } catch (GeneralSecurityException e) { return; }
        File[] keys = dir(app).listFiles((d, n) -> n.endsWith(".key"));
        if (keys == null) return;
        // The older lock first (a newer state of a message wins).
        java.util.Arrays.sort(keys, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
        int items = 0, failed = 0;
        boolean all = true;
        for (File keyFile : keys) {
            String k = keyFile.getName().substring(0, keyFile.getName().length() - 4);
            File logFile = new File(dir(app), k + ".log");
            byte[] wrapped;
            try { wrapped = java.nio.file.Files.readAllBytes(keyFile.toPath()); }
            catch (IOException e) { Log.w("lock", "the lock inbox could not be read now: " + e.getMessage()); all = false; continue; }
            PrivateKey priv;
            try { priv = LockBox.unwrapKey(dek, k, wrapped); }
            catch (GeneralSecurityException e) {
                // Not sealed by this vault's key (damaged, or another install's): nothing of it can be read, ever.
                Log.w("lock", "a lock inbox generation cannot be opened — removed");
                //noinspection ResultOfMethodCallIgnored
                keyFile.delete();
                //noinspection ResultOfMethodCallIgnored
                logFile.delete();
                continue;
            }
            LockBox.Opened opened;
            try { opened = LockBox.openAll(priv, k, LockBox.read(logFile)); }
            catch (IOException e) { Log.w("lock", "the lock inbox could not be read now: " + e.getMessage()); all = false; continue; }
            items += opened.items.size();
            failed += opened.failed;
            apply(app, rooms, parse(opened.items));
            //noinspection ResultOfMethodCallIgnored
            logFile.delete();
            //noinspection ResultOfMethodCallIgnored
            keyFile.delete();
        }
        // Kept files no item named any more (a failed store, a crash between the steps): gone once every generation is.
        File[] left = all ? filesDir(app).listFiles() : null;
        if (left != null) for (File f : left) //noinspection ResultOfMethodCallIgnored
            f.delete();
        Log.i("lock", "the lock inbox merged: " + items + " items" + (failed > 0 ? ", " + failed + " unreadable" : ""));
    }

    /** Everything of one generation into the stores (each step harmless when done twice). */
    private static void apply(M5 app, Rooms rooms, Parsed p) {
        Set<String> badFiles = new HashSet<>();
        for (JSONObject f : p.files) if (!storeFile(app, f)) badFiles.add(f.optString("id"));
        long now = System.currentTimeMillis();
        for (Map.Entry<String, List<JSONObject>> e : p.rooms.entrySet()) {
            if (rooms.savedRoom(e.getKey()) == null) continue; // a room no longer saved here
            History.merge(app, e.getKey(), e.getValue(), now, badFiles);
        }
        rooms.mergePins(p.pins);
        for (Map.Entry<String, String[]> r : p.resumes.entrySet()) Resume.save(app, r.getKey(), r.getValue()[0], r.getValue()[1]);
        for (JSONObject c : p.calls) CallHistory.addOnce(app, CallHistory.Entry.fromJson(c));
        for (Map.Entry<String, String> u : p.callUris.entrySet()) CallHistory.setSysUri(app, u.getKey(), u.getValue());
        if (!badFiles.isEmpty()) rooms.filesLost(badFiles);
    }

    /** A kept file into the vault (unless it is there already). */
    private static boolean storeFile(M5 app, JSONObject f) {
        String id = f.optString("id");
        File part = new File(filesDir(app), partName(id));
        try {
            if (FileVault.has(app, id)) return true;
            if (!part.exists()) return false;
            JSONArray lens = f.optJSONArray("lengths");
            int total = f.optInt("total");
            if (lens == null || lens.length() != total || total < 1) return false;
            int[] lengths = new int[total];
            for (int i = 0; i < total; i++) lengths[i] = lens.optInt(i);
            byte[] key = Crypto.unb64(f.optString("key"));
            FileVault.Writer w = new FileVault.Writer(app, id);
            try (RandomAccessFile slots = new RandomAccessFile(part, "r")) {
                Files.decryptSlots(slots, key, id, total, f.optInt("chunkSize"), lengths, f.optLong("size"), f.optString("root"), w);
                w.close();
            } catch (IOException | GeneralSecurityException | RuntimeException e) {
                w.abort();
                throw e;
            } finally {
                Crypto.wipe(key);
            }
            //noinspection ResultOfMethodCallIgnored
            part.delete();
            return true;
        } catch (IOException | GeneralSecurityException | RuntimeException e) {
            Log.w("lock", "a file kept while locked could not be stored: " + e.getClass().getSimpleName());
            return false;
        }
    }

    /** For the merge of a room's history: messages whose kept file could not be stored say so. */
    static void markLostFiles(List<ChatMessage> list, Set<String> badFiles) {
        if (badFiles == null || badFiles.isEmpty()) return;
        for (ChatMessage m : list) if (m.filePath != null && badFiles.contains(m.filePath) && !m.mine) { m.filePath = null; m.fileProgress = -2; }
    }
}
