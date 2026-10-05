package cz.m5cet.app.security;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * 6.12 (security analysis F-16): the attempt counter sealed by a Keystore
 * key that changes with every write — an older copy of the counter (or none)
 * is a rollback; an upgrade from 6.11 never is; a stop between any two steps
 * of a write is not one either.
 */
public class LockStoreTest {
    /** The Keystore: keys by generation (each a random HMAC key), and switches to make it fail. */
    static final class Keys implements LockStore.Anchor {
        final Map<Long, byte[]> keys = new HashMap<>();
        boolean unreadable, noCreate, noMac;
        /** Stops (throws) right after the n-th create, or at the n-th delete before it happens — a process killed there. */
        int dieAfterCreate = -1, dieAtDelete = -1;
        int creates, deletes;

        @Override public Set<Long> generations() { return unreadable ? null : new HashSet<>(keys.keySet()); }
        @Override public boolean create(long gen) {
            if (noCreate) return false;
            keys.put(gen, Crypto.random(32));
            if (++creates == dieAfterCreate) throw new Died();
            return true;
        }
        @Override public void delete(long gen) {
            if (++deletes == dieAtDelete) throw new Died();
            keys.remove(gen);
        }
        @Override public byte[] mac(long gen, byte[] data) {
            byte[] k = keys.get(gen);
            return noMac || k == null ? null : Crypto.hmac256(k, data);
        }
    }

    /** The vault's record. */
    static final class Disk implements LockStore.Records {
        JSONObject record = new JSONObject();
        boolean unavailable, noWrite;
        int dieAfterWrite = -1, writes;

        @Override public JSONObject read() {
            if (unavailable) return null;
            try { return new JSONObject(record.toString()); } catch (Exception e) { throw new IllegalStateException(e); }
        }
        @Override public boolean write(JSONObject r) {
            if (noWrite) return false;
            try { record = new JSONObject(r.toString()); } catch (Exception e) { throw new IllegalStateException(e); }
            if (++writes == dieAfterWrite) throw new Died();
            return true;
        }
    }

    static final class Died extends RuntimeException { }

    private static JSONObject state(int attempts) throws Exception { return new JSONObject().put("attempts", attempts).put("until", 0); }

    private static JSONObject copy(JSONObject o) throws Exception { return new JSONObject(o.toString()); }

    @Test
    public void anUpgradeKeepsTheAttemptsAndIsSealedAtItsNextWrite() throws Exception {
        Keys keys = new Keys();
        Disk disk = new Disk();
        disk.record = state(3).put("last", 1L); // a 6.11 record: no generation, no key
        LockStore s = new LockStore(keys, disk);
        LockStore.View v = s.load();
        assertEquals(LockStore.Verdict.LEGACY, v.verdict);
        assertEquals(3, v.state.optInt("attempts"));
        // The next attempt is written sealed: generation 1, the attempts kept.
        JSONObject next = v.state;
        LockCounter.begin(next, 10);
        assertTrue(s.save(next));
        assertEquals(1, disk.record.optLong(LockStore.GEN));
        assertFalse(disk.record.has(LockStore.MIG));
        assertEquals(Set.of(1L), keys.keys.keySet());
        v = s.load();
        assertEquals(LockStore.Verdict.OK, v.verdict);
        assertEquals(4, v.state.optInt("attempts"));
        assertTrue(LockCounter.interrupted(v.state));
        // No record at all before 6.12 (never failed): nothing used.
        LockStore fresh = new LockStore(new Keys(), new Disk());
        assertEquals(LockStore.Verdict.LEGACY, fresh.load().verdict);
        assertEquals(0, fresh.load().state.optInt("attempts"));
    }

    @Test
    public void aFirstSealStoppedHalfwayIsNoRollback() throws Exception {
        for (int stop = 1; stop <= 2; stop++) {
            Keys keys = new Keys();
            Disk disk = new Disk();
            disk.record = state(2);
            LockStore s = new LockStore(keys, disk);
            // stop 1: after the record is marked (before the key); stop 2: after the key (before the seal).
            if (stop == 1) disk.dieAfterWrite = 1; else keys.dieAfterCreate = 1;
            try { s.save(state(3)); } catch (Died expected) { }
            disk.dieAfterWrite = -1;
            keys.dieAfterCreate = -1;
            LockStore.View v = s.load();
            assertEquals("stop " + stop, LockStore.Verdict.LEGACY, v.verdict);
            assertEquals("stop " + stop, 3, v.state.optInt("attempts"));
            assertTrue(s.save(state(4)));
            assertEquals(LockStore.Verdict.OK, s.load().verdict);
            assertEquals(1, keys.keys.size());
        }
    }

