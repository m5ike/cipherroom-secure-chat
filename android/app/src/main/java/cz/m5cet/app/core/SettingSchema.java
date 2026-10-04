package cz.m5cet.app.core;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 6.10 (security analysis G-20, G-21): what a setting may hold and who may
 * change it.
 *
 * Values: every key has a rule beside its type (core/Settings.DEFAULTS) — a
 * range for a number, a list or a pattern for a text — and Settings.set
 * refuses anything else, whoever asks. A design used to be able to put any
 * 200 characters into a text setting ("setting.set notify.quietFrom={$msg.text}"),
 * and some of them leave the phone (notify.* goes to the server within
 * seconds, PUT /api/account/notify).
 *
 * Privacy keys: settings that widen what leaves the phone or who sees it —
 * the system call log and its names, the rooms as Android conversations,
 * every notification setting (the server keeps them), speech on the server,
 * the position, the NFC tag, receipts, the phone's contacts, the PIN pad. An
 * action of the design (setting.set / setting.toggle, a library step, a
 * change handler) never changes them; only the user's own tap on the
 * setting's switch or choice (an element bound to it) or the app's code does.
 */
public final class SettingSchema {
    private SettingSchema() {}

    /** Keys no action of the design may change (exact). */
    private static final Set<String> PRIVATE = new HashSet<>(Arrays.asList(
        "callLog",                          // calls into the phone's call log (any app with READ_CALL_LOG reads it)
        "voice.engine",                     // device | server: speech (dictation, voice messages) on the server
        "voice.autoplay",                   // read every incoming message aloud
        "voice.dictateSend",                // dictated text is sent without a look
        "nfc.emulate",                      // answer as a tag with the room's invite
        "nfc.keyDictionary",                // typed in the NFC workbench, never by a design
        "messages.receipts", "messages.readReceipts",
        "people.contacts"));                // M5cet rows in the phone's contacts
    /** …and every key under these. */
    private static final String[] PRIVATE_AREAS = {
        "calls.",                           // calls.logName (names in the call log), calls.history, how calls start
        "conversations.",                   // the rooms as conversation shortcuts, with their names
        "notify.",                          // what a notification shows; synced to the server
        "location.",                        // tracking, the position in each message, its precision
        "security."};                       // the PIN pad

    private static final Map<String, double[]> RANGES = new HashMap<>();
    private static final Map<String, Pattern> TEXTS = new HashMap<>();

    private static void range(String key, double min, double max) { RANGES.put(key, new double[]{min, max}); }
    private static void text(String key, String regex) { TEXTS.put(key, Pattern.compile(regex)); }
    private static void oneOf(String key, String... values) {
        StringBuilder r = new StringBuilder("^(?:");
        for (int i = 0; i < values.length; i++) r.append(i == 0 ? "" : "|").append(Pattern.quote(values[i]));
        text(key, r.append(")$").toString());
    }

    /** A design's id (a template, a colour variant): lowercase, digits, - and _. */
    private static final String ID = "[a-z0-9][a-z0-9_-]{0,40}";
    private static final String HOUR = "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$";
    private static final String CHANNEL = "(?:android|webpush|email)";

    static {
        // Messages
        range("messages.vanishSeconds", 1, 86_400);
        range("messages.ttlMinutes", 0, 10_080);
        // Location
        range("location.interval", 5, 86_400);
        // Voice
        oneOf("voice.engine", "device", "server");
        text("voice.lang", "^(?:[a-z]{2,3}(?:-[A-Z]{2})?)?$");
        text("voice.voice", "^[A-Za-z0-9 _.#:@+-]{0,100}$");          // a TextToSpeech voice's name
        range("voice.rate", 0.1, 4);
        range("voice.pitch", 0.1, 4);
        // Calls
        oneOf("calls.logName", "app", "room", "people");
        // Appearance
        oneOf("appearance.tone", "system", "light", "dark");
        text("appearance.accent", "^(?:|[a-z]{2,16}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8})$");
        range("appearance.fontScale", 0.5, 3);
        oneOf("appearance.density", "compact", "normal", "comfortable");
        oneOf("appearance.bubbles", "rounded", "square", "minimal");
        text("appearance.preset", "^" + ID + "$");
        // Look (6.2)
        text("look.variant", "^(?:" + ID + ")?$");
        oneOf("look.font", "", "sans", "serif", "mono", "condensed", "medium", "light", "casual", "cursive");
        oneOf("look.motion", "off", "subtle", "normal", "lively");
        range("look.speed", 0.1, 4);
        oneOf("look.buttons", "filled", "tonal", "outlined", "text");
        oneOf("look.shape", "pill", "rounded", "square");
        oneOf("look.press", "ripple", "scale", "none");
        range("look.v", 0, 1000);
        // NFC
        oneOf("nfc.reader", "internal", "usb", "bluetooth");
        // The user's own list as typed in the workbench (12-hex keys; nfc/CardOps.keyDictionary skips the rest): visible text, no hidden characters.
        text("nfc.keyDictionary", "^[\\p{L}\\p{N}\\p{P}\\p{S}\\p{Zs}\\t\\r\\n]{0,200}$");
        // Notifications (6.7)
        oneOf("notify.privacy", "", "neutral", "sender", "room", "content");
        text("notify.order", "^(?:" + CHANNEL + "(?:," + CHANNEL + "){0,2})?$");
        text("notify.quietFrom", HOUR);
        text("notify.quietTo", HOUR);
        // The voice changer (6.7)
        oneOf("voiceFx.preset", "off", "higher", "lower", "deep", "robot", "echo", "whisper", "anonymous", "custom");
        range("voiceFx.pitch", -24, 24);
        range("voiceFx.formant", -24, 24);
        range("voiceFx.robot", 0, 2_000);
        range("voiceFx.echo", 0, 1);
        range("voiceFx.echoMs", 0, 5_000);
        range("voiceFx.echoFeedback", 0, 1);
        range("voiceFx.whisper", 0, 1);
        range("voiceFx.gain", -48, 48);
    }

    /** The keys with a rule for a number or a text (a yes/no setting needs none). */
    public static Set<String> ruled() {
        Set<String> s = new HashSet<>(RANGES.keySet());
        s.addAll(TEXTS.keySet());
        return Collections.unmodifiableSet(s);
    }

    /** Whether a design's action is kept from this setting (only the user's own switch or the app changes it). */
    public static boolean privacy(String key) {
        if (key == null) return true;
        if (PRIVATE.contains(key)) return true;
        for (String area : PRIVATE_AREAS) if (key.startsWith(area)) return true;
        return false;
    }

    /**
     * Whether the value (already of the key's type, core/Settings.coerce) is
     * one this key may hold: a yes/no any, a number within its range, a text
     * that matches its list or pattern. A number or a text without a rule is
     * refused (fail closed — SettingSchemaTest keeps every key ruled).
     */
    public static boolean valid(String key, Object value) {
        if (key == null || value == null) return false;
        if (value instanceof Boolean) return true;
        if (value instanceof Number) {
            double[] r = RANGES.get(key);
            double d = ((Number) value).doubleValue();
            return r != null && Double.isFinite(d) && d >= r[0] && d <= r[1];
        }
        if (value instanceof String) {
            Pattern p = TEXTS.get(key);
            return p != null && p.matcher((String) value).matches();
        }
        return false;
    }
}
