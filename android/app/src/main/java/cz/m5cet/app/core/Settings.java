package cz.m5cet.app.core;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.LinkedHashMap;
import java.util.Map;

import cz.m5cet.app.security.Vault;

/**
 * The user's settings (6.1): one JSON object in the vault's system tier,
 * nested by area ("voice.rate", "location.inHeader"…). Screens read it as
 * $settings and change it with the actions setting.set / setting.toggle, so
 * the whole settings UI is the design's (Android › Design) and not code.
 *
 * Every known key has a typed default here; a value of the wrong type (an
 * old bundle, a typo in a design) falls back to it.
 */
public final class Settings {
    public interface Listener { void onSetting(String key, Object value); }

    /** key → default (Boolean, Double or String). */
    public static final Map<String, Object> DEFAULTS = new LinkedHashMap<>();
    static {
        // Messages
        DEFAULTS.put("messages.vanishSeconds", 60.0);    // a vanishing message's time on screen (web presets 4 … 7200)
        DEFAULTS.put("messages.ttlMinutes", 0.0);        // every message expires after this (0 = never; ≤ 10 080)
        DEFAULTS.put("messages.receipts", true);         // send "delivered" receipts
        DEFAULTS.put("messages.readReceipts", true);     // send "read" receipts
        DEFAULTS.put("messages.enterSends", false);
        // Location
        DEFAULTS.put("location.inHeader", false);        // the current position in each message's header
        DEFAULTS.put("location.track", false);           // keep sending it to the server (tracking)
        DEFAULTS.put("location.interval", 60.0);         // seconds between track points
        DEFAULTS.put("location.precise", true);
        // Voice
        DEFAULTS.put("voice.engine", "device");          // device | server
        DEFAULTS.put("voice.lang", "");                  // "" = the app's language
        DEFAULTS.put("voice.voice", "");                 // a TextToSpeech voice name ("" = default)
        DEFAULTS.put("voice.rate", 1.0);
        DEFAULTS.put("voice.pitch", 1.0);
        DEFAULTS.put("voice.autoplay", false);           // read incoming messages aloud
        DEFAULTS.put("voice.dictateSpeak", false);       // dictated text is read back (TTS)
        DEFAULTS.put("voice.dictateSend", false);        // send the dictated text at once
        // Calls
        DEFAULTS.put("calls.audioText", false);          // outgoing calls start in audio ↔ text mode
        DEFAULTS.put("calls.speaker", true);
        DEFAULTS.put("callLog", false);                  // (5.x key, kept at the top level)
        // Appearance (on top of the design's theme)
        DEFAULTS.put("appearance.tone", "system");       // system | light | dark
        DEFAULTS.put("appearance.accent", "");           // "" = the design's primary, or #rrggbb
        DEFAULTS.put("appearance.fontScale", 1.0);
        DEFAULTS.put("appearance.density", "normal");    // compact | normal | comfortable
        DEFAULTS.put("appearance.bubbles", "rounded");   // rounded | square | minimal
        DEFAULTS.put("appearance.preset", "design");     // the template: design (the design's own look) or a web template id (6.1's key, missing here until 6.2)
        // 6.2 look (ui/look/Look.java): these apply in place — the screen is drawn again
        DEFAULTS.put("look.variant", "");                // the template's colour variant (ui/look/Palette; "" = its own colour)
        DEFAULTS.put("look.font", "");                   // "" = the template's / design's; sans | serif | mono | condensed | medium | light | casual | cursive
        DEFAULTS.put("look.motion", "normal");           // off | subtle | normal | lively
        DEFAULTS.put("look.speed", 1.0);                 // animation speed: 0.5 (slow) … 2 (fast)
        DEFAULTS.put("look.buttons", "filled");          // the main buttons: filled | tonal | outlined | text
        DEFAULTS.put("look.shape", "pill");              // buttons, chips, fields: pill | rounded | square
        DEFAULTS.put("look.press", "ripple");            // ripple | scale | none
        DEFAULTS.put("look.haptics", true);              // a short tick on buttons
        DEFAULTS.put("look.toolsDock", true);            // Tools as a floating dock above the composer (else a sheet from the bottom)
        DEFAULTS.put("look.hintSendOptions", false);     // the one-time "hold Send for more" hint was shown
        DEFAULTS.put("look.v", 0.0);                     // the look settings' version (ui/look/Migration)
        // NFC
        DEFAULTS.put("nfc.emulate", false);              // answer as a tag with the room invite
        // 6.3 nfc (the workbench): the saved reader and the key-dictionary policy
        DEFAULTS.put("nfc.reader", "internal");          // internal | usb | bluetooth (the chosen reader)
        DEFAULTS.put("nfc.keyDictionary", "");           // the user's MIFARE key list (newline/space-separated 12-hex keys); NOT recovery
        DEFAULTS.put("nfc.saveKeys", false);             // keep the key dictionary across sessions (else only in the open workbench)
        // 6.7 notify (push/NotifyPrefs: kinds, privacy, channel order, quiet hours, away-capable)
        cz.m5cet.app.push.NotifyPrefs.defaults(DEFAULTS);
        // Security (the SYS tier is readable while the app is locked, so the PIN pad can read these)
        DEFAULTS.put("security.shufflePin", false);      // the PIN keys are not in order and reshuffle after every tap
        // 6.2 fixes (lock, enrolment, passkeys)

        // 6.2 people (People widget, contacts)
        DEFAULTS.put("people.contacts", true);           // link people with the phone's contacts ("message / call via M5cet" there); off removes the rows

        // 6.2 bubbles (map preview, message details, hide/delete)

        // 6.2 look (templates, colour variants, fonts, buttons, Tools dock)

        // 6.7 voice: the voice changer (voiceFx.*)
        cz.m5cet.app.voice.MicFx.defaults(DEFAULTS);
        // 6.8 conversations: the rooms as Android conversations (telecom/ConversationPlan)
        cz.m5cet.app.telecom.ConversationPlan.defaults(DEFAULTS);
    }

