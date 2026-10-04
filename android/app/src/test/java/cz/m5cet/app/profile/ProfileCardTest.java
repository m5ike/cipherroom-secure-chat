package cz.m5cet.app.profile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

/**
 * 6.7: who sees what of the profile card — the same rules as the web
 * (test/profile-model.test.ts): only-me never reaches another audience,
 * room members get room + public, the public only public; defaults are
 * private; what others hand over is rebuilt from checked values.
 */
public class ProfileCardTest {
    private static JSONObject j(String s) { try { return new JSONObject(s); } catch (Exception e) { throw new IllegalStateException(e); } }

    static final String PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    static JSONObject card() {
        return ProfileCard.normalize(j("{nickname:{value:'Alice', audience:'public'}, about:{value:'Climber', audience:'room'},"
            + " avatar:{value:'" + PNG + "', audience:'room'}, cover:{value:'" + PNG + "', audience:'me'},"
            + " fields:[{id:'f1', type:'phone', label:'Mobile', value:'+420 777 123 456', audience:'me'},"
            + " {id:'f2', type:'email', label:'Work', value:'alice@example.com', audience:'room'},"
            + " {id:'f3', type:'url', label:'Blog', value:'https://alice.example', audience:'public'}]}"));
    }

    @Test
    public void onlyMeNeverReachesRoomOrPublic() throws Exception {
        String room = ProfileCard.viewFor(card(), "room").toString();
        String pub = ProfileCard.viewFor(card(), "public").toString();
        for (String secret : new String[] { "+420 777 123 456", "Mobile" }) {
            assertFalse(room.contains(secret));
            assertFalse(pub.contains(secret));
        }
        assertFalse(room.contains("audience"));
        assertFalse(ProfileCard.viewFor(card(), "room").has("cover"));
    }

    @Test
    public void roomGetsRoomAndPublicThePublicOnlyPublic() throws Exception {
        JSONObject room = ProfileCard.viewFor(card(), "room");
        assertEquals("Alice", room.optString("nickname"));
        assertEquals("Climber", room.optString("about"));
        assertEquals(PNG, room.optString("avatar"));
        assertEquals(2, room.optJSONArray("fields").length());
        JSONObject pub = ProfileCard.viewFor(card(), "public");
        assertEquals("Alice", pub.optString("nickname"));
        assertFalse(pub.has("about"));
        assertFalse(pub.has("avatar"));
        assertEquals(1, pub.optJSONArray("fields").length());
        assertEquals("https://alice.example", pub.optJSONArray("fields").optJSONObject(0).optString("value"));
        assertEquals(3, ProfileCard.viewFor(card(), "me").optJSONArray("fields").length());
        assertFalse(ProfileCard.publicBody(card()).has("rev"));
    }

    @Test
    public void defaultsArePrivateAndTheNicknameIsMeantToBePublic() throws Exception {
        JSONObject e = ProfileCard.empty();
        assertEquals("me", e.optJSONObject("about").optString("audience"));
        assertEquals("me", e.optJSONObject("avatar").optString("audience"));
        assertEquals("me", e.optJSONObject("cover").optString("audience"));
        assertEquals("public", e.optJSONObject("nickname").optString("audience"));
        assertTrue(ProfileCard.isEmptyView(ProfileCard.viewFor(e, "public")));
        JSONObject c = ProfileCard.normalize(j("{fields:[{type:'phone', value:'+420 600 000 000'}], about:{value:'x', audience:'everyone'}}"));
        assertEquals("me", c.optJSONArray("fields").optJSONObject(0).optString("audience"));
        assertEquals("me", c.optJSONObject("about").optString("audience"));
    }

    @Test
    public void invalidValuesAreNotShared() throws Exception {
        JSONObject c = ProfileCard.normalize(j("{fields:[{type:'email', value:'nope', audience:'public'}, {type:'url', value:'javascript:alert(1)', audience:'public'},"
            + " {type:'phone', value:'call me', audience:'public'}, {type:'birthday', value:'1990-05-01', audience:'public'}]}"));
        assertEquals(1, ProfileCard.viewFor(c, "public").optJSONArray("fields").length());
        assertEquals("", ProfileCard.cleanValue("url", "ftp://x.example"));
        assertEquals("https://ok.example/x", ProfileCard.cleanValue("url", "https://ok.example/x"));
    }

