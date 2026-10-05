package cz.m5cet.app.p4;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

import cz.m5cet.app.security.Crypto;

/** test/vectors/p4.json "hubProof", "kt", "replay", "release". */
public class ServerSideVectorTest {

    @Test
    public void hubProofFromTheRoomSecret() throws Exception {
        JSONArray cases = Vectors.get().getJSONArray("hubProof");
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.getJSONObject(i);
            // RoomKeys.derive(info, n) is exactly this HKDF (salt "m5cet:v2") over the room secret.
            byte[] seed = Crypto.hkdf(Prim.unb64(c.getString("roomSecret")), Crypto.utf8("m5cet:v2"), Crypto.utf8(P4.L_HUB_SEED), 32);
            assertEquals(c.getString("seed"), Prim.b64(seed));
            assertEquals(c.getString("pub"), HubProof.pub(seed));
            assertEquals(c.getString("signedData"), Vectors.text(HubProof.joinData(c.getString("roomId"), c.getString("nonce"))));
            JSONObject proof = HubProof.build(seed, c.getString("roomId"), c.getString("nonce"));
            assertEquals(c.getString("sig"), proof.getString("sig"));
            assertEquals(c.getString("pub"), proof.getString("pub"));
            assertTrue(HubProof.verify(c.getString("pub"), c.getString("sig"), c.getString("roomId"), c.getString("nonce")));
            assertFalse(HubProof.verify(c.getString("pub"), c.getString("sig"), "r3.other", c.getString("nonce")));
        }
    }

    @Test
    public void keyTransparencyEntriesTreeProofsHeads() throws Exception {
        JSONObject K = Vectors.get().getJSONObject("kt");
        JSONArray users = K.getJSONArray("users");
        for (int i = 0; i < users.length(); i++) assertEquals(users.getJSONObject(i).getString("u"), Kt.user(users.getJSONObject(i).getString("name")));
        JSONArray entries = K.getJSONArray("entries");
        List<byte[]> leaves = new ArrayList<>();
        for (int i = 0; i < entries.length(); i++) {
            assertEquals(K.getJSONArray("leaves").getString(i), Kt.canonicalEntry(entries.getJSONObject(i)));
            byte[] h = Kt.entryLeafHash(entries.getJSONObject(i));
            assertEquals(K.getJSONArray("leafHashes").getString(i), Prim.b64(h));
            assertEquals(K.getJSONArray("leafHashes").getString(i), Prim.b64(Merkle.leafHash(K.getJSONArray("leaves").getString(i))));
            leaves.add(h);
        }
        JSONArray roots = K.getJSONArray("roots");
        for (int size = 0; size < roots.length(); size++) assertEquals(roots.getString(size), Prim.b64(Merkle.treeHash(leaves, 0, size)));
        JSONArray inclusion = K.getJSONArray("inclusion");
        for (int i = 0; i < inclusion.length(); i++) {
            JSONObject c = inclusion.getJSONObject(i);
            List<byte[]> path = Merkle.inclusionProof(leaves, c.getInt("index"), c.getInt("size"));
            assertEquals(c.getJSONArray("path").toString(), b64s(path).toString());
            assertTrue(Merkle.verifyInclusion(leaves.get(c.getInt("index")), c.getInt("index"), c.getInt("size"), decode(c.getJSONArray("path")), Prim.unb64(roots.getString(c.getInt("size")))));
            assertFalse(Merkle.verifyInclusion(leaves.get((c.getInt("index") + 1) % c.getInt("size")), c.getInt("index"), c.getInt("size"), decode(c.getJSONArray("path")), Prim.unb64(roots.getString(c.getInt("size")))) && c.getInt("size") > 1);
        }
        JSONArray consistency = K.getJSONArray("consistency");
        for (int i = 0; i < consistency.length(); i++) {
            JSONObject c = consistency.getJSONObject(i);
            List<byte[]> proof = Merkle.consistencyProof(leaves, c.getInt("from"), c.getInt("to"));
            assertEquals(c.getJSONArray("proof").toString(), b64s(proof).toString());
            assertTrue(Merkle.verifyConsistency(c.getInt("from"), c.getInt("to"), Prim.unb64(roots.getString(c.getInt("from"))), Prim.unb64(roots.getString(c.getInt("to"))), decode(c.getJSONArray("proof"))));
            if (c.getInt("from") > 0 && c.getInt("from") < c.getInt("to")) {
                byte[] wrong = Prim.unb64(roots.getString(c.getInt("from") - 1));
                assertFalse(Merkle.verifyConsistency(c.getInt("from"), c.getInt("to"), wrong, Prim.unb64(roots.getString(c.getInt("to"))), decode(c.getJSONArray("proof"))));
            }
        }
        byte[] ktSeed = Prim.unb64(K.getString("ktSeed"));
        assertEquals(K.getString("ktKey"), Prim.b64(Prim.ed25519Public(ktSeed)));
        JSONArray sths = K.getJSONArray("sth");
        for (int i = 0; i < sths.length(); i++) {
            JSONObject s = sths.getJSONObject(i);
            assertEquals(s.getString("signedData"), Vectors.text(Kt.sthData(s.getLong("size"), s.getString("root"), s.getLong("ts"))));
            assertEquals(s.getString("sig"), Kt.signSth(ktSeed, s.getLong("size"), Prim.unb64(s.getString("root")), s.getLong("ts")).getString("sig"));
            JSONObject head = new JSONObject().put("size", s.getLong("size")).put("root", s.getString("root")).put("ts", s.getLong("ts")).put("sig", s.getString("sig"));
            assertTrue(Kt.verifySth(head, K.getString("ktKey")));
            assertFalse(Kt.verifySth(new JSONObject(head.toString()).put("ts", s.getLong("ts") + 1), K.getString("ktKey")));
        }
    }

    /** The KT client state against the vector log: lookups, device status, rewritten history and split views. */
    @Test
    public void keyTransparencyState() throws Exception {
        JSONObject K = Vectors.get().getJSONObject("kt");
        byte[] ktSeed = Prim.unb64(K.getString("ktSeed"));
        JSONArray entries = K.getJSONArray("entries");
        List<byte[]> leaves = new ArrayList<>();
        for (int i = 0; i < entries.length(); i++) leaves.add(Kt.entryLeafHash(entries.getJSONObject(i)));
        Kt.ConsistencyFetcher fetch = (from, to) -> new JSONObject().put("from", from).put("to", to).put("proof", b64s(Merkle.consistencyProof(leaves, (int) from, (int) to)));
        JSONObject sth5 = Kt.signSth(ktSeed, 5, Merkle.treeHash(leaves, 0, 5), 1_800_000_100_000L);
        JSONObject sth7 = Kt.signSth(ktSeed, 7, Merkle.treeHash(leaves, 0, 7), 1_800_000_200_000L);
        Kt.State kt = new Kt.State(null, () -> 1_800_000_300_000L);
        assertEquals("no-key", kt.update("s", sth5, fetch).status);
        assertEquals("new", kt.pinKey("s", K.getString("ktKey")));
        assertEquals("match", kt.pinKey("s", K.getString("ktKey")));
        assertEquals("ok", kt.update("s", sth5, fetch).status);
        assertEquals("ok", kt.update("s", sth7, fetch).status);
        assertEquals(7, kt.newest("s").getLong("size"));
        assertEquals("ok", kt.update("s", sth5, fetch).status); // an older consistent head is fine (not kept)
        assertEquals("ok", kt.gossip("s", sth7).status);
        assertEquals("need-consistency", kt.gossip("s", sth5).status);
        assertEquals("ok", kt.resolveGossip("s", sth5, fetch).status);
        assertEquals("ignored", kt.gossip("s", Kt.signSth(new byte[32], 7, Merkle.treeHash(leaves, 0, 7), 1)).status);
        // Lookup of alice: her entries with inclusion proofs in the 7-head.
        String ua = Kt.user("alice");
        JSONArray found = new JSONArray();
        for (int i = 0; i < entries.length(); i++) {
            if (!ua.equals(entries.getJSONObject(i).getString("u"))) continue;
            found.put(new JSONObject().put("entry", entries.getJSONObject(i)).put("index", i).put("proof", b64s(Merkle.inclusionProof(leaves, i, 7))));
        }
        Kt.Checked c = kt.lookup("s", new JSONObject().put("sth", sth7).put("entries", found), ua, fetch);
        assertTrue(c.why, c.ok);
        assertEquals(found.length(), c.entries.size());
        JSONObject dev = entries.getJSONObject(2);
        // alice's account key changed (entry 6), and her device was revoked after its certificate (entry 4).
        Kt.Status st = Kt.deviceStatus(c.entries, dev.getString("apk"), dev.getString("dpk"), 1_800_000_000_000L);
        assertFalse(st.account);
        assertTrue(st.revoked);
        assertFalse(st.ok);
        assertEquals("wrong-user", Kt.verifyLookup(new JSONObject().put("sth", sth7).put("entries", found), K.getString("ktKey"), Kt.user("bob")).why);
        // bob: account and device fine.
        JSONObject bobDev = entries.getJSONObject(5);
        List<Kt.Entry> bob = Kt.verifyLookup(lookupOf(entries, leaves, sth7, Kt.user("bob")), K.getString("ktKey"), Kt.user("bob")).entries;
        assertTrue(Kt.deviceStatus(bob, bobDev.getString("apk"), bobDev.getString("dpk"), 1_800_000_000_000L).ok);
        assertFalse(Kt.deviceStatus(bob, bobDev.getString("apk"), bobDev.getString("dpk"), bobDev.getLong("exp")).ok);
        // A proof for another index does not verify.
        JSONObject wrong = new JSONObject(found.getJSONObject(0).toString()).put("index", 1);
        assertEquals("not-included", Kt.verifyLookup(new JSONObject().put("sth", sth7).put("entries", new JSONArray().put(wrong)), K.getString("ktKey"), ua).why);
        assertTrue(kt.alert("s") == null);
        // A rewritten history: another root for size 7 → a persistent alert.
        List<byte[]> forged = new ArrayList<>(leaves);
        forged.set(3, Merkle.leafHash("forged"));
        JSONObject fake7 = Kt.signSth(ktSeed, 7, Merkle.treeHash(forged, 0, 7), 1_800_000_250_000L);
        assertEquals("inconsistent", kt.update("s", fake7, fetch).status);
        assertEquals("inconsistent", kt.alert("s").kind);
        Kt.State peerView = new Kt.State(null, null);
        peerView.pinKey("t", K.getString("ktKey"));
        peerView.update("t", sth7, fetch);
        assertEquals("split-view", peerView.gossip("t", fake7).status);
        assertEquals("split-view", peerView.alert("t").kind);
        JSONObject fake9 = Kt.signSth(ktSeed, 9, new byte[32], 1_800_000_260_000L);
        Kt.State other = new Kt.State(null, null);
        other.pinKey("u", K.getString("ktKey"));
        other.update("u", sth7, fetch);
        assertEquals("inconsistent", other.update("u", fake9, (from, to) -> new JSONObject().put("from", from).put("to", to).put("proof", new JSONArray().put(Prim.b64(new byte[32])))).status);
        assertEquals("changed", kt.pinKey("s", Prim.b64(new byte[32])));
        kt.dismissAlert("s");
        assertTrue(kt.alert("s") == null);
    }

    private static JSONObject lookupOf(JSONArray entries, List<byte[]> leaves, JSONObject sth, String u) throws Exception {
        JSONArray out = new JSONArray();
        for (int i = 0; i < entries.length(); i++) {
            if (u.equals(entries.getJSONObject(i).getString("u"))) out.put(new JSONObject().put("entry", entries.getJSONObject(i)).put("index", i).put("proof", b64s(Merkle.inclusionProof(leaves, i, 7))));
        }
        return new JSONObject().put("sth", sth).put("entries", out);
    }

    static JSONArray b64s(List<byte[]> list) {
        JSONArray a = new JSONArray();
        for (byte[] b : list) a.put(Prim.b64(b));
        return a;
    }

    static List<byte[]> decode(JSONArray a) throws P4Error {
        List<byte[]> out = new ArrayList<>();
        for (int i = 0; i < a.length(); i++) out.add(Prim.unb64(a.optString(i)));
        return out;
    }

    @Test
    public void replayKeysAndGuard() throws Exception {
        JSONArray cases = Vectors.get().getJSONArray("replay");
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.getJSONObject(i);
            assertEquals(c.getString("key"), Replay.key(c.getString("roomId"), c.getString("id")));
        }
        long now = 1_800_000_000_000L;
        Replay.Guard g = new Replay.Guard(new Replay.MemoryStore(), 0);
        assertEquals("ok", g.check("r3.a", "m1", now, now, false));
        assertEquals("replay", g.check("r3.a", "m1", now, now, false));
        assertEquals("ok", g.check("r3.b", "m1", now, now, false));
        assertEquals("too-old", g.check("r3.a", "m2", now - P4.REPLAY_WINDOW_MS - 1, now, false));
        assertEquals("future", g.check("r3.a", "m3", now + P4.REPLAY_FUTURE_MS + 1, now, false));
        assertEquals("malformed", g.check("r3.a", "m|4", now, now, false));
        assertEquals("malformed", g.check("r3.a", "m5", "soon", now, false));
        assertEquals("ok", g.check("r3.a", "m1", now - P4.REPLAY_WINDOW_MS * 2, now, true)); // restored history: remembered only
    }

    @Test
    public void signedReleaseManifest() throws Exception {
        JSONObject R = Vectors.get().getJSONObject("release");
        JSONObject m = Release.parse(R.getString("manifest"));
        byte[] seed = Prim.unb64(R.getString("seed"));
        assertEquals(R.getString("publicKey"), Prim.b64(Prim.ed25519Public(seed)));
        assertEquals(R.getString("sig"), Prim.b64(Prim.ed25519Sign(seed, Prim.utf8(R.getString("manifest")))));
        assertTrue(Release.verifySignature(Prim.utf8(R.getString("manifest")), R.getString("sig"), R.getString("publicKey")));
        assertFalse(Release.verifySignature(Prim.utf8(R.getString("manifest") + " "), R.getString("sig"), R.getString("publicKey")));
        JSONObject files = R.getJSONObject("files");
        JSONArray list = m.getJSONArray("files");
        assertEquals(files.length(), list.length());
        for (int i = 0; i < list.length(); i++) {
            JSONObject f = list.getJSONObject(i);
            byte[] body = Prim.utf8(files.getString(f.getString("path")));
            assertEquals(f.getLong("size"), body.length);
            assertEquals(f.getString("sha256"), Release.sha256Hex(body));
        }
        for (Iterator<String> it = files.keys(); it.hasNext(); ) assertTrue(Release.isReleasePath(it.next()));
        assertFalse(Release.isReleasePath("../etc/passwd"));
        assertFalse(Release.isReleasePath("/abs"));
    }
}