    private final Vault vault;
    private JSONObject data;
    private final java.util.List<Listener> listeners = new java.util.concurrent.CopyOnWriteArrayList<>();

    public Settings(Vault vault) { this.vault = vault; }

    private synchronized JSONObject data() {
        if (data == null) data = vault.json(Vault.Tier.SYS, "settings");
        return data;
    }

    public void addListener(Listener l) { listeners.add(l); }
    public void removeListener(Listener l) { listeners.remove(l); }

    /** The settings as a screen sees them ($settings): every default filled in. */
    public synchronized JSONObject scope() {
        JSONObject out = new JSONObject();
        for (String k : DEFAULTS.keySet()) put(out, k, get(k));
        return out;
    }

    public synchronized Object get(String key) {
        Object dflt = DEFAULTS.get(key);
        Object v = find(data(), key);
        if (dflt == null) return v;
        if (v == null || v == JSONObject.NULL) return dflt;
        if (dflt instanceof Boolean) return v instanceof Boolean ? v : dflt;
        if (dflt instanceof Double) return v instanceof Number ? ((Number) v).doubleValue() : dflt;
        return v instanceof String ? v : dflt;
    }

    public boolean bool(String key) { return Boolean.TRUE.equals(get(key)); }
    public double num(String key) { Object v = get(key); return v instanceof Number ? ((Number) v).doubleValue() : 0; }
    public String str(String key) { Object v = get(key); return v == null ? "" : String.valueOf(v); }

    /** Sets a value; a string is converted to the key's type ("true", "1.2"). Unknown keys are refused. */
    public boolean set(String key, Object value) {
        Object dflt = DEFAULTS.get(key);
        if (dflt == null) { Log.w("settings", "unknown setting " + key); return false; }
        Object v = coerce(dflt, value);
        if (v == null) return false;
        synchronized (this) {
            put(data(), key, v);
            vault.putJson(Vault.Tier.SYS, "settings", data());
        }
        for (Listener l : listeners) l.onSetting(key, v);
        return true;
    }

    public boolean toggle(String key) { return DEFAULTS.get(key) instanceof Boolean && set(key, !bool(key)); }

    static Object coerce(Object dflt, Object value) {
        if (dflt instanceof Boolean) {
            if (value instanceof Boolean) return value;
            String s = String.valueOf(value).trim();
            return s.equals("true") || s.equals("1") || s.equals("on") ? Boolean.TRUE : s.equals("false") || s.equals("0") || s.equals("off") || s.isEmpty() ? Boolean.FALSE : null;
        }
        if (dflt instanceof Double) {
            if (value instanceof Number) return ((Number) value).doubleValue();
            try { double d = Double.parseDouble(String.valueOf(value).trim()); return Double.isFinite(d) ? d : null; } catch (NumberFormatException e) { return null; }
        }
        String s = value == null ? "" : String.valueOf(value);
        return s.length() > 200 ? s.substring(0, 200) : s;
    }

    private static Object find(JSONObject o, String key) {
        if (o.has(key)) return o.opt(key);
        String[] path = key.split("\\.");
        Object cur = o;
        for (String p : path) {
            if (!(cur instanceof JSONObject)) return null;
            cur = ((JSONObject) cur).opt(p);
        }
        return cur;
    }

    private static void put(JSONObject o, String key, Object v) {
        String[] path = key.split("\\.");
        JSONObject cur = o;
        try {
            for (int i = 0; i < path.length - 1; i++) {
                JSONObject next = cur.optJSONObject(path[i]);
                if (next == null) { next = new JSONObject(); cur.put(path[i], next); }
                cur = next;
            }
            cur.put(path[path.length - 1], v);
        } catch (JSONException ignored) { }
    }
}
