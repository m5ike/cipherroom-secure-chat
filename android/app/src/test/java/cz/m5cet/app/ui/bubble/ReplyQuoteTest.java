package cz.m5cet.app.ui.bubble;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import cz.m5cet.app.chat.ChatMessage;

/** 6.10: the quote card on top of a reply ($msg.replyTo), and runs of one person's messages ($msg.cont). */
public class ReplyQuoteTest {
    private static final ReplyQuote.Tr TR = k -> "[" + k + "]";

    private static ChatMessage msg(String id, String sender, String text) {
        ChatMessage m = new ChatMessage();
        m.id = id;
        m.roomKey = "r";
        m.senderId = "peer-" + sender;
        m.senderName = sender;
        m.text = text;
        m.createdAt = 1_000_000;
        return m;
    }

    private static ChatMessage reply(ChatMessage to, String quoted) {
        ChatMessage r = msg("r1", "Bob", "ok");
        r.replyToId = to == null ? "gone-1" : to.id;
        r.replyToSender = to == null ? "Alice" : to.senderName;
        r.replyToText = quoted;
        return r;
    }

    @Test public void aMessageThatIsNoReplyHasNoQuote() {
        assertNull(ReplyQuote.of(msg("a", "Alice", "hi"), null, TR));
        assertNull(ReplyQuote.of(null, null, TR));
    }

    @Test public void theOriginalHereGivesTheLatestTextAndItsSender() {
        ChatMessage o = msg("o1", "Alice", "Ahoj,\n\njak   to jde?");
        JSONObject q = ReplyQuote.of(reply(o, "Ahoj, jak to jde?"), o, TR);
        assertEquals("o1", q.optString("id"));
        assertEquals("Alice", q.optString("sender"));
        assertEquals("Ahoj, jak to jde?", q.optString("text")); // folded into one paragraph
        assertEquals("", q.optString("icon"));
        assertEquals("text", q.optString("kind"));
        assertTrue(q.optBoolean("found"));
        assertTrue(q.optString("color").matches("^#ff[0-9a-f]{6}$"));
        assertTrue(q.optString("tint").matches("^#24[0-9a-f]{6}$"));
        assertEquals(q.optString("color").substring(3), q.optString("tint").substring(3)); // the same hue, faint
    }

    @Test public void mineSaysYou() {
        ChatMessage o = msg("o1", "Mike", "hello");
        o.mine = true;
        JSONObject q = ReplyQuote.of(reply(o, "hello"), o, TR);
        assertEquals("[quote.you]", q.optString("sender"));
        assertTrue(q.optBoolean("mine"));
    }

    @Test public void notHereItUsesWhatTheReplyCarried() {
        JSONObject q = ReplyQuote.of(reply(null, "Old news"), null, TR);
        assertEquals("gone-1", q.optString("id"));
        assertEquals("Alice", q.optString("sender"));
        assertEquals("Old news", q.optString("text"));
        assertFalse(q.optBoolean("found"));
        // A file quoted by the web or another phone: "📎 name" → the paperclip and the name.
        JSONObject f = ReplyQuote.of(reply(null, "📎 report.pdf"), null, TR);
        assertEquals("file", f.optString("kind"));
        assertEquals("paperclip", f.optString("icon"));
        assertEquals("report.pdf", f.optString("text"));
        // A sealed one: the lock, never the code's ciphertext.
        JSONObject s = ReplyQuote.of(reply(null, "🔒"), null, TR);
        assertEquals("lock", s.optString("icon"));
        assertEquals("[quote.sealed]", s.optString("text"));
    }