    @Test
    public void whatOthersHandOverIsRebuiltFromCheckedValues() throws Exception {
        JSONObject v = ProfileCard.normalizeShared(j("{v:1, nickname:'  Bob‮ ', avatar:'https://tracker.example/p.png', cover:'data:image/svg+xml;base64,PHN2Zz4=',"
            + " fields:[{type:'email', label:'Mail', value:'bob@example.org'}, {type:'evil', label:'?', value:'free text'}], secret:'leak'}"));
        assertEquals("Bob", v.optString("nickname"));
        assertFalse(v.has("avatar"));
        assertFalse(v.has("cover"));
        assertEquals(2, v.optJSONArray("fields").length());
        assertEquals("other", v.optJSONArray("fields").optJSONObject(1).optString("type"));
        assertFalse(v.toString().contains("leak"));
        assertNull(ProfileCard.normalizeShared(j("{v:2}")));
        assertNull(ProfileCard.normalizeShared("x"));
        StringBuilder big = new StringBuilder();
        for (int i = 0; i < 300_000; i++) big.append('y');
        assertNull(ProfileCard.normalizeShared(j("{v:1, about:'x'}").put("pad", big.toString()).put("v", 1)));
    }

    @Test
    public void sizesAreCapped() throws Exception {
        StringBuilder nick = new StringBuilder();
        for (int i = 0; i < 100; i++) nick.append('N');
        JSONObject c = ProfileCard.normalize(j("{}").put("nickname", j("{audience:'public'}").put("value", nick.toString())));
        assertEquals(ProfileCard.NICKNAME_CHARS, c.optJSONObject("nickname").optString("value").length());
        StringBuilder img = new StringBuilder("data:image/jpeg;base64,");
        for (int i = 0; i < ProfileCard.AVATAR_BYTES * 4 / 3 + 100; i++) img.append('A');
        assertEquals("", ProfileCard.cleanImage(img.toString(), ProfileCard.AVATAR_BYTES));
        assertEquals(PNG, ProfileCard.cleanImage(PNG, ProfileCard.AVATAR_BYTES));
    }

    @Test
    public void revFollowsTheContent() throws Exception {
        String a = ProfileCard.viewFor(card(), "room").optString("rev");
        assertTrue(a.matches("^[0-9a-f]{16}$"));
        assertEquals(a, ProfileCard.viewFor(card().put("updatedAt", 999), "room").optString("rev"));
        JSONObject other = card();
        other.optJSONObject("about").put("value", "Coffee");
        assertNotEquals(a, ProfileCard.viewFor(other, "room").optString("rev"));
        // A received copy of the same content has the same rev.
        assertEquals(a, ProfileCard.normalizeShared(ProfileCard.viewFor(card(), "room")).optString("rev"));
    }

    @Test
    public void thePublicNicknamePrefillsTheRoomName() throws Exception {
        assertEquals("Alice", ProfileCard.prefill(card(), "Pixel 9"));
        assertEquals("Pixel 9", ProfileCard.prefill(ProfileCard.empty(), "Pixel 9"));
        assertEquals("Bob", ProfileCard.prefill(null, "Bob"));
        // Whatever its audience: it is my own field.
        JSONObject c = ProfileCard.normalize(j("{nickname:{value:'Private Al', audience:'me'}}"));
        assertEquals("Private Al", ProfileCard.prefill(c, "x"));
        assertFalse(ProfileCard.viewFor(c, "room").has("nickname"));
    }

    @Test
    public void controlAndBidiCharactersAreStripped() throws Exception {
        assertEquals("ab c", ProfileCard.cleanLine("a\u0000b\n\n c‮", 40));
        assertEquals("line 1\n\nline 2", ProfileCard.cleanText("line 1\r\n\r\n\r\n\r\nline 2", 100));
    }
}
