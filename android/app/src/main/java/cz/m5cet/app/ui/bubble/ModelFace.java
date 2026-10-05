package cz.m5cet.app.ui.bubble;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;
import java.util.function.Predicate;

import cz.m5cet.app.chat.ChatMessage;
import cz.m5cet.app.fn.ModelIdentity;

/**
 * 6.11: a model's answer in the list — drawn as an INCOMING message under
 * the model's identity (its name, its icon in its colour), wherever it came
 * from:
 *
 *   here only     from system-messenger (a caller-only answer, an answer to
 *                 a click or a form, the check of a wrong call) — and the
 *                 older "function:&lt;keyword&gt;" ones; "only you see it"
 *   my room one   the answer this device sent to the room for the model
 *                 (flags.fn, mine): "via you"
 *   a peer's      a room answer another member's app sent (flags.fn, checked
 *                 by Payloads): "via &lt;their name&gt;" — the honest sender
 *
 * A command's own bubble (the call: fnLocal with its query) stays the
 * person's own. $msg.model is what the design draws:
 *   keyword, name, icon, emoji (the icon is not a lucide name: draw it as
 *   text), glyph (the lucide icon this app draws), color, line ("/keyword ·
 *   via Alice"), via (the sender's name, "" here only), mine (sent by me),
 *   error (the check of a wrong call).
 * Pure (org.json only).
 */
public final class ModelFace {
    private ModelFace() {}

    /** The words it needs (fnm.*), in the app's language. */
    public interface Tr { String t(String key); }

    /** The identity a message is drawn under; null for a person's message (and a command's own bubble). */
    public static ModelIdentity of(ChatMessage m) {
        if (m == null || "sys".equals(m.kind) || "note".equals(m.kind)) return null;
        if (m.model != null) return ModelIdentity.fromJson(m.model);
        if (m.fnCall()) return null;
        JSONObject fn = m.fnDraw();
        String sender = m.senderId == null ? "" : m.senderId;
        if (fn == null) return sender.startsWith("function:") ? ModelIdentity.of(sender.substring("function:".length()), m.senderName, null) : null;
        return ModelIdentity.fromJson(fn);
    }

    /** Only here (never sent): system-messenger, or an older caller-only answer. */
    public static boolean local(ChatMessage m) { return m != null && ModelIdentity.reservedSender(m.senderId); }

    /**
     * $msg.model for a model's answer (null for anything else). has: whether
     * this app draws a lucide icon (its set is the builders', not all of
     * lucide) — glyph is the one drawn ({@link #glyph}).
     */
    public static JSONObject scope(ChatMessage m, Tr tr, Predicate<String> has) {
        ModelIdentity id = of(m);
        if (id == null) return null;
        boolean local = local(m);
        String via = local ? "" : m.mine ? tr.t("quote.you") : m.senderName == null ? "" : m.senderName;
        String where = local ? tr.t("fnm.onlyYou") : m.mine ? tr.t("fnm.viaYou") : tr.t("fnm.via").replace("{name}", via);
        JSONObject fd = m.fnDraw();
        try {
            return new JSONObject().put("keyword", id.keyword).put("name", id.name).put("icon", id.icon).put("emoji", !id.lucide())
                .put("glyph", glyph(id, has)).put("color", id.color).put("line", "/" + id.keyword + " · " + where).put("via", via).put("mine", m.mine)
                .put("error", fd != null && fd.optBoolean("problem"));
        } catch (JSONException e) { return null; }
    }

    /** The default icons this app's set lacks, by a near one it has. */
    private static final Map<String, String> NEAR = new HashMap<>();

    static {
        String[] pairs = {
            "phone-call", "phone-outgoing", "phone-forwarded", "phone-outgoing", "message-square-text", "message-square", "network", "server",
            "cloud-sun", "cloud", "calculator", "hash", "receipt", "file-text", "id-card", "contact-round", "circle-help", "circle-question-mark",
            "chart-bar", "chart-column",
        };
        for (int i = 0; i + 1 < pairs.length; i += 2) NEAR.put(pairs[i], pairs[i + 1]);
    }

    /**
     * The lucide icon drawn for a model ("" for an emoji): its own when the
     * app has it, else a near one, else its keyword's, else a shorter name
     * ("cloud-sun" → "cloud"), else a bot.
     */
    public static String glyph(ModelIdentity id, Predicate<String> has) {
        if (!id.lucide()) return "";
        String byKeyword = ModelIdentity.of(id.keyword, id.name, null).icon;
        if (BOT.equals(byKeyword)) byKeyword = null; // the fallback comes last
        for (String c : new String[]{id.icon, NEAR.get(id.icon), byKeyword, byKeyword == null ? null : NEAR.get(byKeyword)}) if (c != null && has.test(c)) return c;
        for (String s = id.icon; s.indexOf('-') > 0; ) {
            s = s.substring(0, s.lastIndexOf('-'));
            if (has.test(s)) return s;
        }
        return BOT;
    }

    private static final String BOT = "bot";

    /** Who a run of messages belongs to (Runs): a model's answers continue only that model's (from the same sender). */
    public static String runKey(ChatMessage m) {
        ModelIdentity id = of(m);
        if (id == null) return null;
        return "model:" + id.keyword.toLowerCase(java.util.Locale.ROOT) + ":" + (local(m) ? "" : m.mine ? "me" : m.senderId);
    }
}
