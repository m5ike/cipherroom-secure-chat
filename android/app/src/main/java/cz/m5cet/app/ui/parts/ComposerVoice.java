package cz.m5cet.app.ui.parts;

import android.Manifest;
import android.widget.EditText;

import cz.m5cet.app.M5;
import cz.m5cet.app.chat.RoomSession;
import cz.m5cet.app.ui.MainActivity;
import cz.m5cet.app.voice.Dictation;
import cz.m5cet.app.voice.SpeakSend;
import cz.m5cet.app.voice.Voice;

/**
 * The composer's voice (6.7): dictation into the field and "speak and send"
 * (voice/SpeakSend) — kept out of Composer.java.
 *
 *  - dictation stops for real: the same icon again (or Send) stops it, the
 *    last words still land in the field; the icon follows the dictation's
 *    real state (it is the composer's only while the composer started it);
 *  - leaving the room (the composer goes away), a voice recording starting,
 *    or the app going to the background stop it and free the microphone;
 *  - "Send the text as voice": the field's text — or, empty, what is
 *    dictated now — spoken (the phone's voice, or the server's per the voice
 *    settings) and sent as a voice message without the text;
 *  - "Speak it, send text": dictation, then the text goes as a message;
 *    without the phone's recogniser and with the server's speech chosen, it
 *    is recorded and transcribed by the server instead.
 */
final class ComposerVoice implements SpeakSend.Io<Voice.Clip> {
    private final Composer c;
    private final MainActivity a;
    private final SpeakSend flow;
    private boolean mine;
    private boolean forFlow;
    private boolean sendWhenEnded;
    private String base = "";
    private final Runnable sync = this::sync;

    ComposerVoice(Composer c, MainActivity a) {
        this.c = c;
        this.a = a;
        this.flow = new SpeakSend(this);
    }

    private M5 app() { return a.app(); }
    private Voice voice() { return app().voice; }

    void attached() { voice().addStateListener(sync); sync(); }

    /** The composer went away: the flow is dropped, the composer's dictation stops (the words it has stay). */
    void detached() {
        voice().removeStateListener(sync);
        flow.cancel();
        sendWhenEnded = false;
        if (mine && voice().dictating()) voice().stopDictation();
    }

    /** A voice recording starts: dictation and any flow stop. */
    void recordingStarts() {
        flow.cancel();
        if (mine && voice().dictating()) voice().stopDictation();
    }

    boolean dictating() { return mine && voice().dictating(); }

    /* ---------------------------------------------------------- the icon */

    /** The dictation icon (in the field): start, or stop when it runs. */
    void toggleDictation() {
        if (flow.state() == SpeakSend.State.DICTATING) { flow.stop(); return; }
        // The square while the text is being spoken: nothing is sent (the text stays in the field).
        if (flow.state() == SpeakSend.State.SPEAKING) { flow.cancel(); return; }
        if (flow.busy()) return;
        if (dictating()) { voice().stopDictation(); return; }
        if (!Dictation.available(app())) { a.flash("", app().t("look.dictate.none"), "warn"); return; }
        c.withMic(() -> start(false));
    }

    /** Send while dictating: the last words first, then it goes. */
    boolean interceptSend() {
        if (flow.state() == SpeakSend.State.DICTATING) { flow.stop(); return true; }
        if (flow.busy()) return true;
        if (dictating()) { sendWhenEnded = true; voice().stopDictation(); return true; }
        return false;
    }

    /* ------------------------------------------------- speak and send */

    void asVoice() { if (requireRoom()) flow.asVoice(); }

    void asText() {
        if (!requireRoom()) return;
        if (!Dictation.available(app()) && "server".equals(app().settings.str("voice.engine"))) { c.recordForText(); return; }
        flow.asText();
    }

    private boolean requireRoom() {
        if (app().rooms.activeSession() != null) return true;
        a.flash("", app().t("room.offline"), "warn");
        return false;
    }

    /* ----------------------------------------------------- SpeakSend.Io */

    @Override public boolean canDictate() { return Dictation.available(app()); }

    @Override public void startDictation() {
        if (!a.has(Manifest.permission.RECORD_AUDIO)) {
            // Asked first: the flow starts again once the microphone is allowed (a refusal leaves it idle).
            SpeakSend.Mode m = flow.mode();
            flow.cancel();
            c.withMic(() -> { if (m == SpeakSend.Mode.VOICE) flow.asVoice(); else flow.asText(); });
            return;
        }
        start(true);
    }

    @Override public void stopDictation() { if (dictating()) voice().stopDictation(); else flow.dictationEnded(); }

    @Override public String fieldText() { return c.field().getText().toString(); }

    @Override public void clearField() { c.clearAfterSend(); }

    @Override public void speak(String text, SpeakSend.Done<Voice.Clip> done) {
        voice().textToVoiceMessage(text, done::done);
    }

    @Override public void sendText(String text) {
        RoomSession r = app().rooms.activeSession();
        if (r != null) r.send(c.outgoing(text));
    }

    @Override public void sendVoice(Voice.Clip clip) {
        RoomSession r = app().rooms.activeSession();
        if (r != null) c.sendVoiceClip(r, clip);
    }

    @Override public void notice(String key, String detail) {
        String level;
        switch (key) {
            case "speakSend.noVoice": case "speakSend.serverOff": case "speakSend.failed": case "voice.failed": level = "error"; break;
            case "voice.nothingHeard": case "look.dictate.none": level = "warn"; break;
            default: level = "info";
        }
        a.flash("", app().t(key) + (detail == null || detail.isEmpty() ? "" : ": " + detail), level);
    }

    @Override public void changed(SpeakSend.State state, SpeakSend.Mode mode) { sync(); }

    /* -------------------------------------------------------- dictation */

    private void start(boolean flowDictation) {
        if (dictating() || !c.isAttachedToWindow() || c.recording()) { if (flowDictation) flow.cancel(); return; }
        EditText field = c.field();
        base = field.getText().toString();
        if (!base.isEmpty() && !base.endsWith(" ")) base += " ";
        forFlow = flowDictation;
        mine = true;
        voice().dictate(new Voice.Sink() {
            @Override public void onText(String text, boolean done) {
                field.setText(base + text);
                field.setSelection(field.getText().length());
                if (!done) return;
                base = field.getText().toString() + " ";
                if (!forFlow && app().settings.bool("voice.dictateSend")) { c.sendNow(); base = ""; }
            }
            @Override public void onEnded() {
                mine = false;
                String error = voice().takeDictationError();
                if (!error.isEmpty()) a.flash("", errorText(error), "warn");
                sync();
                if (forFlow) { forFlow = false; flow.dictationEnded(); return; }
                if (sendWhenEnded) { sendWhenEnded = false; c.sendNow(); }
            }
        });
        sync();
    }

    /** A dictation error in words (the design's dict.err.*). */
    private String errorText(String code) {
        String key = "dict.err." + code;
        String text = app().t(key);
        return text.equals(key) ? app().t("dict.err.other").replace("{code}", code) : text;
    }

    /** The icon and the field's hint follow the real state. */
    private void sync() {
        boolean on = dictating();
        SpeakSend.State s = flow.state();
        String hint = s == SpeakSend.State.SPEAKING ? "voice.synthesizing" : on ? (s == SpeakSend.State.DICTATING ? (flow.mode() == SpeakSend.Mode.VOICE ? "speakSend.speakNow" : "speakSend.speakNowText") : voice().listening() ? "voice.listening" : "dict.starting") : "room.typeMessage";
        c.dictateIcon(on || s == SpeakSend.State.SPEAKING, app().t(hint));
    }
}
