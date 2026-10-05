package cz.m5cet.app.nfc;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * 6.12: a connection tag's body, read and written (docs/protocol-v4.md § 16).
 * Writers write format 2 only — an invitation (recommended: the room key stays
 * on the server, sealed; the tag ends with the invite) or an offline tag
 * (under a 20-symbol code shown once). Readers open format 2, and format 1
 * with its PIN — marked weak, with the offer to rewrite the tag as format 2.
 * Blocking (an invitation goes to the server): call off the main thread.
 */
public final class ConnTag {
    private ConnTag() {}

    /** What a tag's body opened to. */
    public static final class Read {
        /** "v2-inv", "v2-off", "v1" or "" (not a connection tag). */
        public String format = "";
        /** Format 1: whoever read the tag can guess its PIN offline. */
        public boolean weak;
        /** The room, when it opened. */
        public TagV2.Room room;
        /** What is missing to open it: "code" (offline), "pin" (format 1), "" (nothing). */
        public String need = "";
        /** Why it did not open (a short code: wrong-code, wrong-pin, other-server, burned, not-found, network, bad-tag…). */
        public String error = "";
        /** An invitation's server, when it is not this app's. */
        public String origin = "";

        public JSONObject json() {
            JSONObject o = new JSONObject();
            try {
                o.put("format", format).put("weak", weak).put("need", need).put("error", error).put("origin", origin);
                if (room != null) o.put("room", new JSONObject().put("room", room.room).put("passphrase", room.passphrase).put("name", room.name == null ? "" : room.name));
            } catch (JSONException ignored) { }
            return o;
        }
    }

    /**
     * Opens a tag body. `secret`: what the reader typed — the offline tag's code
     * (20 symbols) or a format-1 PIN (4–16 digits); may be empty. `trustedOrigin`:
     * the app's server — an invitation is redeemed only there.
     */
    public static Read open(String body, String secret, String trustedOrigin) { return open(body, secret, trustedOrigin, true); }

    /** As open; `redeem` false leaves an invitation unredeemed (need = "redeem"): every redemption uses one of its uses. */
    public static Read open(String body, String secret, String trustedOrigin, boolean redeem) {
        Read r = new Read();
        String s = secret == null ? "" : secret.trim();
        if (body == null) return r;
        if (body.startsWith(TagV2.PREFIX)) {
            TagV2.Tag tag;
            try { tag = TagV2.parse(body); } catch (TagV2.TagError e) { r.format = "v2"; r.error = "bad-tag"; return r; }
            if (tag.invite()) {
                r.format = "v2-inv";
                String mine = TagV2.safeOrigin(trustedOrigin == null ? "" : trustedOrigin);
                if (mine == null || !mine.equals(tag.o)) { r.error = "other-server"; r.origin = tag.o; return r; }
                if (!redeem) { r.need = "redeem"; return r; }
                try { r.room = ShareInvite.redeem(tag); }
                catch (java.io.IOException e) {
                    String m = e.getMessage() == null ? "" : e.getMessage();
                    r.error = m.equals("wrong-code") || m.equals("burned") || m.equals("not-found") ? m : "network";
                }
                catch (java.security.GeneralSecurityException e) { r.error = "corrupt"; }
                return r;
            }
            r.format = "v2-off";
            if (TagV2.normalize(s, TagV2.OFFLINE_CODE_SYMBOLS) == null) { r.need = "code"; if (!s.isEmpty()) r.error = "bad-code"; return r; }
            try { r.room = TagV2.openOffline(tag, s); }
            catch (TagV2.TagError e) { r.error = "auth-failed".equals(e.code) ? "wrong-code" : "bad-tag"; }
            return r;
        }
        if (body.startsWith(TagV2.V1_PREFIX)) {
            r.format = "v1";
            r.weak = true;
            if (!Nfc.validPin(s)) { r.need = "pin"; return r; }
            JSONObject o = Nfc.open(body, s);
            if (o == null) { r.error = "wrong-pin"; return r; }
            r.room = new TagV2.Room(o.optString("room"), o.optString("passphrase"), o.optString("name", ""), o.optString("app", ""));
            return r;
        }
        return r;
    }

    /** A format-2 body ready to write, and the offline code to show once (null for an invitation). */
    public static final class Prepared {
        public final String body, code;
        public final long expiresAt;
        Prepared(String body, String code, long expiresAt) { this.body = body; this.code = code; this.expiresAt = expiresAt; }
    }

    /**
     * A format-2 body for the room `card` ({room, passphrase, name}): "inv" — an
     * invitation made on the server at `origin` (10 uses, 7 days); "off" — sealed
     * under a fresh code with the room KDF's cost (Argon2id 64 MiB, 3 passes).
     */
    public static Prepared prepare(JSONObject card, String kind, String origin, String appVersion) throws Exception {
        // No suggested name: a reader keeps its own (§ 16.3 / 16.4); the writer's nickname is not handed out.
        TagV2.Room room = new TagV2.Room(card.optString("room"), card.optString("passphrase"), "", appVersion);
        if ("off".equals(kind)) {
            String code = TagV2.newCode();
            TagV2.Tag tag = TagV2.sealOffline(room, code, TagV2.WRITE_MEMORY_KIB, TagV2.WRITE_PASSES, null, null);
            return new Prepared(TagV2.serialize(tag), TagV2.format(code), 0);
        }
        TagV2.Tag tag = TagV2.newInvite(origin);
        ShareInvite.Created c = ShareInvite.create(tag, room, room.name, ShareInvite.DEFAULT_USES, ShareInvite.DEFAULT_TTL_SEC);
        return new Prepared(TagV2.serialize(tag), null, c.expiresAt);
    }
}
