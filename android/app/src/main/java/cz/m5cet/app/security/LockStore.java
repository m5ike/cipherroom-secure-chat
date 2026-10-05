package cz.m5cet.app.security;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Iterator;
import java.util.Set;

/**
 * 6.12 (security analysis F-16): the unlock-attempt counter bound to the
 * Keystore, so that putting back an older copy of the vault's files does not
 * give the attempts back.
 *
 * The record (LockCounter's fields) is sealed with an HMAC by a Keystore key
 * of one generation (m5.ctr.N), and the generation is in the record. Every
 * write makes a key of the next generation, seals with it, writes the record
 * durably (file and directory synced) and only then deletes the older keys.
 * A copy of an older record names a generation whose key is gone — that is a
 * rollback, and a rollback counts as every attempt used (AppLock: the wipe or
 * the lock-out of the policy). Deleting the record while a key exists is one
 * too. The Keystore's keys cannot be put back by copying the app's files.
 *
 * Not a defence against code running as the app (it can use the keys like
 * the app does) — that needs the secure hardware's own attempt limit, which
 * Android does not offer an app for a PIN of its own (docs/security-analysis.md).
 *
 * Upgrade: a pre-6.12 record (no generation, no key yet) is taken as it is —
 * its attempts stay — and sealed at its next write. The first seal marks the
 * record ("mig": the generation it is about to get) before it makes the key,
 * so a stop between the two is not taken for a rollback.
 *
 * Pure (the Keystore and the vault are interfaces): LockStoreTest runs every
 * order of a stop between the steps.
 */
final class LockStore {
    /** The Keystore side. */
    interface Anchor {
        /** The generations whose keys exist now; null when the Keystore cannot be read. */
        Set<Long> generations();
        /** Makes the key of this generation; false when it could not. */
        boolean create(long gen);
        void delete(long gen);
        /** HMAC-SHA256 by that generation's key; null when it cannot. */
        byte[] mac(long gen, byte[] data);
    }

    /** The vault side (the system tier's "lock" record). */
    interface Records {
        /**
         * The record; {} when there is none; null when it cannot be read now
         * (the vault's key or the storage is not available — nothing is
         * decided then). A record that does not open (its authentication
         * fails, it is not JSON) comes as {"unreadable": true}: changed by
         * someone, so not a record of ours.
         */
        JSONObject read();
        /** Durably (synced file and directory); false when it could not be written. */
        boolean write(JSONObject record);
    }

    enum Verdict {
        /** Sealed and current. */
        OK,
        /** Before 6.12 (or before the first write): no key yet, taken as it is. */
        LEGACY,
        /** The Keystore cannot say now: taken as it is (the next write needs it, so no attempt is checked meanwhile). */
        UNVERIFIED,
        /** An older copy, a deleted record or a forged one: every attempt counts as used. */
        ROLLBACK
    }

    static final class View {
        final JSONObject state;
        final Verdict verdict;
        View(JSONObject state, Verdict verdict) { this.state = state; this.verdict = verdict; }
    }

    static final String GEN = "g", MAC = "mac", MIG = "mig", UNREADABLE = "unreadable";

    private final Anchor anchor;
    private final Records records;

    LockStore(Anchor anchor, Records records) { this.anchor = anchor; this.records = records; }

    /** The counter's fields without the seal (what LockCounter works with). */
    static JSONObject fields(JSONObject r) {
        JSONObject out = new JSONObject();
        for (Iterator<String> it = r.keys(); it.hasNext(); ) {
            String k = it.next();
            if (k.equals(GEN) || k.equals(MAC) || k.equals(MIG) || k.equals(UNREADABLE)) continue;
            try { out.put(k, r.opt(k)); } catch (JSONException ignored) { }
        }
        return out;
    }

    /**
     * What the seal covers: the generation and every field that decides
     * (attempts, the wait, a pending attempt), in a fixed order.
     */
    static byte[] canonical(JSONObject r, long gen) {
        return Crypto.utf8("m5/lock/1|" + gen + "|" + r.optInt("attempts", 0) + "|" + r.optLong("until", 0) + "|" + (r.has("pending") ? r.optLong("pending") : -1));
    }

    /** Reads and checks the record. */
    View load() {
        JSONObject r = records.read();
        if (r == null) return new View(new JSONObject(), Verdict.UNVERIFIED);
        Set<Long> gens = anchor.generations();
        if (gens == null) return new View(fields(r), Verdict.UNVERIFIED);
        // A record that does not open: someone changed it — but before the first seal, as before 6.12
        // (an upgrade never wipes), it reads as none.
        if (r.optBoolean(UNREADABLE)) return new View(new JSONObject(), gens.isEmpty() ? Verdict.LEGACY : Verdict.ROLLBACK);
        boolean sealed = r.has(GEN);
        if (gens.isEmpty()) {
            // No key at all: before 6.12 (or never written) — unless the record says it was sealed (its keys are gone).
            return new View(fields(r), sealed ? Verdict.ROLLBACK : Verdict.LEGACY);
        }
        if (!sealed) {
            // A first seal that stopped after making its key (the record names the generation it was getting).
            if (r.has(MIG) && gens.contains(r.optLong(MIG, -1))) return new View(fields(r), Verdict.LEGACY);
            return new View(fields(r), Verdict.ROLLBACK);
        }
        long g = r.optLong(GEN, -1);
        if (!gens.contains(g)) return new View(fields(r), Verdict.ROLLBACK);
        byte[] want = anchor.mac(g, canonical(r, g));
        if (want == null) return new View(fields(r), Verdict.UNVERIFIED);
        byte[] have;
        try { have = Crypto.unb64(r.optString(MAC, "")); } catch (IllegalArgumentException e) { have = new byte[0]; }
        return new View(fields(r), Crypto.same(want, have) ? Verdict.OK : Verdict.ROLLBACK);
    }

    /**
     * Writes the counter's state, sealed by a new generation; the older keys
     * go after the record is on the disk. False when it could not be written
     * (AppLock then checks no PIN). A phone whose Keystore makes no key at all
     * keeps the unsealed record (as before 6.12); one that cannot make a new
     * one seals with the generation it has.
     */
    boolean save(JSONObject state) {
        Set<Long> gens = anchor.generations();
        if (gens == null) return false;
        long cur = -1;
        for (long g : gens) cur = Math.max(cur, g);
        long next = cur < 0 ? 1 : cur + 1;
        JSONObject plain = fields(state);
        if (cur < 0) {
            // The first seal: say so in the record before the key exists.
            try {
                JSONObject marked = fields(state).put(MIG, next);
                if (!records.write(marked)) return false;
            } catch (JSONException e) { return false; }
            if (!anchor.create(next)) return true; // no Keystore key on this phone: the unsealed record stays
        } else if (!anchor.create(next)) {
            next = cur; // no new key now: sealed with the one there is (no rotation this time)
        }
        byte[] mac = anchor.mac(next, canonical(plain, next));
        if (mac == null) {
            if (next != cur) anchor.delete(next);
            return false;
        }
        try {
            JSONObject sealed = fields(state).put(GEN, next).put(MAC, Crypto.b64(mac));
            if (!records.write(sealed)) {
                if (next != cur) anchor.delete(next);
                return false;
            }
        } catch (JSONException e) {
            return false;
        }
        for (long g : gens) if (g != next) anchor.delete(g);
        return true;
    }
}
