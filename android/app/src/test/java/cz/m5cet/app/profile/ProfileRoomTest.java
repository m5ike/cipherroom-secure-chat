package cz.m5cet.app.profile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Predicate;

/**
 * 6.7: the room's profile frames (the web's test/profile-room.test.ts): two
 * phones speak announce → request → full over a fake pair channel; only the
 * room view travels, the cache is keyed by the sender's device key, a repeated
 * request gets no second copy, a frame too large goes without the background.
 */
public class ProfileRoomTest {
    private static JSONObject j(String s) { try { return new JSONObject(s); } catch (Exception e) { throw new IllegalStateException(e); } }

    static final class Wire {
        final List<String[]> frames = new ArrayList<>(); // from, to, json
        final Map<String, ProfileRoom.Exchange> nodes = new HashMap<>();
        long now = 1_000;
        Predicate<JSONObject> fits = f -> true;

        ProfileRoom.Exchange node(String me, JSONObject[] view) {
            ProfileRoom.Exchange x = new ProfileRoom.Exchange(new ProfileRoom.Cache(16), new ProfileRoom.Deps() {
                @Override public boolean send(String peerId, JSONObject frame) {
                    if (!fits.test(frame)) return false;
                    frames.add(new String[] { me, peerId, frame.toString() });
                    JSONObject parsed = ProfileRoom.parse(j(frame.toString()));
                    if (parsed != null) nodes.get(peerId).receive(me, parsed);
                    return true;
                }
                @Override public JSONObject myView() { return view[0]; }
                @Override public String ownerOf(String peerId) { return "devkey-" + peerId; }
                @Override public long now() { return now; }
            });
            nodes.put(me, x);
            return x;
        }
    }

    private static final JSONArray CAPS = new JSONArray().put("bin").put("profile");

    @Test
    public void onlyTheRoomViewTravels() throws Exception {
        JSONObject card = ProfileCardTest.card();
        Wire w = new Wire();
        ProfileRoom.Exchange alice = w.node("alice", new JSONObject[] { ProfileCard.viewFor(card, "room") });
        ProfileRoom.Exchange bob = w.node("bob", new JSONObject[] { null });
        bob.hello("alice", CAPS);
        alice.hello("bob", CAPS);
        JSONObject got = bob.cache.of("alice");
        assertNotNull(got);
        assertEquals("Alice", got.optString("nickname"));
        StringBuilder all = new StringBuilder();
        for (String[] f : w.frames) all.append(f[2]);
        assertFalse(all.toString().contains("+420 777 123 456"));
        assertFalse(all.toString().contains("audience"));
    }

    @Test
    public void aPeerWithoutTheCapabilityGetsNothing() throws Exception {
        Wire w = new Wire();
        ProfileRoom.Exchange alice = w.node("alice", new JSONObject[] { ProfileCard.viewFor(ProfileCardTest.card(), "room") });
        w.node("bob", new JSONObject[] { null });
        alice.hello("bob", new JSONArray().put("bin"));
        assertTrue(w.frames.isEmpty());
        assertFalse(alice.speaks("bob"));
    }

    @Test
    public void aKnownVersionComesFromTheCache() throws Exception {
        Wire w = new Wire();
        ProfileRoom.Exchange alice = w.node("alice", new JSONObject[] { ProfileCard.viewFor(ProfileCardTest.card(), "room") });
        ProfileRoom.Exchange bob = w.node("bob", new JSONObject[] { null });
        alice.hello("bob", CAPS);
        bob.forget("alice");
        assertNull(bob.cache.of("alice"));
        w.frames.clear();
        alice.hello("bob", CAPS);
        assertEquals(1, w.frames.size());
        assertNotNull(bob.cache.of("alice"));
    }

    @Test
    public void changesAreAnnouncedAndNothingClears() throws Exception {
        JSONObject[] view = { ProfileCard.viewFor(ProfileCardTest.card(), "room") };
        Wire w = new Wire();
        ProfileRoom.Exchange alice = w.node("alice", view);
        ProfileRoom.Exchange bob = w.node("bob", new JSONObject[] { null });
        alice.hello("bob", CAPS);
        JSONObject changed = ProfileCardTest.card();
        changed.optJSONObject("about").put("value", "New text");
        view[0] = ProfileCard.viewFor(changed, "room");
        alice.changed();
        assertEquals("New text", bob.cache.of("alice").optString("about"));
        view[0] = null;
        alice.changed();
        assertNull(bob.cache.of("alice"));
    }

