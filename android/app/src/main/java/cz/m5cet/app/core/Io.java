package cz.m5cet.app.core;

import android.os.Handler;
import android.os.Looper;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** Where work runs: the main thread, a pool for I/O and crypto, a scheduler. */
public final class Io {
    private Io() {}

    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private static ThreadFactory named(String prefix) {
        AtomicInteger n = new AtomicInteger();
        return r -> {
            Thread t = new Thread(r, prefix + "-" + n.incrementAndGet());
            t.setDaemon(true);
            return t;
        };
    }

    public static final ExecutorService POOL = Executors.newFixedThreadPool(4, named("m5-io"));
    public static final ScheduledExecutorService TIMER = Executors.newScheduledThreadPool(1, named("m5-timer"));

    public static void main(Runnable r) {
        if (Looper.myLooper() == Looper.getMainLooper()) r.run();
        else MAIN.post(r);
    }

    public static void mainLater(Runnable r, long ms) { MAIN.postDelayed(r, ms); }
    public static void cancelMain(Runnable r) { MAIN.removeCallbacks(r); }

    public static void bg(Runnable r) {
        POOL.execute(() -> {
            try { r.run(); } catch (Throwable t) { Log.e("io", "background task failed", t); }
        });
    }

    public static java.util.concurrent.ScheduledFuture<?> later(Runnable r, long ms) {
        return TIMER.schedule(() -> {
            try { r.run(); } catch (Throwable t) { Log.e("io", "timer task failed", t); }
        }, ms, TimeUnit.MILLISECONDS);
    }
}
