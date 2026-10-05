package cz.m5cet.app.fn;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** 6.11: a run's clock — 30 s without a sign of life ends it, a question pauses it, and it ends exactly once. */
public class RunWatchTest {
    @Test public void thirtySecondsOfSilenceEndIt() throws Exception {
        RunWatch w = new RunWatch(1_000);
        assertEquals(30_000, w.remaining(1_000));
        assertFalse(w.expired(30_999));
        assertTrue(w.expired(31_000));
        assertEquals(0, w.remaining(40_000));
        assertTrue(w.settle(RunWatch.End.TIMEOUT));
        assertEquals(RunWatch.End.TIMEOUT, w.ended());
        // The answer that comes after the timeout changes nothing.
        assertFalse(w.settle(RunWatch.End.DONE));
        assertEquals(RunWatch.End.TIMEOUT, w.ended());
        assertFalse(w.expired(100_000));
        assertEquals(Long.MAX_VALUE, w.remaining(100_000));
    }

    @Test public void progressAndEveryEventMoveTheClock() throws Exception {
        RunWatch w = new RunWatch(0);
        w.alive(20_000);   // a progress
        assertFalse(w.expired(45_000));
        w.alive(45_000);   // a log line
        assertEquals(30_000, w.remaining(45_000));
        assertTrue(w.expired(75_000));
    }

    @Test public void anOpenQuestionPausesItAndTheAnswerStartsItAfresh() throws Exception {
        RunWatch w = new RunWatch(0);
        w.asked();
        assertTrue(w.paused());
        assertFalse(w.expired(10 * 60_000));            // the person takes their time
        assertEquals(Long.MAX_VALUE, w.remaining(10 * 60_000));
        w.asked();                                      // a second question (an NFC tap) while the first is open
        w.answered(11 * 60_000);
        assertTrue(w.paused());
        w.answered(12 * 60_000);
        assertFalse(w.paused());
        assertEquals(30_000, w.remaining(12 * 60_000));
        assertTrue(w.expired(12 * 60_000 + 30_000));
        // An answer without a question changes nothing.
        RunWatch v = new RunWatch(0);
        v.answered(25_000);
        assertTrue(v.expired(30_000));
    }

    @Test public void everyEndingSettlesOnce() throws Exception {
        for (RunWatch.End first : RunWatch.End.values()) {
            RunWatch w = new RunWatch(0);
            assertNull(w.ended());
            assertFalse(w.over());
            assertTrue(w.settle(first));
            assertTrue(w.over());
            for (RunWatch.End later : RunWatch.End.values()) assertFalse(w.settle(later));
            assertEquals(first, w.ended());
            // Nothing moves an ended run's clock.
            w.alive(1);
            w.asked();
            assertFalse(w.paused());
            assertFalse(w.expired(1_000_000));
        }
    }

    @Test public void theContractsTimeout() throws Exception {
        RunWatch w = new RunWatch(5);
        assertEquals(ModelIdentity.FN_RUN_TIMEOUT_MS, w.remaining(5));
    }
}
