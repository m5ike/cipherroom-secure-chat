package cz.m5cet.app.ui.bubble;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.function.Predicate;

import cz.m5cet.app.chat.ChatMessage;
import cz.m5cet.app.fn.ModelIdentity;

/** 6.11: a model's answer drawn as an incoming message under the model's identity — here only, mine to the room, a peer's — and its runs. */
public class ModelFaceTest {
    private static final ModelFace.Tr TR = k -> k.equals("fnm.via") ? "via {name}" : "[" + k + "]";
    private static final Set<String> APP_ICONS = new HashSet<>(Arrays.asList("mail", "phone", "phone-outgoing", "globe", "bot", "cloud", "hash", "circle-question-mark"));
    private static final Predicate<String> HAS = APP_ICONS::contains;

    private static ChatMessage msg(String id, String sender, long at) {
        ChatMessage m = new ChatMessage();
        m.id = id;
        m.roomKey = "r";
        m.senderId = sender;
        m.senderName = sender;
        m.text = "x";
        m.createdAt = at;
        return m;
    }

    /** A caller-only answer as RoomSession.addModelAnswer makes it. */
    private static ChatMessage answer(String id, String keyword, long at) {
        ChatMessage m = msg(id, ModelIdentity.SYSTEM_MESSENGER_ID, at);
        m.model = ModelIdentity.of(keyword, keyword.toUpperCase(), null).toJson();
        m.senderName = keyword.toUpperCase();
        return m;
    }

    private static ChatMessage call(String id, long at) throws Exception {
        ChatMessage m = msg(id, "me", at);
        m.mine = true;
        m.fnLocal = new JSONObject().put("keyword", "mail").put("name", "Mail").put("query", "/mail").put("pending", true);
        return m;
    }

    @Test public void whichMessagesAreAModelsAnswer() throws Exception {
        ChatMessage here = answer("a1", "mail", 1);
        assertEquals("mail", ModelFace.of(here).keyword);
        assertTrue(ModelFace.local(here));
        // My room answer: mine, flags.fn without a query.
        ChatMessage mine = msg("m1", "me", 1);
        mine.mine = true;
        mine.fn = new JSONObject().put("keyword", "hlr").put("name", "HLR").put("icon", "phone");
        assertEquals("phone", ModelFace.of(mine).icon);
        assertFalse(ModelFace.local(mine));
        // A peer's room answer.
        ChatMessage peer = msg("p1", "peer-1", 1);
        peer.senderName = "Alice";
        peer.fn = new JSONObject().put("keyword", "hlr").put("name", "HLR");
        assertEquals("HLR", ModelFace.of(peer).name);
        // An older caller-only answer (6.5 "function:<keyword>").
        ChatMessage old = msg("o1", "function:dns", 1);
        old.senderName = "DNS";
        assertEquals("dns", ModelFace.of(old).keyword);
        // A command's own bubble, a person's message, a notice: no.
        assertNull(ModelFace.of(call("c1", 1)));
        assertNull(ModelFace.of(msg("t1", "peer-1", 1)));
        ChatMessage sys = ChatMessage.system("r", "hello");
        assertNull(ModelFace.of(sys));
    }

    @Test public void theLineSaysHowItCame() throws Exception {
        assertEquals("/mail · [fnm.onlyYou]", ModelFace.scope(answer("a1", "mail", 1), TR, HAS).optString("line"));
        ChatMessage mine = msg("m1", "me", 1);
        mine.mine = true;
        mine.fn = new JSONObject().put("keyword", "hlr").put("name", "HLR");
        JSONObject s = ModelFace.scope(mine, TR, HAS);
        assertEquals("/hlr · [fnm.viaYou]", s.optString("line"));
        assertTrue(s.optBoolean("mine"));
        ChatMessage peer = msg("p1", "peer-1", 1);
        peer.senderName = "Alice";
        peer.fn = new JSONObject().put("keyword", "hlr").put("name", "HLR").put("icon", "🦊");
        JSONObject p = ModelFace.scope(peer, TR, HAS);
        assertEquals("/hlr · via Alice", p.optString("line"));
        assertEquals("Alice", p.optString("via"));
        assertEquals("HLR", p.optString("name"));
        assertTrue(p.optBoolean("emoji"));
        assertEquals("", p.optString("glyph"));
        assertEquals("#7bb234", p.optString("color"));
        assertNull(ModelFace.scope(msg("t1", "peer-1", 1), TR, HAS));
        // A wrong call's card.
        ChatMessage card = answer("e1", "mail", 1);
        card.fn = new JSONObject().put("keyword", "mail").put("problem", true);
        assertTrue(ModelFace.scope(card, TR, HAS).optBoolean("error"));
    }

    @Test public void theIconTheAppDraws() throws Exception {
        assertEquals("mail", ModelFace.glyph(ModelIdentity.of("mail", "", null), HAS));
        // The default icons this app's set lacks: a near one.
        assertEquals("phone-outgoing", ModelFace.glyph(ModelIdentity.of("call", "", null), HAS));
        assertEquals("cloud", ModelFace.glyph(ModelIdentity.of("weather", "", null), HAS));
        assertEquals("circle-question-mark", ModelFace.glyph(ModelIdentity.of("help", "", null), HAS));
        // The model's own icon unknown here: its keyword's; a shorter name; a bot.
        assertEquals("mail", ModelFace.glyph(ModelIdentity.of("mail", "", "envelope-open"), HAS));
        assertEquals("globe", ModelFace.glyph(ModelIdentity.of("zz", "", "globe-lock"), HAS));
        assertEquals("bot", ModelFace.glyph(ModelIdentity.of("zz", "", "rocket"), HAS));
        assertEquals("", ModelFace.glyph(ModelIdentity.of("zz", "", "🚀"), HAS));
    }

    @Test public void aModelsAnswersAreTheirOwnRun() throws Exception {
        ChatMessage cmd = call("c1", 1_000);
        ChatMessage a1 = answer("a1", "mail", 2_000);
        ChatMessage a2 = answer("a2", "mail", 3_000);
        ChatMessage other = answer("a3", "dns", 4_000);
        assertFalse(Runs.continues(cmd, a1));      // the answer starts its own run (its face shows)
        assertTrue(Runs.continues(a1, a2));        // the same model again
        assertFalse(Runs.continues(a2, other));    // another model
        ChatMessage mine = msg("m1", "me", 5_000);
        mine.mine = true;
        mine.fn = new JSONObject().put("keyword", "dns").put("name", "DNS");
        assertFalse(Runs.continues(other, mine));  // only you vs. via you
        ChatMessage mine2 = msg("m2", "me", 6_000);
        mine2.mine = true;
        assertFalse(Runs.continues(mine, mine2));  // my room answer, then my own message
        assertFalse(Runs.continues(a1, answer("late", "mail", 2_000 + Runs.GAP_MS + 1)));
    }
}