    @Test
    public void everyWriteRotatesAndAnOlderCopyIsARollback() throws Exception {
        Keys keys = new Keys();
        Disk disk = new Disk();
        LockStore s = new LockStore(keys, disk);
        assertTrue(s.save(state(1)));
        JSONObject first = copy(disk.record);
        assertTrue(s.save(state(2)));
        JSONObject second = copy(disk.record);
        assertTrue(s.save(state(5)));
        assertEquals(Set.of(3L), keys.keys.keySet()); // one generation at a time
        assertEquals(LockStore.Verdict.OK, s.load().verdict);
        // The vault's files put back from earlier: their generations' keys are gone.
        for (JSONObject old : new JSONObject[]{first, second}) {
            disk.record = copy(old);
            LockStore.View v = s.load();
            assertEquals(LockStore.Verdict.ROLLBACK, v.verdict);
        }
        // A 6.11-style record (no seal) put back after the first seal: a rollback too.
        disk.record = state(0);
        assertEquals(LockStore.Verdict.ROLLBACK, s.load().verdict);
        // The record deleted while a key exists.
        disk.record = new JSONObject();
        assertEquals(LockStore.Verdict.ROLLBACK, s.load().verdict);
        // An edited record (fewer attempts) with the current generation: the seal does not match.
        assertTrue(s.save(state(6)));
        JSONObject edited = copy(disk.record).put("attempts", 0);
        disk.record = edited;
        assertEquals(LockStore.Verdict.ROLLBACK, s.load().verdict);
        // …and a record that does not open (its vault seal failed).
        disk.record = new JSONObject().put(LockStore.UNREADABLE, true);
        assertEquals(LockStore.Verdict.ROLLBACK, s.load().verdict);
    }

    @Test
    public void aStopBetweenTheStepsOfAWriteIsNoRollback() throws Exception {
        // After the new key (before the record), and after the record (before the old key's deletion).
        for (int stop = 1; stop <= 2; stop++) {
            Keys keys = new Keys();
            Disk disk = new Disk();
            LockStore s = new LockStore(keys, disk);
            assertTrue(s.save(state(1)));
            assertTrue(s.save(state(2)));
            if (stop == 1) keys.dieAfterCreate = keys.creates + 1; else keys.dieAtDelete = keys.deletes + 1;
            try { s.save(state(3)); } catch (Died expected) { }
            keys.dieAfterCreate = -1;
            keys.dieAtDelete = -1;
            assertEquals("stop " + stop + ": two generations meanwhile", 2, keys.keys.size());
            LockStore.View v = s.load();
            assertEquals("stop " + stop, LockStore.Verdict.OK, v.verdict);
            assertEquals("stop " + stop, stop == 1 ? 2 : 3, v.state.optInt("attempts"));
            // The next write tidies up: one generation again.
            assertTrue(s.save(state(4)));
            assertEquals(1, keys.keys.size());
            assertEquals(LockStore.Verdict.OK, s.load().verdict);
        }
    }

    @Test
    public void aKeystoreThatCannotSayDecidesNothing() throws Exception {
        Keys keys = new Keys();
        Disk disk = new Disk();
        LockStore s = new LockStore(keys, disk);
        assertTrue(s.save(state(2)));
        keys.unreadable = true;
        assertEquals(LockStore.Verdict.UNVERIFIED, s.load().verdict);
        assertEquals(2, s.load().state.optInt("attempts"));
        assertFalse("not stored → not checked", s.save(state(3)));
        keys.unreadable = false;
        keys.noMac = true;
        assertEquals(LockStore.Verdict.UNVERIFIED, s.load().verdict);
        assertFalse(s.save(state(3)));
        assertEquals("the key made for the failed write is gone again", 1, keys.keys.size());
        keys.noMac = false;
        // The vault cannot be read now (its key, the storage): nothing decided either.
        disk.unavailable = true;
        assertEquals(LockStore.Verdict.UNVERIFIED, s.load().verdict);
        disk.unavailable = false;
        disk.noWrite = true;
        assertFalse(s.save(state(3)));
        disk.noWrite = false;
        assertEquals(LockStore.Verdict.OK, s.load().verdict);
        assertEquals(2, s.load().state.optInt("attempts"));
    }