    @Test public void mediaShowsItsIconAndSaysWhatItIs() {
        ChatMessage photo = msg("p", "Alice", "");
        photo.fileName = "IMG_1.jpg"; photo.fileMime = "image/jpeg"; photo.fileImage = true;
        JSONObject q = ReplyQuote.of(reply(photo, "📎 IMG_1.jpg"), photo, TR);
        assertEquals("image", q.optString("icon"));
        assertEquals("IMG_1.jpg", q.optString("text"));
        ChatMessage voice = msg("v", "Alice", "");
        voice.fileName = "voice.m4a"; voice.fileMime = "audio/mp4";
        assertEquals("audio-lines", ReplyQuote.of(reply(voice, ""), voice, TR).optString("icon"));
        ChatMessage clip = msg("c", "Alice", "look");
        clip.fileName = "a.mp4"; clip.fileMime = "video/mp4";
        JSONObject vq = ReplyQuote.of(reply(clip, "look"), clip, TR);
        assertEquals("video", vq.optString("icon"));
        assertEquals("look", vq.optString("text")); // a caption wins over the file's name
        ChatMessage pos = msg("l", "Alice", "📍 50.08804, 14.42076 (±12 m) https://www.openstreetmap.org/");
        assertEquals("map-pin", ReplyQuote.of(reply(pos, pos.text), pos, TR).optString("icon"));
    }

    @Test public void aSealedOrVanishedOriginalIsNotQuoted() {
        ChatMessage sealed = msg("s", "Alice", "ciphertext==");
        sealed.sealed = new JSONObject();
        JSONObject q = ReplyQuote.of(reply(sealed, "🔒"), sealed, TR);
        assertEquals("sealed", q.optString("kind"));
        assertEquals("[quote.sealed]", q.optString("text"));
        sealed.sealPlain = "the secret";                      // opened here: the reply quotes it as the bubble shows it
        assertEquals("the secret", ReplyQuote.of(reply(sealed, "🔒"), sealed, TR).optString("text"));
        ChatMessage gone = msg("g", "Alice", "soon gone");
        gone.vanished = true;
        JSONObject v = ReplyQuote.of(reply(gone, "soon gone"), gone, TR);
        assertEquals("[quote.vanished]", v.optString("text"));
        assertEquals("timer", v.optString("icon"));
    }

    @Test public void twoLinesAtMost() {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < 60; i++) b.append("slovo ");
        String line = ReplyQuote.line(b.toString());
        assertTrue(line.codePointCount(0, line.length()) <= ReplyQuote.CHARS);
        assertTrue(line.endsWith("…"));
        assertEquals("a b", ReplyQuote.line(" a ‮\n b "));       // no bidi override, no line break
        assertEquals("", ReplyQuote.line(null));
    }

    @Test public void theSameSenderHasTheSameColour() {
        ChatMessage o = msg("o1", "Alice", "x");
        String c1 = ReplyQuote.of(reply(o, "x"), o, TR).optString("color");
        String c2 = ReplyQuote.of(reply(null, "x"), null, TR).optString("color");
        assertEquals(c1, c2);
        ChatMessage p = msg("o2", "Bob", "x");
        assertNotEquals(c1, ReplyQuote.of(reply(p, "x"), p, TR).optString("color"));
    }

    /* ------------------------------------------------------------- runs */

    @Test public void oneSendersMessagesCloseInTimeAreARun() {
        ChatMessage a = msg("1", "Alice", "a"), b = msg("2", "Alice", "b");
        b.createdAt = a.createdAt + 60_000;
        assertTrue(Runs.continues(a, b));
        b.createdAt = a.createdAt + Runs.GAP_MS + 1;
        assertFalse(Runs.continues(a, b));                    // a pause starts a new run
        b.createdAt = a.createdAt + 1000;
        assertFalse(Runs.continues(a, msg("3", "Bob", "c"))); // another person
        assertFalse(Runs.continues(null, b));                 // the first in the list
        ChatMessage sys = ChatMessage.system("r", "Alice joined");
        assertFalse(Runs.continues(sys, b));
        assertFalse(Runs.continues(a, sys));
        ChatMessage mine = msg("4", "Alice", "d");
        mine.mine = true;
        assertFalse(Runs.continues(a, mine));
        ChatMessage early = msg("5", "Alice", "e");
        early.createdAt = a.createdAt - 1000;                 // out of order (history merged): its own run
        assertFalse(Runs.continues(a, early));
    }
}
