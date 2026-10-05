package cz.m5cet.app.voice;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;

/**
 * 6.12 (security analysis G-14, the Android side of the web's
 * serverVoiceConsent, client/src/lib/speak-send.ts): voice.engine = server
 * means the server's speech provider reads the text of a voice message (or
 * hears a dictation) — the message itself still goes end-to-end encrypted.
 * The first time in a room the person is asked, the provider named; "no"
 * sends nothing. A yes holds for that room until the app locks (M5.forgetSecrets)
 * or the process ends — the web's holds until the page reloads.
 *
 * Pure (the question is the caller's dialog): ServerVoiceConsentTest.
 */
public final class ServerVoiceConsent {
    private ServerVoiceConsent() {}

    /** What is sent: the text to be spoken, or a recording to be transcribed. */
    public enum Use { SPEAK, TRANSCRIBE }

    /** Asks the person (on the main thread): the provider's name, then yes or no. */
    public interface Ask { void ask(Use use, String provider, Consumer<Boolean> answer); }

    private static final Set<String> given = ConcurrentHashMap.newKeySet();

    static String slot(String room, Use use) { return use + "|" + (room == null ? "" : room); }

    /** Whether the person agreed in this room already (this process, since the last lock). */
    public static boolean given(String room, Use use) { return given.contains(slot(room, use)); }

    /**
     * then(true) at once when agreed earlier in this room, else after asking
     * (a yes is remembered for the room); then(false) for a no or no one to ask.
     */
    public static void check(String room, Use use, String provider, Ask ask, Consumer<Boolean> then) {
        String k = slot(room, use);
        if (given.contains(k)) { then.accept(true); return; }
        if (ask == null) { then.accept(false); return; }
        ask.ask(use, provider == null || provider.trim().isEmpty() ? "?" : provider.trim(), yes -> {
            if (Boolean.TRUE.equals(yes)) given.add(k);
            then.accept(Boolean.TRUE.equals(yes));
        });
    }

    /** The app locked (or the tests): ask again everywhere. */
    public static void reset() { given.clear(); }
}