    @Test
    public void withoutNewKeysItStillCounts() throws Exception {
        // No Keystore key can be made at all: the record stays unsealed, as before 6.12.
        Keys none = new Keys();
        none.noCreate = true;
        Disk disk = new Disk();
        LockStore s = new LockStore(none, disk);
        assertTrue(s.save(state(4)));
        assertEquals(LockStore.Verdict.LEGACY, s.load().verdict);
        assertEquals(4, s.load().state.optInt("attempts"));
        // Keys exist but no new one now: sealed with the one there is.
        Keys keys = new Keys();
        Disk d2 = new Disk();
        LockStore s2 = new LockStore(keys, d2);
        assertTrue(s2.save(state(1)));
        keys.noCreate = true;
        assertTrue(s2.save(state(2)));
        assertEquals(1, d2.record.optLong(LockStore.GEN));
        assertEquals(LockStore.Verdict.OK, s2.load().verdict);
        assertEquals(2, s2.load().state.optInt("attempts"));
    }

    @Test
    public void keysGoneWithASealedRecordIsARollback() throws Exception {
        Keys keys = new Keys();
        Disk disk = new Disk();
        LockStore s = new LockStore(keys, disk);
        assertTrue(s.save(state(1)));
        keys.keys.clear();
        assertEquals(LockStore.Verdict.ROLLBACK, s.load().verdict);
        // An unreadable record before the first seal reads as none (an upgrade never wipes).
        Disk d2 = new Disk();
        d2.record = new JSONObject().put(LockStore.UNREADABLE, true);
        assertEquals(LockStore.Verdict.LEGACY, new LockStore(new Keys(), d2).load().verdict);
    }

    @Test
    public void theSealCoversWhatDecides() throws Exception {
        JSONObject a = state(3).put("pending", 5L).put("last", 7L);
        byte[] base = LockStore.canonical(a, 4);
        assertNotEquals(new String(base), new String(LockStore.canonical(copy(a).put("attempts", 2), 4)));
        assertNotEquals(new String(base), new String(LockStore.canonical(copy(a).put("until", 99L), 4)));
        assertNotEquals(new String(base), new String(LockStore.canonical(new JSONObject(a.toString()).put("pending", 6L), 4)));
        JSONObject noPending = copy(a);
        noPending.remove("pending");
        assertNotEquals(new String(base), new String(LockStore.canonical(noPending, 4)));
        assertNotEquals(new String(base), new String(LockStore.canonical(a, 5)));
        // "last" is only informative.
        assertEquals(new String(base), new String(LockStore.canonical(copy(a).put("last", 8L), 4)));
        // The seal's own fields are not part of the counter's state.
        JSONObject sealed = copy(a).put(LockStore.GEN, 4).put(LockStore.MAC, "x").put(LockStore.MIG, 4);
        assertFalse(LockStore.fields(sealed).has(LockStore.GEN));
        assertFalse(LockStore.fields(sealed).has(LockStore.MAC));
        assertFalse(LockStore.fields(sealed).has(LockStore.MIG));
        assertEquals(3, LockStore.fields(sealed).optInt("attempts"));
    }

    @Test
    public void aRollbackUsesEveryAttempt() throws Exception {
        for (int max : new int[]{3, 8, 20}) {
            JSONObject s = LockCounter.rolledBack(max);
            assertEquals(LockCounter.Outcome.WIPE, LockCounter.settle(s, 1000, max, true, true));
            assertEquals(max, s.optInt("attempts"));
            JSONObject t = LockCounter.rolledBack(max);
            assertEquals(LockCounter.Outcome.LOCKED_OUT, LockCounter.settle(t, 1000, max, false, true));
            assertEquals(1000 + LockCounter.LOCKOUT_MS, t.optLong("until"));
        }
    }
}
