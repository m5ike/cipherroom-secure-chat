package cz.m5cet.app.profile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * 6.10: who sees what of the profile — the summary in Settings and the
 * editor, and what a tap on a sender's avatar may show: another member
 * only what they shared with the room, me only what members see of me.
 */
public class WhoSeesTest {
    private static JSONObject j(String s) { try { return new JSONObject(s); } catch (Exception e) { throw new IllegalStateException(e); } }

    /** ProfileCardTest's card: nickname public, about + photo room, background me; Mobile me, Work room, Blog public. */
    private static JSONObject card() { return ProfileCardTest.card(); }

    @Test public void eachAudienceSeesItsOwnAndTheWiderOnes() {
        assertEquals(Arrays.asList("nickname", "field:2"), WhoSees.seenBy(card(), "public"));
        assertEquals(Arrays.asList("nickname", "about", "avatar", "field:1", "field:2"), WhoSees.seenBy(card(), "room"));
        assertEquals(Arrays.asList("nickname", "about", "avatar", "cover", "field:0", "field:1", "field:2"), WhoSees.seenBy(card(), "me"));
        assertEquals(Arrays.asList("cover", "field:0"), WhoSees.onlyMe(card()));
    }

    @Test public void theSummaryMatchesWhatTheViewsCarry() {
        for (String viewer : new String[] { "public", "room", "me" }) {
            JSONObject view = ProfileCard.viewFor(card(), viewer);
            List<String> seen = WhoSees.seenBy(card(), viewer);
            int fields = 0;
            for (String k : seen) if (k.startsWith("field:")) fields++;
            assertEquals(viewer, view.optJSONArray("fields").length(), fields);
            for (String k : new String[] { "nickname", "about", "avatar", "cover" }) assertEquals(viewer + " " + k, view.has(k), seen.contains(k));
        }
        JSONObject s = WhoSees.summary(card());
        assertEquals(2, s.optJSONArray("public").length());
        assertEquals(5, s.optJSONArray("room").length());
        assertEquals(2, s.optJSONArray("me").length());
    }

    @Test public void anEmptyOrInvalidItemIsSharedWithNoOne() {
        JSONObject c = ProfileCard.normalize(j("{nickname:{value:'', audience:'public'}, fields:[{type:'phone', value:'call me', audience:'public'}, {type:'email', value:'a@b.cz', audience:'public'}]}"));
        assertEquals(Collections.singletonList("field:1"), WhoSees.seenBy(c, "public"));
        assertEquals(Collections.emptyList(), WhoSees.onlyMe(c));            // the invalid phone is not "only me" either: it is nobody's
        assertEquals(Collections.emptyList(), WhoSees.seenBy(ProfileCard.empty(), "me"));
        assertEquals(Collections.emptyList(), WhoSees.seenBy(null, "room"));
    }

    @Test public void aSenderShowsOnlyWhatTheySharedWithTheRoom() throws Exception {
        // What a member's phone sends the room is their "room" view: nothing marked only-me is in it.
        JSONObject sent = ProfileCard.viewFor(card(), "room");
        JSONObject shown = WhoSees.senderView(sent, null, false);
        assertEquals("Alice", shown.optString("nickname"));
        assertEquals(2, shown.optJSONArray("fields").length());
        assertFalse(shown.toString().contains("+420 777 123 456"));
        assertFalse(shown.has("cover"));
        // Anything else they hand over is checked again: a field that is not what it claims is dropped.
        sent.getJSONArray("fields").put(new JSONObject().put("type", "phone").put("label", "x").put("value", "<script>"));
        sent.put("audience", "me");
        JSONObject again = WhoSees.senderView(sent, null, false);
        assertEquals(2, again.optJSONArray("fields").length());
        assertFalse(again.has("audience"));
        // Nothing shared, or not a profile at all: nothing to show (the sheet says so).
        assertNull(WhoSees.senderView(null, null, false));
        assertNull(WhoSees.senderView(j("{v:1, fields:[]}"), null, false));
        assertNull(WhoSees.senderView(j("{nickname:'x'}"), null, false)); // no version: not a profile
    }

    @Test public void myOwnAvatarShowsWhatMembersSeeOfMe() {
        JSONObject mine = WhoSees.senderView(null, card(), true);
        assertTrue(mine.has("avatar"));
        assertFalse(mine.has("cover"));                                    // only me
        assertEquals(2, mine.optJSONArray("fields").length());
        assertNull(WhoSees.senderView(null, null, true));                   // signed out: no card
        assertNull(WhoSees.senderView(card(), ProfileCard.empty(), true));  // what someone else sent never stands in for mine
    }
}
