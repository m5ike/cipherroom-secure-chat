package cz.m5cet.app.chat;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/**
 * 6.11: model answers as messages — a peer can never send as the app's own
 * system-messenger (or an older "function:" answer); a room answer's fn flags
 * carry the model's icon; the history keeps an answer's identity and a
 * command's own bubble with its status (one still loading is "interrupted").
 */
public class ModelAnswersTest {
    private static JSONObject payload(String sender) throws Exception {
        return new JSONObject().put("id", "m-1").put("senderId", sender).put("senderName", "Mallory").put("text", "Trust me").put("createdAt", 1_000);
    }

    @Test public void aPeerCannotSendAsTheSystem() throws Exception {
        assertNull(Payloads.validate(payload("system-messenger"), "system-messenger", "p-me"));
        assertNull(Payloads.validate(payload("function:mail"), "function:mail", "p-me"));
        assertNotNull(Payloads.validate(payload("p-alice"), "p-alice", "p-me"));
    }

    @Test public void aRoomAnswerCarriesTheModelsIcon() throws Exception {
        JSONObject fn = new JSONObject().put("keyword", "hlr").put("name", "HLR").put("icon", "phone")
            .put("outputs", new JSONArray().put(new JSONObject().put("type", "text").put("text", "ok")));
        ChatMessage m = Payloads.validate(payload("p-alice").put("flags", new JSONObject().put("fn", fn)).put("forwardedFrom", "/hlr"), "p-alice", "p-me");
        assertEquals("phone", m.fn.getString("icon"));
        assertEquals("p-alice", m.senderId);   // the honest sender stays
        JSONObject bad = new JSONObject(fn.toString()).put("icon", "<script>");
        assertFalse(Payloads.validate(payload("p-alice").put("flags", new JSONObject().put("fn", bad)), "p-alice", "p-me").fn.has("icon"));
    }

    @Test public void theHistoryKeepsAnAnswersIdentity() throws Exception {
        ChatMessage m = new ChatMessage();
        m.id = "fn-1";
        m.roomKey = "r";
        m.senderId = "system-messenger";
        m.senderName = "E-mail";
        m.text = "Done";
        m.createdAt = 5;
        m.model = new JSONObject().put("keyword", "mail").put("name", "E-mail").put("icon", "mail");
        m.fn = new JSONObject().put("keyword", "mail").put("name", "E-mail").put("outputs", new JSONArray().put(new JSONObject().put("type", "text").put("text", "Done")));
        m.replyToId = "fncall-1";
        m.replyToSender = "me";
        m.replyToText = "/mail a@b.cz";
        ChatMessage back = ChatMessage.fromJson(new JSONObject(m.toJson().toString()));
        assertEquals("mail", back.model.getString("icon"));
        assertEquals("system-messenger", back.senderId);
        assertEquals(1, back.fn.getJSONArray("outputs").length());
        assertEquals("fncall-1", back.replyToId);
        assertFalse(back.fnCall());
    }

    @Test public void theHistoryKeepsACommandsBubbleAndItsEnd() throws Exception {
        ChatMessage c = new ChatMessage();
        c.id = "fncall-1";
        c.roomKey = "r";
        c.mine = true;
        c.text = "/mail";
        c.fnLocal = new JSONObject().put("keyword", "mail").put("name", "E-mail").put("icon", "mail").put("query", "/mail").put("pending", false)
            .put("status", new JSONObject().put("kind", "error").put("label", "The model did not answer within 30 s").put("code", "timeout"))
            .put("progress", new JSONObject().put("p", 0.5).put("text", "half"));
        ChatMessage back = ChatMessage.fromJson(new JSONObject(c.toJson().toString()));
        assertTrue(back.fnCall());
        assertEquals("timeout", back.fnLocal.getJSONObject("status").getString("code"));
        assertFalse(back.fnLocal.has("progress"));
        // One still loading when the app stopped has no run any more.
        c.fnLocal.put("pending", true).remove("status");
        ChatMessage stopped = ChatMessage.fromJson(new JSONObject(c.toJson().toString()));
        assertFalse(stopped.fnLocal.optBoolean("pending"));
        assertEquals("interrupted", stopped.fnLocal.getJSONObject("status").getString("code"));
        assertEquals("error", stopped.fnLocal.getJSONObject("status").getString("kind"));
        // An ordinary message has none of it.
        ChatMessage plain = new ChatMessage();
        plain.id = "x";
        plain.roomKey = "r";
        ChatMessage p2 = ChatMessage.fromJson(new JSONObject(plain.toJson().toString()));
        assertNull(p2.fnLocal);
        assertNull(p2.model);
    }
}
