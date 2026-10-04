package cz.m5cet.app.voice;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * 6.7: "dictation cannot be stopped" — the state machine behind the phone's
 * dictation. A stop always ends it: the last words still come, a pending
 * restart is dropped, a recogniser that does not end is aborted (the
 * microphone is free), a late event of an old session changes nothing;
 * a pause after silence starts it again; the app speaking pauses it.
 */
public class DictationMachineTest {
    /** Timers run by hand. */
    static final class Clock implements DictationMachine.Scheduler {
        long now;
        int next;
        final TreeMap<Long, Map.Entry<Integer, Runnable>> queue = new TreeMap<>();
        @Override public Object post(Runnable r, long ms) { int id = ++next; queue.put((now + ms) * 1000 + id, Map.entry(id, r)); return id; }
        @Override public void cancel(Object token) { queue.values().removeIf(e -> e.getKey().equals(token)); }
        void advance(long ms) {
            long until = now + ms;
            while (!queue.isEmpty() && queue.firstKey() / 1000 <= until) {
                Map.Entry<Long, Map.Entry<Integer, Runnable>> e = queue.pollFirstEntry();
                now = e.getKey() / 1000;
                e.getValue().getValue().run();
            }
            now = until;
        }
    }

    static final class FakeSession implements DictationMachine.Session {
        final DictationMachine.Events ev;
        int stops, aborts;
        FakeSession(DictationMachine.Events ev) { this.ev = ev; }
        @Override public void stop() { stops++; }
        @Override public void abort() { aborts++; }
    }

    static final class Rig {
        final List<FakeSession> sessions = new ArrayList<>();
        final List<String> texts = new ArrayList<>(), errors = new ArrayList<>(), states = new ArrayList<>();
        final Clock clock = new Clock();
        boolean failStart;
        final DictationMachine m = new DictationMachine((lang, ev) -> {
            if (failStart) throw new IllegalStateException("no recogniser");
            FakeSession s = new FakeSession(ev);
            sessions.add(s);
            return s;
        }, clock, "cs-CZ", new DictationMachine.Listener() {
            @Override public void onText(String text, boolean fin) { texts.add((fin ? "F:" : "P:") + text); }
            @Override public void onState(DictationMachine.State s) { states.add(s.name()); }
            @Override public void onError(String code) { errors.add(code); }
        });
        FakeSession last() { return sessions.get(sessions.size() - 1); }
    }

    @Test public void stopFinishesTheWordsThenIdle() {
        Rig r = new Rig();
        assertTrue(r.m.start());
        r.last().ev.ready();
        assertTrue(r.m.listening());
        r.last().ev.partial("ahoj");
        r.m.toggle(); // the same icon again
        assertEquals(DictationMachine.State.STOPPING, r.m.state());
        assertEquals(1, r.last().stops);
        r.last().ev.fin("ahoj jak se máš");
        r.last().ev.end();
        assertEquals(DictationMachine.State.IDLE, r.m.state());
        assertEquals(Arrays.asList("P:ahoj", "F:ahoj jak se máš"), r.texts);
        assertEquals(Arrays.asList("STARTING", "LISTENING", "STOPPING", "IDLE"), r.states);
        assertTrue(r.m.start());
    }

    @Test public void aRecogniserThatNeverEndsIsAbortedAndItsLateEventsIgnored() {
        Rig r = new Rig();
        r.m.start();
        FakeSession s = r.last();
        s.ev.ready();
        r.m.stop();
        r.clock.advance(1499);
        assertEquals(DictationMachine.State.STOPPING, r.m.state());
        r.clock.advance(1);
        assertEquals(DictationMachine.State.IDLE, r.m.state());
        assertEquals(1, s.aborts);
        s.ev.fin("late");
        s.ev.end();
        assertTrue(r.texts.isEmpty());
        r.clock.advance(60_000);
        assertEquals(1, r.sessions.size());
    }