    @Test
    public void aRepeatedRequestGetsNoSecondCopy() throws Exception {
        JSONObject view = ProfileCard.viewFor(ProfileCardTest.card(), "room");
        Wire w = new Wire();
        ProfileRoom.Exchange alice = w.node("alice", new JSONObject[] { view });
        w.node("bob", new JSONObject[] { null });
        JSONObject want = j("{want:true}").put("rev", view.optString("rev"));
        alice.receive("bob", want);
        alice.receive("bob", want);
        assertEquals(1, fulls(w));
        w.now += ProfileRoom.ANSWER_EVERY_MS + 1;
        alice.receive("bob", want);
        assertEquals(2, fulls(w));
        alice.receive("bob", j("{rev:'0000000000000000', want:true}"));
        assertEquals(2, fulls(w));
    }

    private static int fulls(Wire w) {
        int n = 0;
        for (String[] f : w.frames) if (f[2].contains("\"profile\"")) n++;
        return n;
    }

    @Test
    public void tooLargeGoesWithoutTheBackground() throws Exception {
        JSONObject card = ProfileCardTest.card();
        card.optJSONObject("cover").put("audience", "room");
        Wire w = new Wire();
        w.fits = f -> f.optJSONObject("profile") == null || !f.optJSONObject("profile").has("cover");
        ProfileRoom.Exchange alice = w.node("alice", new JSONObject[] { ProfileCard.viewFor(card, "room") });
        ProfileRoom.Exchange bob = w.node("bob", new JSONObject[] { null });
        alice.hello("bob", CAPS);
        assertTrue(bob.cache.of("alice").has("avatar"));
        assertFalse(bob.cache.of("alice").has("cover"));
    }

    @Test
    public void aCopyNobodyAskedForIsNotTaken() throws Exception {
        JSONObject view = ProfileCard.viewFor(ProfileCardTest.card(), "room");
        Wire w = new Wire();
        w.node("alice", new JSONObject[] { view });
        ProfileRoom.Exchange bob = w.node("bob", new JSONObject[] { null });
        bob.receive("alice", ProfileRoom.parse(ProfileRoom.full(view, false)));
        assertNull(bob.cache.of("alice"));
    }

    @Test
    public void nobodyPlantsACopyUnderSomeoneElsesVersion() throws Exception {
        ProfileRoom.Cache cache = new ProfileRoom.Cache(8);
        JSONObject real = ProfileCard.viewFor(ProfileCardTest.card(), "room");
        cache.received("mallory", "devkey-mallory", j("{}").put("rev", real.optString("rev")).put("profile", j("{v:1, nickname:'Not Alice', fields:[]}")));
        assertEquals("request", cache.announced("alice", "devkey-alice", real.optString("rev")));
        assertNull(cache.of("alice"));
    }

    @Test
    public void framesAreChecked() throws Exception {
        assertNull(ProfileRoom.parse(j("{rev:'<script>'}")));
        assertNull(ProfileRoom.parse(j("{rev:'abc', profile:{v:9}}")));
        assertNull(ProfileRoom.parse(j("{rev:'', want:true}")));
        assertEquals("", ProfileRoom.parse(j("{rev:''}")).optString("rev"));
        JSONObject full = ProfileRoom.parse(j("{rev:'abc', profile:{v:1, nickname:'Bob', avatar:'https://evil.example/x.png', fields:[]}}"));
        assertEquals("Bob", full.optJSONObject("profile").optString("nickname"));
        assertFalse(full.optJSONObject("profile").has("avatar"));
    }

    @Test
    public void theCacheDropsTheOldestAndRemembersSigningAccounts() throws Exception {
        ProfileRoom.Cache cache = new ProfileRoom.Cache(2);
        JSONObject v = ProfileCard.viewFor(ProfileCardTest.card(), "room");
        cache.received("p1", "k1", j("{rev:'r1'}").put("profile", v));
        cache.received("p2", "k2", j("{rev:'r2'}").put("profile", v));
        cache.received("p3", "k3", j("{rev:'r3'}").put("profile", v));
        assertNull(cache.of("p1"));
        assertNotNull(cache.of("p3"));
        Wire w = new Wire();
        ProfileRoom.Exchange x = w.node("alice", new JSONObject[] { null });
        x.signedBy("bob", "ACCOUNTKEY");
        assertEquals("ACCOUNTKEY", x.accountKey("bob"));
        x.forget("bob");
        assertEquals("", x.accountKey("bob"));
    }
}
