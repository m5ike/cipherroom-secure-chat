package cz.m5cet.app.chat;

import java.util.Map;
import java.util.function.Supplier;

/**
 * "Send another way" (6.8): the options of the messages the composer sends —
 * set in the "send.options" sheet (the long press on Send), kept in the
 * composer's form until they are turned off (like the web's SendOptions,
 * which stay on after a send), and applied only when a message is actually
 * sent:
 *  - asVoice (msgAsVoice): the text is spoken (voice/SpeakSend, the voice
 *    settings' speech) and goes as a voice message; with an empty field Send
 *    dictates first;
 *  - voiceText (msgVoiceText): with an empty field Send starts dictation and
 *    the text goes when it is stopped; a typed text goes at once;
 *  - sealed (msgSeal: the code; "" = a new random one for each message),
 *    vanishing (msgVanish: seconds), tap to reveal (msgTap) — the kinds of
 *    chat/Outgoing; they combine with each other and with the above.
 * "As voice" and "speak it, send text" exclude each other. Only text can be
 * sealed (as on the web), so a voice message goes without the code.
 * Pure Java: the JVM tests drive it with a plain map.
 */
public final class SendPlan {
    /** The form keys (the composer's $form). */
    public static final String AS_VOICE = "msgAsVoice", VOICE_TEXT = "msgVoiceText", TAP = "msgTap", VANISH = "msgVanish", SEAL = "msgSeal";

    /** What Send does with the field. */
    public enum Step {
        /** Nothing to send: an empty field and no voice option. */
        NONE,
        /** The text goes as a message (with its kinds). */
        TEXT,
        /** The text is spoken and goes as a voice message. */
        SPEAK,
        /** An empty field with "as voice": dictate, then speak what was heard and send it. */
        DICTATE_SPEAK,
        /** An empty field with "speak it, send text": dictate; the text goes when it is stopped. */
        DICTATE_TEXT,
        /** An earlier one is still being spoken: the text stays in the field for now. */
        WAIT
    }

    public final boolean asVoice, voiceText, tap;
    /** 0 = not vanishing. */
    public final int vanishSeconds;
    /** null = not sealed; "" = a new random code when it is sent. */
    public final String sealCode;

    private SendPlan(boolean asVoice, boolean voiceText, boolean tap, int vanishSeconds, String sealCode) {
        this.asVoice = asVoice;
        this.voiceText = voiceText && !asVoice;
        this.tap = tap;
        this.vanishSeconds = vanishSeconds;
        this.sealCode = sealCode;
    }

    /** The options as the form holds them now. */
    public static SendPlan of(Map<String, ?> form) {
        Object seal = form.get(SEAL);
        String code = seal == null ? null : String.valueOf(seal).trim();
        // Only spaces or dashes would seal with an empty code: that is "a random one" instead.
        if (code != null && Sealed.normalize(code).isEmpty()) code = "";
        return new SendPlan(Boolean.TRUE.equals(form.get(AS_VOICE)), Boolean.TRUE.equals(form.get(VOICE_TEXT)), Boolean.TRUE.equals(form.get(TAP)), seconds(form.get(VANISH)), code);
    }

    public boolean sealed() { return sealCode != null; }

    /** How many options are on (the sheet's "turn all off"). */
    public int count() { return (asVoice ? 1 : 0) + (voiceText ? 1 : 0) + (tap ? 1 : 0) + (vanishSeconds > 0 ? 1 : 0) + (sealed() ? 1 : 0); }

    /**
     * What Send does: hasText — the field has something; voiceBusy — "as
     * voice" or "speak it, send text" is still dictating or speaking an
     * earlier one.
     */
    public Step step(boolean hasText, boolean voiceBusy) {
        if (asVoice) return voiceBusy ? Step.WAIT : hasText ? Step.SPEAK : Step.DICTATE_SPEAK;
        if (voiceText && !hasText) return voiceBusy ? Step.WAIT : Step.DICTATE_TEXT;
        return hasText ? Step.TEXT : Step.NONE;
    }

    /**
     * send.option — asVoice | voiceText | tap | vanish[:seconds] | seal[:code]
     * | newCode | none: switches an option of the form (vanish without
     * seconds: defaultVanish; seal: on with an empty code — a random one when
     * sent; newCode: a code made up now). True when something changed.
     */
    public static boolean apply(Map<String, Object> form, String arg, int defaultVanish, Supplier<String> newCode) {
        String k = arg == null ? "" : arg.trim();
        int colon = k.indexOf(':');
        String name = colon < 0 ? k : k.substring(0, colon), value = colon < 0 ? null : k.substring(colon + 1);
        switch (name) {
            case "asVoice": if (toggle(form, AS_VOICE)) form.remove(VOICE_TEXT); return true;
            case "voiceText": if (toggle(form, VOICE_TEXT)) form.remove(AS_VOICE); return true;
            case "tap": toggle(form, TAP); return true;
            case "vanish": {
                int s = value == null ? (form.containsKey(VANISH) ? 0 : defaultVanish > 0 ? defaultVanish : 15) : seconds(value);
                if (s > 0) form.put(VANISH, (double) s); else form.remove(VANISH);
                return true;
            }
            case "seal":
                if (value != null) form.put(SEAL, value);
                else if (form.containsKey(SEAL)) form.remove(SEAL);
                else form.put(SEAL, "");
                return true;
            case "newCode": form.put(SEAL, newCode.get()); return true;
            case "none": case "normal":
                for (String key : new String[]{AS_VOICE, VOICE_TEXT, TAP, VANISH, SEAL}) form.remove(key);
                return true;
            default: return false;
        }
    }

    /**
     * What stays in the field once `sent` went (a voice made of it comes back
     * later): nothing when the field still holds just that; what was added
     * after it meanwhile (dictation sending at once); anything else as it is.
     * sent null: the whole field went.
     */
    public static String leftover(String field, String sent) {
        String now = field == null ? "" : field;
        if (sent == null) return "";
        String s = sent.trim(), t = now.trim();
        if (s.isEmpty()) return now;
        if (t.equals(s)) return "";
        if (t.startsWith(s)) return t.substring(s.length()).trim();
        return now;
    }

    /** On: switched off (false); off: switched on (true). */
    private static boolean toggle(Map<String, Object> form, String key) {
        if (Boolean.TRUE.equals(form.get(key))) { form.remove(key); return false; }
        form.put(key, Boolean.TRUE);
        return true;
    }

    private static int seconds(Object v) {
        double d;
        if (v instanceof Number) d = ((Number) v).doubleValue();
        else if (v == null) return 0;
        else try { d = Double.parseDouble(String.valueOf(v).trim()); } catch (NumberFormatException e) { return 0; }
        if (Double.isNaN(d) || d <= 0) return 0;
        return (int) Math.min(d, 7 * 24 * 3600);
    }
}