    @Test public void keepsListeningAfterAPauseAndStopBetweenSessionsEndsIt() {
        Rig r = new Rig();
        r.m.start();
        r.last().ev.ready();
        r.last().ev.error("no-speech");
        r.last().ev.end();
        assertEquals(DictationMachine.State.RESTARTING, r.m.state());
        r.clock.advance(250);
        assertEquals(2, r.sessions.size());
        r.last().ev.ready();
        r.last().ev.end();
        r.m.stop(); // while restarting: nothing listens, idle at once
        assertEquals(DictationMachine.State.IDLE, r.m.state());
        r.clock.advance(10_000);
        assertEquals(2, r.sessions.size());
        assertTrue(r.clock.queue.isEmpty());
        assertTrue(r.errors.isEmpty()); // a pause is no error
    }

    @Test public void aLateEndOfAnOldSessionDoesNotTouchTheNewOne() {
        Rig r = new Rig();
        r.m.start();
        FakeSession first = r.last();
        first.ev.ready();
        first.ev.end();
        r.clock.advance(250);
        FakeSession second = r.last();
        second.ev.ready();
        first.ev.end();
        first.ev.fin("ghost");
        assertEquals(DictationMachine.State.LISTENING, r.m.state());
        assertTrue(r.texts.isEmpty());
    }

    @Test public void aFatalErrorStopsForGoodAndIsSaid() {
        Rig r = new Rig();
        r.m.start();
        r.last().ev.error("not-allowed");
        assertEquals(DictationMachine.State.IDLE, r.m.state());
        assertEquals(Arrays.asList("not-allowed"), r.errors);
        assertEquals(1, r.last().aborts);
        r.clock.advance(10_000);
        assertEquals(1, r.sessions.size());
    }

    @Test public void busyWaitsLongerAndGivesUpAfterEndingAgainAndAgain() {
        Rig r = new Rig();
        r.m.maxIdleRestarts = 2;
        r.m.start();
        r.last().ev.error("busy");
        r.last().ev.end();
        r.clock.advance(250);
        assertEquals(1, r.sessions.size()); // a busy recogniser gets more time
        r.clock.advance(450);
        assertEquals(2, r.sessions.size());
        r.last().ev.end();
        r.clock.advance(250);
        r.last().ev.end();
        assertEquals(DictationMachine.State.IDLE, r.m.state());
        assertEquals(Arrays.asList("ended"), r.errors);
    }

    @Test public void theAppSpeakingPausesItAndItComesBack() {
        Rig r = new Rig();
        r.m.start();
        FakeSession s = r.last();
        s.ev.ready();
        r.m.pause();
        assertEquals(DictationMachine.State.PAUSED, r.m.state());
        assertEquals(1, s.aborts);
        s.ev.end(); // after our own abort: ignored
        r.clock.advance(5000);
        assertEquals(1, r.sessions.size());
        r.m.resume();
        assertEquals(2, r.sessions.size());
        assertEquals(DictationMachine.State.STARTING, r.m.state());
        r.m.pause();
        r.m.stop(); // stopped while paused: idle
        assertEquals(DictationMachine.State.IDLE, r.m.state());
    }

    @Test public void aRecogniserThatCannotStart() {
        Rig r = new Rig();
        r.failStart = true;
        assertFalse(r.m.start());
        assertEquals(DictationMachine.State.IDLE, r.m.state());
        assertEquals(Arrays.asList("unsupported"), r.errors);
    }

    @Test public void abortDropsAtOnce() {
        Rig r = new Rig();
        r.m.start();
        r.last().ev.ready();
        r.m.abort();
        assertEquals(DictationMachine.State.IDLE, r.m.state());
        r.last().ev.fin("x");
        assertTrue(r.texts.isEmpty());
        Iterator<String> it = r.states.iterator();
        assertEquals("STARTING", it.next());
    }
}
