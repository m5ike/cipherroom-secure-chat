package cz.m5cet.app.voice;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * Dictation's state machine (6.7) — client/src/lib/dictation.ts in Java, with
 * pause / resume for the app speaking. Pure Java (the JVM tests drive it); the
 * phone's recogniser is an {@link Engine} (Dictation.java).
 *
 *   IDLE ─start→ STARTING ─(ready)→ LISTENING
 *   LISTENING ─(the recogniser ended by itself: a pause)→ RESTARTING → STARTING …
 *   any ─pause (the app speaks)→ PAUSED ─resume→ STARTING
 *   any ─stop→ STOPPING ─(last words, end — or finishMs)→ IDLE
 *   any ─abort, or a fatal error (no permission, no microphone)→ IDLE
 *
 * A stop always ends it (6.7 fix — "dictation cannot be stopped"): the
 * recogniser is asked to stop so the last words still come, a pending
 * restart is cancelled, and a recogniser that does not end within finishMs
 * is cancelled and destroyed — the microphone is free. Events of a session
 * that is over (a late result, an error after our own cancel) are ignored,
 * so nothing ever restarts a stopped dictation.
 *
 * Single-threaded: every call on one thread (the main thread in the app).
 */
public final class DictationMachine {
    public enum State { IDLE, STARTING, LISTENING, RESTARTING, PAUSED, STOPPING }

    /** What a recogniser session reports. */
    public interface Events {
        void ready();
        void partial(String text);
        void fin(String text);
        void error(String code);
        /** The session is over (after its result or error). */
        void end();
    }

    public interface Session {
        /** Stop listening; the last words come, then end. */
        void stop();
        /** Drop it now (no more events matter); free the microphone. */
        void abort();
    }

    public interface Engine {
        /** A new session; throws when it cannot start. */
        Session start(String lang, Events events);
    }

    public interface Listener {
        default void onText(String text, boolean fin) { }
        default void onState(State state) { }
        default void onError(String code) { }
    }

    /** Timers (Io.mainLater in the app). */
    public interface Scheduler {
        Object post(Runnable r, long ms);
        void cancel(Object token);
    }

    /** Errors after which listening again is pointless. */
    public static final Set<String> FATAL = new HashSet<>(Arrays.asList("not-allowed", "audio-capture", "language-not-supported", "unsupported", "no-microphone"));

    private final Engine engine;
    private final Scheduler scheduler;
    private final Listener listener;
    private String lang;
    private State state = State.IDLE;
    private Session session;
    private int gen;
    private Object restartTimer, finishTimer;
    private int idleRestarts;
    public long finishMs = 1500, restartMs = 250, busyRestartMs = 700;
    public int maxIdleRestarts = 8;

    public DictationMachine(Engine engine, Scheduler scheduler, String lang, Listener listener) {
        this.engine = engine;
        this.scheduler = scheduler;
        this.lang = lang;
        this.listener = listener;
    }

    public State state() { return state; }
    public boolean active() { return state != State.IDLE; }
    /** Hearing now (the recogniser is ready). */
    public boolean listening() { return state == State.LISTENING; }
    public void setLang(String lang) { this.lang = lang; }

    public boolean start() {
        if (state != State.IDLE) return false;
        idleRestarts = 0;
        return open();
    }

    /** Stop and finish the text. */
    public void stop() {
        if (state == State.IDLE || state == State.STOPPING) return;
        clearRestart();
        Session s = session;
        if (s == null) { finish(); return; } // restarting / paused: nothing listens
        set(State.STOPPING);
        final int g = gen;
        try { s.stop(); } catch (RuntimeException ignored) { }
        finishTimer = scheduler.post(() -> {
            finishTimer = null;
            if (g == gen && state == State.STOPPING) { abortSession(); finish(); }
        }, finishMs);
    }

    /** Stop at once; unfinished words are dropped. */
    public void abort() {
        if (state == State.IDLE) return;
        abortSession();
        finish();
    }

    public void toggle() {
        if (state == State.IDLE) start();
        else stop();
    }

    /** The app is about to speak: stop hearing (resume() goes on). */
    public void pause() {
        if (state == State.IDLE || state == State.STOPPING || state == State.PAUSED) return;
        clearRestart();
        abortSession();
        set(State.PAUSED);
    }

    public void resume() {
        if (state != State.PAUSED) return;
        open();
    }

    private void set(State next) {
        if (state == next) return;
        state = next;
        listener.onState(next);
    }

    private boolean open() {
        final int g = ++gen;
        set(State.STARTING);
        try {
            session = engine.start(lang, new Events() {
                @Override public void ready() { if (g == gen && state == State.STARTING) set(State.LISTENING); }
                @Override public void partial(String text) { if (g == gen && text != null && !text.isEmpty()) { idleRestarts = 0; listener.onText(text, false); } }
                @Override public void fin(String text) { if (g == gen && text != null && !text.isEmpty()) { idleRestarts = 0; listener.onText(text, true); } }
                @Override public void error(String code) { if (g == gen) onError(code); }
                @Override public void end() { if (g == gen) onEnd(); }
            });
            return true;
        } catch (RuntimeException e) {
            session = null;
            finish();
            listener.onError("unsupported");
            return false;
        }
    }

    private String lastError = "";

    private void onError(String code) {
        lastError = code == null ? "" : code;
        if (FATAL.contains(code) && state != State.STOPPING) {
            abortSession();
            finish();
            listener.onError(code);
            return;
        }
        if (!"no-speech".equals(code) && !"aborted".equals(code) && !"busy".equals(code) && !"client".equals(code)) listener.onError(code);
    }

    private void onEnd() {
        session = null;
        if (state == State.STOPPING || state == State.IDLE || state == State.PAUSED) { if (state != State.PAUSED) finish(); return; }
        // It ended by itself (a pause, the network): dictation goes on.
        idleRestarts++;
        if (idleRestarts > maxIdleRestarts) { finish(); listener.onError("ended"); return; }
        set(State.RESTARTING);
        long wait = "busy".equals(lastError) || "client".equals(lastError) || "network".equals(lastError) ? busyRestartMs : restartMs;
        lastError = "";
        restartTimer = scheduler.post(() -> { restartTimer = null; if (state == State.RESTARTING) open(); }, wait);
    }

    private void abortSession() {
        Session s = session;
        session = null;
        gen++;
        if (s != null) { try { s.abort(); } catch (RuntimeException ignored) { } }
    }

    private void clearRestart() {
        if (restartTimer != null) { scheduler.cancel(restartTimer); restartTimer = null; }
    }

    private void finish() {
        clearRestart();
        if (finishTimer != null) { scheduler.cancel(finishTimer); finishTimer = null; }
        session = null;
        gen++;
        set(State.IDLE);
    }
}
