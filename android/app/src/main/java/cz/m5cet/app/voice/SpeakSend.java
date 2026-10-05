package cz.m5cet.app.voice;

/**
 * Speak and send (6.7) — the composer's "Send another way" sheet:
 *
 *  - "Send the text as voice" (compose › asVoice): the text in the field —
 *    or, when the field is empty, what is dictated now — spoken by a voice
 *    (the phone's, or the operator's speech module when the voice settings
 *    say so) and sent as an end-to-end encrypted voice message, exactly like
 *    a recorded one (no text goes along);
 *  - "Speak it, send text" (compose › voiceText): dictation into the field,
 *    and when it is stopped the text goes as an ordinary message.
 *
 * Pure Java (the JVM tests drive it with a pretend dictation and voice); the
 * composer is its {@link Io}. One flow at a time:
 *
 *   IDLE ─asVoice (text in the field)→ SPEAKING ─clip→ send voice, clear → IDLE
 *   IDLE ─asVoice (empty) / asText→ DICTATING ─stop→ FINISHING ─dictation ended→
 *        (text) SPEAKING … / send the text, clear → IDLE;  (nothing heard) → IDLE
 *   any ─cancel (the composer goes away)→ IDLE (nothing is sent)
 * A voice that failed leaves the text in the field (it can still be sent as text).
 */
public final class SpeakSend {
    public enum Mode { TEXT, VOICE }
    public enum State { IDLE, DICTATING, FINISHING, SPEAKING }

    public interface Done<T> { void done(T value, String error); }

    /** What the composer does for the flow. */
    public interface Io<C> {
        boolean canDictate();
        /** Dictation into the field (the composer shows the text as it comes; dictationEnded() at the end). */
        void startDictation();
        /** Stop it; the last words still come, then dictationEnded(). */
        void stopDictation();
        String fieldText();
        void clearField();
        /** The text as a voice message's clip (TTS). */
        void speak(String text, Done<C> done);
        void sendText(String text);
        void sendVoice(C clip);
        /** A notice (a strings key, and a detail or ""). */
        void notice(String key, String detail);
        /** The flow changed (the composer's icons). */
        default void changed(State state, Mode mode) { }
    }

    private final Io<Object> io;
    private State state = State.IDLE;
    private Mode mode = Mode.TEXT;
    private int run;

    @SuppressWarnings("unchecked")
    public <C> SpeakSend(Io<C> io) { this.io = (Io<Object>) io; }

    public State state() { return state; }
    public Mode mode() { return mode; }
    public boolean busy() { return state != State.IDLE; }

    /** send.options › "Send the text as voice". */
    public void asVoice() {
        if (state != State.IDLE) { if (state == State.DICTATING) stop(); return; }
        String text = io.fieldText().trim();
        if (!text.isEmpty()) { speak(text); return; }
        dictate(Mode.VOICE);
    }

    /** send.options › "Speak it, send text". */
    public void asText() {
        if (state != State.IDLE) { if (state == State.DICTATING) stop(); return; }
        dictate(Mode.TEXT);
    }

    private void dictate(Mode m) {
        if (!io.canDictate()) { io.notice("look.dictate.none", ""); return; }
        mode = m;
        set(State.DICTATING);
        io.notice(m == Mode.VOICE ? "speakSend.speakNow" : "speakSend.speakNowText", "");
        io.startDictation();
    }

    /** The stop square (or Send) while dictating: finish the words, then go on. */
    public void stop() {
        if (state != State.DICTATING) return;
        set(State.FINISHING);
        io.stopDictation();
    }

    /** The dictation is over (stopped, given up, or failed): what is in the field is final. */
    public void dictationEnded() {
        if (state != State.DICTATING && state != State.FINISHING) return;
        String text = io.fieldText().trim();
        if (text.isEmpty()) { io.notice("voice.nothingHeard", ""); set(State.IDLE); return; }
        if (mode == Mode.TEXT) {
            io.sendText(text);
            io.clearField();
            set(State.IDLE);
            return;
        }
        speak(text);
    }

    private void speak(String text) {
        mode = Mode.VOICE;
        set(State.SPEAKING);
        final int mine = ++run;
        io.notice("voice.synthesizing", "");
        io.speak(text, (clip, error) -> {
            if (mine != run || state != State.SPEAKING) return; // cancelled meanwhile
            if (clip == null) {
                io.notice(errorKey(error), detail(error));
                set(State.IDLE);
                return;
            }
            io.sendVoice(clip);
            io.clearField();
            set(State.IDLE);
        });
    }

    /** The composer went away (or a voice recording started): nothing more happens, nothing is sent. */
    public void cancel() {
        if (state == State.IDLE) return;
        run++;
        set(State.IDLE);
    }

    private void set(State s) {
        if (state == s) return;
        state = s;
        io.changed(s, mode);
    }

    /** The strings key for Voice.textToVoiceMessage's error. */
    static String errorKey(String error) {
        if (error == null) return "voice.failed";
        if (error.startsWith("tts-none")) return "speakSend.noVoice";
        if (error.startsWith("tts-server-off")) return "speakSend.serverOff";
        // 6.12 (G-14): the person did not let the server's speech provider read it — nothing was sent.
        if (error.equals("declined")) return "speakSend.declined";
        return "speakSend.failed";
    }

    static String detail(String error) {
        if (error == null) return "";
        int colon = error.indexOf(": ");
        return colon < 0 ? "" : error.substring(colon + 2);
    }

    /** RIFF … WAVE: the bytes are a WAV file (the server's Piper voices answer with one). */
    public static boolean isWav(byte[] b) {
        return b != null && b.length >= 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F' && b[8] == 'W' && b[9] == 'A' && b[10] == 'V' && b[11] == 'E';
    }
}
