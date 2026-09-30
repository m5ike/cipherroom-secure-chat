package cz.m5cet.app.nfc;

import org.json.JSONObject;

import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The shapes of an M5Cet card's records and how to show / act on one (6.3), a
 * mirror of client/src/lib/nfc/records.ts (RECORD_META, recordSummary,
 * BUILDABLE_RECORDS) so the field names and the actions never drift between web
 * and Android.
 */
public final class Records {
    private Records() {}

    /** What to do once a record is opened. */
    public static final String DISPLAY = "display", SAVE = "save", RUN = "run";

    public static final class Meta {
        public final String label;       // i18n key of the record's name
        public final String icon;        // a lucide icon name
        public final String action;      // display | save | run
        public final String actionLabel; // i18n key of the action button
        public final boolean oneTimeDefault;
        public final boolean accountOnly;
        Meta(String label, String icon, String action, String actionLabel, boolean oneTimeDefault, boolean accountOnly) {
            this.label = label; this.icon = icon; this.action = action; this.actionLabel = actionLabel;
            this.oneTimeDefault = oneTimeDefault; this.accountOnly = accountOnly;
        }
    }

    private static final Map<String, Meta> META = new LinkedHashMap<>();
    static {
        META.put("passkey-backup", new Meta("nfc.rec.passkey", "key-round", SAVE, "nfc.rec.restore", false, true));
        META.put("identity-backup", new Meta("nfc.rec.identity", "shield-user", SAVE, "nfc.rec.restore", false, true));
        META.put("one-time-message", new Meta("nfc.rec.onetime", "flame", DISPLAY, "nfc.rec.show", true, false));
        META.put("message", new Meta("nfc.rec.message", "message-square-lock", DISPLAY, "nfc.rec.show", false, false));
        META.put("server-room", new Meta("nfc.rec.serverRoom", "radio", RUN, "nfc.rec.join", false, false));
        META.put("external-key", new Meta("nfc.rec.externalKey", "key", SAVE, "nfc.rec.import", false, false));
        META.put("contact", new Meta("nfc.rec.contact", "contact-round", SAVE, "nfc.rec.saveContact", false, false));
        META.put("wifi", new Meta("nfc.rec.wifi", "wifi", SAVE, "nfc.rec.connect", false, false));
        META.put("url-login", new Meta("nfc.rec.urlLogin", "log-in", RUN, "nfc.rec.open", false, false));
    }

    public static Meta meta(String type) { return META.get(type); }

    /** The record types a person builds by hand (the M5Cet builder offers these). */
    public static final List<String> BUILDABLE = Arrays.asList(
        "message", "one-time-message", "server-room", "wifi", "url-login", "contact", "external-key", "passkey-backup", "identity-backup");

    /** A one-line summary of a record for a list (no secrets) — mirrors recordSummary(). */
    public static String summary(String type, JSONObject d) {
        if (d == null) d = new JSONObject();
        switch (type) {
            case "wifi": return opt(d, "ssid", "Wi-Fi");
            case "url-login": return opt(d, "url", "");
            case "server-room": return d.has("name") ? d.optString("name") : d.optString("room", "");
            case "contact": return opt(d, "name", "");
            case "external-key": return opt(d, "label", "");
            case "message": case "one-time-message": {
                if (!d.optString("text", "").isEmpty()) { String t = d.optString("text"); return t.length() > 40 ? t.substring(0, 40) : t; }
                if (!d.optString("url", "").isEmpty()) return d.optString("url");
                JSONObject f = d.optJSONObject("file");
                return f != null ? f.optString("name", "…") : "…";
            }
            case "passkey-backup": case "identity-backup": {
                JSONObject acc = d.optJSONObject("account");
                if (acc != null && !acc.optString("username", "").isEmpty()) return acc.optString("username");
                return d.optString("user", "");
            }
            default: return "";
        }
    }

    private static String opt(JSONObject d, String key, String dflt) {
        String v = d.optString(key, "");
        return v.isEmpty() ? dflt : v;
    }
}
