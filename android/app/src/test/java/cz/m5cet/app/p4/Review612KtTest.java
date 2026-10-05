package cz.m5cet.app.p4;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

/**
 * 6.12 security review P05 (docs/review-612.md): a server that will not
 * prove two tree heads it signed consistent raises the key-transparency
 * alert — it cannot suppress it by refusing; a server that cannot be reached
 * is asked again, and the alert comes when the proof is still missing after
 * a day.
 */
public class Review612KtTest {
    static final String S = "https://chat.example";
    final byte[] seed = new byte[32];
    final List<byte[]> leaves = new ArrayList<>();
    long clock = 1_800_000_000_000L;

    public Review612KtTest() throws Exception {
        seed[0] = 0x17;
        for (int i = 0; i < 4; i++) {
            leaves.add(Kt.entryLeafHash(new JSONObject().put("t", "acct").put("u", Kt.user("u" + i)).put("apk", Prim.b64(new byte[32])).put("ts", i)));
        }
    }

    JSONObject head(int size, long ts) throws Exception { return Kt.signSth(seed, size, Merkle.treeHash(leaves, 0, size), ts); }

    Kt.ConsistencyFetcher honest() {
        return (from, to) -> {
            JSONArray proof = new JSONArray();
            for (byte[] p : Merkle.consistencyProof(leaves, (int) from, (int) to)) proof.put(Prim.b64(p));
            return new JSONObject().put("from", from).put("to", to).put("proof", proof);
        };
    }

    Kt.State state() throws Exception {
        Kt.State kt = new Kt.State(null, () -> clock);
        kt.pinKey(S, Prim.b64(Prim.ed25519Public(seed)));
        assertEquals("ok", kt.update(S, head(2, 1), honest()).status);
        return kt;
    }

    @Test
    public void aServerThatRefusesTheProofRaisesTheAlert() throws Exception {
        Kt.State kt = state();
        // A peer saw a tree of 3 that is not ours (another history, signed by the same key); the server answers the
        // consistency request with an error (HTTP 400) — the split-view alert, not silence.
        JSONObject fork = Kt.signSth(seed, 3, new byte[32], 2);
        assertEquals("need-consistency", kt.gossip(S, fork).status);
        Kt.ConsistencyFetcher refusing = (from, to) -> { throw new java.io.IOException("400 bad-request"); };
        assertEquals("split-view", kt.resolveGossip(S, fork, refusing).status);
        assertEquals("split-view", kt.alert(S).kind);
        // The same for a head of the server itself.
        Kt.State own = state();
        assertEquals("inconsistent", own.update(S, head(4, 3), refusing).status);
        assertEquals("inconsistent", own.alert(S).kind);
    }

    @Test
    public void anUnreachableServerIsAskedAgainAndAlertedAfterADay() throws Exception {
        Kt.State kt = state();
        Kt.ConsistencyFetcher offline = (from, to) -> { throw new Kt.Unreachable(new java.io.IOException("no route")); };
        // The network: no alert yet, the head waits for its proof (persistently).
        assertEquals("pending", kt.update(S, head(4, 3), offline).status);
        assertNull(kt.alert(S));
        assertEquals(1, kt.pendingCount(S));
        assertEquals(2, kt.newest(S).optLong("size"));
        // Back online: the proof comes, the head is kept, nothing waits.
        assertEquals("ok", kt.retryPending(S, honest()).status);
        assertEquals(0, kt.pendingCount(S));
        assertEquals(4, kt.newest(S).optLong("size"));
        assertNull(kt.alert(S));

        // A gossiped fork while offline, still unproven a day later: the alert.
        Kt.State other = state();
        JSONObject fork = Kt.signSth(seed, 3, new byte[32], 2);
        assertEquals("pending", other.resolveGossip(S, fork, offline).status);
        clock += 12 * 3600_000L;
        assertEquals("pending", other.retryPending(S, offline).status);
        assertNull(other.alert(S));
        clock += 13 * 3600_000L;
        assertEquals("unproven", other.retryPending(S, offline).status);
        assertEquals("unproven", other.alert(S).kind);
        // When it can be asked, the fork is what it is: refused → split view (the first alert stays until dismissed).
        other.dismissAlert(S);
        assertEquals("split-view", other.retryPending(S, (from, to) -> { throw new java.io.IOException("400"); }).status);
        assertEquals("split-view", other.alert(S).kind);
        assertEquals(0, other.pendingCount(S));
    }

    @Test
    public void thePendingRecordSurvivesARestart() throws Exception {
        Kt.MemoryStore store = new Kt.MemoryStore();
        Kt.State kt = new Kt.State(store, () -> clock);
        kt.pinKey(S, Prim.b64(Prim.ed25519Public(seed)));
        kt.update(S, head(2, 1), honest());
        kt.update(S, head(4, 3), (from, to) -> { throw new Kt.Unreachable(null); });
        Kt.OriginState back = Kt.OriginState.parse(store.get(S).json());
        assertEquals(1, back.pending.length());
        Kt.State again = new Kt.State(store, () -> clock + 2 * 24 * 3600_000L);
        assertEquals("unproven", again.retryPending(S, (from, to) -> { throw new Kt.Unreachable(null); }).status);
        assertTrue(again.alert(S) != null);
    }
}
