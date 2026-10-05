package cz.m5cet.app.fn;

/**
 * 6.11: one command run's clock and its single ending — a run that shows no
 * sign of life (no event of its stream; the server's pings are not events)
 * for {@link ModelIdentity#FN_RUN_TIMEOUT_MS} fails, an open question (a
 * form, an NFC tap) pauses the clock, an answer starts it afresh, progress
 * and every other event move it on. However a run ends — done, an error
 * (incomplete stream, network, HTTP), the timeout, a newer run that replaced
 * it — it is settled exactly once: {@link #settle} says true only the first
 * time, so the command's bubble never loads for ever and never settles twice.
 * Pure; thread-safe (the stream's events and the timer come from different
 * places).
 */
public final class RunWatch {
    /** How a run ended. */
    public enum End { DONE, ERROR, TIMEOUT, CANCELLED }

    private final long timeoutMs;
    private long deadline;
    private int open;
    private End ended;

    public RunWatch(long timeoutMs, long now) {
        this.timeoutMs = timeoutMs;
        this.deadline = now + timeoutMs;
    }

    public RunWatch(long now) { this(ModelIdentity.FN_RUN_TIMEOUT_MS, now); }

    /** A sign of life (start, progress, an output, a log line): the clock starts again. */
    public synchronized void alive(long now) {
        if (ended == null) deadline = now + timeoutMs;
    }

    /** A question opened: the clock waits for the person. */
    public synchronized void asked() {
        if (ended == null) open++;
    }

    /** A question was answered (or dismissed): when none is left open, the clock starts afresh. */
    public synchronized void answered(long now) {
        if (ended != null || open == 0) return;
        open--;
        if (open == 0) deadline = now + timeoutMs;
    }

    public synchronized boolean paused() { return ended == null && open > 0; }

    /** Time left before the run times out (ms): 0 when it has; Long.MAX_VALUE while a question is open or once it ended. */
    public synchronized long remaining(long now) {
        if (ended != null || open > 0) return Long.MAX_VALUE;
        return Math.max(0, deadline - now);
    }

    /** Running, no question open, and the time is up. */
    public synchronized boolean expired(long now) { return ended == null && open == 0 && now >= deadline; }

    /** Ends the run — true only for the first ending; every later one (a late answer after a timeout…) is ignored. */
    public synchronized boolean settle(End how) {
        if (ended != null) return false;
        ended = how;
        return true;
    }

    /** How it ended (null while it runs). */
    public synchronized End ended() { return ended; }

    public synchronized boolean over() { return ended != null; }
}
