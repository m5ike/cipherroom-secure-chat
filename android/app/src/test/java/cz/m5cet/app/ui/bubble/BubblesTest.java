package cz.m5cet.app.ui.bubble;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import cz.m5cet.app.chat.ChatMessage;

/** 6.2 bubbles: the map preview's tile math and policy, what a message is, hides, the audit entry. */
public class BubblesTest {

    /* ------------------------------------------------------------ tiles */

    @Test public void projectsLikeTheSlippyMap() {
        double[] p = TileMath.project(0, 0, 0);
        assertEquals(128, p[0], 1e-9);
        assertEquals(128, p[1], 1e-9);
        p = TileMath.project(0, 0, 1);
        assertEquals(256, p[0], 1e-9);
        assertEquals(256, p[1], 1e-9);
        // The corners of the square world.
        assertEquals(0, TileMath.project(TileMath.MAX_LAT, -180, 3)[1], 1e-3);
        assertEquals(TileMath.world(3), TileMath.project(-TileMath.MAX_LAT, 180, 3)[0], 1e-9);
        assertEquals(TileMath.world(3), TileMath.project(-TileMath.MAX_LAT, 180, 3)[1], 1e-3);
    }

    @Test public void findsTheTileOfAPlace() {
        // Prague, Old Town Square — OpenStreetMap's own numbering (z 16: 35393 / 22201).
        int[] t = TileMath.tileOf(50.0875, 14.4213, 16);
        int n = 1 << 16;
        double latRad = Math.toRadians(50.0875);
        assertEquals((int) Math.floor((14.4213 + 180) / 360 * n), t[0]);
        assertEquals((int) Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n), t[1]);
        assertEquals(35393, t[0]);
        assertEquals(22201, t[1]);
        // Beyond the poles: the last row.
        assertEquals(0, TileMath.tileOf(89, 0, 4)[1]);
        assertEquals(15, TileMath.tileOf(-89, 0, 4)[1]);
    }

    @Test public void theViewIsCentredExactlyOnThePoint() {
        double lat = 50.0875, lon = 14.4213, w = 280, h = 160;
        int z = 16;
        List<TileMath.Tile> tiles = TileMath.tiles(lat, lon, z, w, h);
        double[] p = TileMath.project(lat, lon, z);
        int[] home = TileMath.tileOf(lat, lon, z);
        TileMath.Tile hit = null;
        for (TileMath.Tile t : tiles) if (t.x == home[0] && t.y == home[1]) hit = t;
        assertNotNull(hit);
        // The point's pixel inside its tile, moved by the tile's offset, is the middle of the view.
        assertEquals(w / 2, hit.left + (p[0] - home[0] * 256.0), 1e-6);
        assertEquals(h / 2, hit.top + (p[1] - home[1] * 256.0), 1e-6);
        // The tiles cover the whole view, without gaps, in rows.
        double minL = Double.MAX_VALUE, minT = Double.MAX_VALUE, maxR = -Double.MAX_VALUE, maxB = -Double.MAX_VALUE;
        Set<String> seen = new HashSet<>();
        for (TileMath.Tile t : tiles) {
            minL = Math.min(minL, t.left); minT = Math.min(minT, t.top);
            maxR = Math.max(maxR, t.left + 256); maxB = Math.max(maxB, t.top + 256);
            assertTrue(seen.add(t.toString()));
            assertEquals(z, t.z);
        }
        assertTrue(minL <= 0 && minT <= 0 && maxR >= w && maxB >= h);
        assertTrue(tiles.size() >= 2 && tiles.size() <= 6);
    }

    @Test public void aTileCornerNeedsFourTiles() {
        // (0, 0) at z 1 is where four tiles meet: a small view takes one of each.
        List<TileMath.Tile> tiles = TileMath.tiles(0, 0, 1, 100, 100);
        assertEquals(4, tiles.size());
        assertEquals("1/0/0", tiles.get(0).toString());
        assertEquals(-206, tiles.get(0).left, 1e-9);
        assertEquals(-206, tiles.get(0).top, 1e-9);
        assertEquals("1/1/1", tiles.get(3).toString());
        assertEquals(50, tiles.get(3).left, 1e-9);
    }

    @Test public void wrapsAcrossTheDateLineAndStopsAtThePoles() {
        List<TileMath.Tile> tiles = TileMath.tiles(0, 179.99, 2, 280, 160);
        Set<Integer> xs = new HashSet<>();
        for (TileMath.Tile t : tiles) xs.add(t.x);
        assertTrue(xs.contains(3) && xs.contains(0)); // the east edge and, past it, the west one
        for (TileMath.Tile t : TileMath.tiles(85, 0, 2, 280, 400)) assertTrue(t.y >= 0 && t.y < 4);
    }

    @Test public void metresPerPixel() {
        assertEquals(156543.03, TileMath.metersPerPixel(0, 0), 0.01);
        assertEquals(156543.03 / 65536 * Math.cos(Math.toRadians(50)), TileMath.metersPerPixel(50, 16), 1e-6);
    }

    /* ----------------------------------------------------------- policy */

    @Test public void readsTheOperatorsPolicyLikeTheServer() throws Exception {
        MapPolicy d = MapPolicy.parse(new JSONObject().put("map", new JSONObject()));
        assertTrue(d.enabled);
        assertEquals(16, d.zoom);
        assertEquals(280, d.width);
        assertEquals(160, d.height);
        assertEquals(0xFFE11D48, d.pinColor);
        assertEquals(0, d.accent);
        assertTrue(d.label && d.showCoords);
        assertFalse(d.grayscale);
        MapPolicy p = MapPolicy.parse(new JSONObject().put("map", new JSONObject().put("enabled", true).put("zoom", 40).put("width", 90).put("height", 9999)
            .put("pinColor", "#00FF00").put("accent", "#123456").put("grayscale", true).put("label", false).put("attribution", "<b>© Tiles</b>\u0007").put("subdomains", "abc!")));
        assertEquals(19, p.zoom);
        assertEquals(160, p.width);
        assertEquals(480, p.height);
        assertEquals(0xFF00FF00, p.pinColor);
        assertEquals(0xFF123456, p.accent);
        assertTrue(p.grayscale);
        assertFalse(p.label);
        assertEquals("b© Tiles/b", p.attribution);
        assertEquals("", p.subdomains);
        assertEquals(0xFFE11D48, MapPolicy.parse(new JSONObject().put("map", new JSONObject().put("pinColor", "red"))).pinColor);
        // A server from before 6.2 has no map (and no tiles to give).
        assertFalse(MapPolicy.parse(new JSONObject().put("composer", new JSONObject())).enabled);
        assertFalse(MapPolicy.parse(new JSONObject().put("map", new JSONObject().put("enabled", false))).enabled);
    }

    /* ------------------------------------------------------------ kinds */

    private static ChatMessage msg(String text) {
        ChatMessage m = new ChatMessage();
        m.id = "msg-1";
        m.roomKey = "k";
        m.text = text;
        return m;
    }

    @Test public void aPositionMessageFromTheWebOrTheApp() throws Exception {
        ChatMessage web = msg("📍 50.08804, 14.42076 (±12 m) https://www.openstreetmap.org/?mlat=50.088040&mlon=14.420760#map=15/50.088040/14.420760");
        assertTrue(Kinds.isPositionMessage(web));
        JSONObject p = Kinds.position(web);
        assertEquals(50.08804, p.getDouble("lat"), 1e-9);
        assertEquals(14.42076, p.getDouble("lon"), 1e-9);
        assertEquals(12, p.getLong("acc"));
        assertFalse(Kinds.headerPosition(web));
        assertEquals(Arrays.asList("location"), Kinds.of(web));

        ChatMessage live = msg("📍 live -33.86785, 151.20732 https://www.openstreetmap.org/");
        assertEquals(-33.86785, Kinds.position(live).getDouble("lat"), 1e-9);
        assertFalse(Kinds.position(live).has("acc"));

        // The app's own carries loc too — that wins (more precise, with its time).
        ChatMessage app = msg("📍 50.08804, 14.42076 (±12 m) https://…");
        app.loc = new JSONObject().put("lat", 50.0880412).put("lon", 14.4207633).put("acc", 9).put("at", 1);
        assertEquals(50.0880412, Kinds.position(app).getDouble("lat"), 1e-9);

        // Only the header's position: text of its own, loc beside it.
        ChatMessage header = msg("Jsem na místě");
        header.loc = new JSONObject().put("lat", 50.1).put("lon", 14.4).put("acc", 30);
        assertTrue(Kinds.headerPosition(header));
        assertFalse(Kinds.isPositionMessage(header));
        assertEquals(Arrays.asList("text", "location"), Kinds.of(header));

        assertNull(Kinds.position(msg("I am at 📍 home")));
        assertNull(Kinds.position(msg("📍 95.1, 14.2")));
        ChatMessage sealed = msg("📍 50.1, 14.2");
        sealed.sealed = new JSONObject();
        assertNull(Kinds.position(sealed));
    }

    @Test public void theKindsTheAuditJournalKnows() throws Exception {
        ChatMessage m = msg("hello");
        m.fileName = "clip.mp4";
        m.fileMime = "video/mp4";
        m.tap = true;
        m.vanishSeconds = 30;
        m.to.add("Jana");
        m.forwardedFrom = "Petr";
        m.replyToId = "msg-0";
        m.sourceAudio = "call-1";
        m.fn = new JSONObject().put("keyword", "w");
        assertEquals(Arrays.asList("text", "video", "tap", "vanish", "fn", "private", "forwarded", "reply", "transcript"), Kinds.of(m));
        ChatMessage img = msg("");
        img.fileName = "a.png";
        img.fileImage = true;
        img.sealed = null;
        assertEquals(Arrays.asList("image"), Kinds.of(img));
        ChatMessage voice = msg("");
        voice.fileName = "v.m4a";
        voice.fileMime = "audio/mp4";
        assertEquals(Arrays.asList("audio"), Kinds.of(voice));
        ChatMessage doc = msg("");
        doc.fileName = "a.pdf";
        doc.fileMime = "application/pdf";
        assertEquals(Arrays.asList("file"), Kinds.of(doc));
        ChatMessage seal = msg("ciphertext");
        seal.sealed = new JSONObject();
        assertEquals(Arrays.asList("text", "sealed"), Kinds.of(seal));
    }

    /* ----------------------------------------------------------- audit */

    @Test public void theAuditEntryNeverCarriesTheMessage() throws Exception {
        ChatMessage m = msg("tajné heslo je 1234");
        m.fileName = "smlouva.pdf";
        m.fileMime = "application/pdf";
        m.fileDataUrl = "data:application/pdf;base64,JVBERi0=";
        m.mine = true;
        JSONObject hide = MessageAudit.entry("hide", m, "r3.abc", 1_700_000_000_000L, 1_699_999_000_000L);
        assertEquals("hide", hide.getString("action"));
        assertEquals("msg-1", hide.getString("messageId"));
        assertEquals("r3.abc", hide.getString("room"));
        assertEquals(1_700_000_000_000L, hide.getLong("until"));
        assertEquals(1_699_999_000_000L, hide.getLong("at"));
        assertTrue(hide.getBoolean("mine"));
        assertEquals("[\"text\",\"file\"]", hide.getJSONArray("kinds").toString());
        String all = hide.toString();
        assertFalse(all.contains("tajné") || all.contains("smlouva") || all.contains("base64"));
        assertEquals(0, MessageAudit.entry("hide", m, "r3.abc", ChatMessage.UNTIL_SIGNIN, 1).getLong("until")); // until the next sign-in
        assertFalse(MessageAudit.entry("delete", m, "r3.abc", 0, 1).has("until"));
        assertEquals(new HashSet<>(Arrays.asList("action", "messageId", "room", "kinds", "mine", "at")), keys(MessageAudit.entry("unhide", m, "r", 0, 1)));
    }

    private static Set<String> keys(JSONObject o) {
        Set<String> s = new HashSet<>();
        for (java.util.Iterator<String> it = o.keys(); it.hasNext(); ) s.add(it.next());
        return s;
    }

    /* ------------------------------------------------------------ hides */

    @Test public void timedHidesEndWithTheirTime() {
        ChatMessage m = msg("x");
        long now = 1_000_000;
        assertFalse(Hides.hidden(m, now));
        m.hiddenUntil = now + 60_000;
        assertTrue(Hides.hidden(m, now));
        assertFalse(Hides.endIfOver(m, now));
        assertTrue(Hides.hidden(m, now + 59_999));
        assertTrue(Hides.endIfOver(m, now + 60_000));
        assertEquals(0, m.hiddenUntil);
        ChatMessage.Step last = m.timeline().get(m.timeline().size() - 1);
        assertEquals("unhidden", last.state);
        assertEquals("time", last.meta);
        assertEquals(now + 60_000, last.at);
    }

    @Test public void signInHidesEndWithTheNextUnlock() {
        ChatMessage m = msg("x");
        m.hiddenUntil = ChatMessage.UNTIL_SIGNIN;
        m.hiddenFor = "unlock-A";
        assertTrue(Hides.hidden(m, 5, "unlock-A"));
        assertTrue(Hides.hidden(m, Long.MAX_VALUE - 1, "unlock-A")); // no time limit
        assertFalse(Hides.hidden(m, 5, "unlock-B")); // unlocked since (or the app started again)
        m.hiddenFor = null;
        assertFalse(Hides.hidden(m, 5, "unlock-A"));
    }

    @Test public void theNextTimedHideToEnd() {
        ChatMessage a = msg("a"), b = msg("b"), c = msg("c");
        a.hiddenUntil = 5000;
        b.hiddenUntil = 3000;
        c.hiddenUntil = ChatMessage.UNTIL_SIGNIN;
        assertEquals(3000, Hides.nextEnd(Arrays.asList(a, b, c), 1000));
        assertEquals(5000, Hides.nextEnd(Arrays.asList(a, b, c), 3000));
        assertEquals(Long.MAX_VALUE, Hides.nextEnd(Arrays.asList(c), 0));
        assertEquals(Hides.FOR.length, Hides.NAMES.length);
    }
}
