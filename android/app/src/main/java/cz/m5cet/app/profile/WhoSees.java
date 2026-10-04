package cz.m5cet.app.profile;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 6.10: who sees what of the profile card, in words a person can check at a
 * glance (Settings' profile card, the editor's "Who sees what") — and what
 * a tap on a sender's avatar may show.
 *
 * The items are named by keys: "nickname", "about", "avatar", "cover" and
 * "field:<index>" (the card's fields in their order). An item counts only
 * with a value that would be shared (the same check as ProfileCard.viewFor:
 * a field whose value does not check out for its type is shared with no
 * one). The audiences nest — the public sees the public items, room members
 * the room and public ones — so:
 *
 *   seenBy(card, "public")   what anyone with the username reads
 *   seenBy(card, "room")     what the people in my rooms get
 *   onlyMe(card)             what stays in my vault (seen by no one else)
 *
 * Pure (org.json only).
 */
public final class WhoSees {
    private WhoSees() {}

    private static final String[] ITEMS = { "nickname", "about", "avatar", "cover" };

    /** The items `viewer` (me | room | public) sees of the card, in the card's order. */
    public static List<String> seenBy(JSONObject card, String viewer) {
        JSONObject c = ProfileCard.normalize(card);
        List<String> out = new ArrayList<>();
        for (String key : ITEMS) {
            JSONObject it = c.optJSONObject(key);
            if (it != null && !it.optString("value").isEmpty() && ProfileCard.visibleTo(it.optString("audience"), viewer)) out.add(key);
        }
        JSONArray fields = c.optJSONArray("fields");
        for (int i = 0; fields != null && i < fields.length(); i++) {
            JSONObject f = fields.optJSONObject(i);
            if (f == null || !ProfileCard.visibleTo(f.optString("audience"), viewer)) continue;
            if (!ProfileCard.cleanValue(f.optString("type"), f.optString("value")).isEmpty()) out.add("field:" + i);
        }
        return out;
    }

    /** What no one else sees: the items marked "only me". */
    public static List<String> onlyMe(JSONObject card) {
        List<String> out = seenBy(card, "me");
        out.removeAll(seenBy(card, "room"));
        return out;
    }

    /** {public: [keys], room: [keys], me: [keys only I see]} — the editor's and the settings' summary. */
    public static JSONObject summary(JSONObject card) {
        try {
            return new JSONObject().put("public", new JSONArray(seenBy(card, "public"))).put("room", new JSONArray(seenBy(card, "room"))).put("me", new JSONArray(onlyMe(card)));
        } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    /**
     * What a tap on a sender's avatar shows (null: nothing to show). Another
     * member: only the view they sent the room, checked again as anything
     * handed over (ProfileCard.normalizeShared — an item they did not share
     * never reaches this phone). Me: my card as room members see it (never
     * what is "only me").
     */
    public static JSONObject senderView(JSONObject sharedByThem, JSONObject myCard, boolean me) {
        JSONObject v = me ? (myCard == null ? null : ProfileCard.viewFor(myCard, "room")) : ProfileCard.normalizeShared(sharedByThem);
        return ProfileCard.isEmptyView(v) ? null : v;
    }
}
