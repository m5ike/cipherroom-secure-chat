package cz.m5cet.app.chat;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/** 6.7 (audit S13): rooms connecting together derive their keys one at a time (each Argon2 holds its memory). */
public class Argon2SerialTest {
    @Test
    public void derivationsRunOneAtATime() throws Exception {
        int threads = 6;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        CountDownLatch go = new CountDownLatch(1);
        List<Future<byte[]>> out = new ArrayList<>();
        try {
            for (int i = 0; i < threads; i++) {
                out.add(pool.submit(() -> {
                    go.await();
                    return Argon2.argon2id("passphrase".getBytes(StandardCharsets.UTF_8), "m5cet:room:v3:room".getBytes(StandardCharsets.UTF_8), 2, 1024, 1, 32, null, null);
                }));
            }
            go.countDown();
            byte[] first = out.get(0).get();
            for (Future<byte[]> f : out) assertArrayEquals(first, f.get()); // same result, whatever the order
        } finally {
            pool.shutdownNow();
        }
        assertEquals(1, Argon2.peakConcurrency());
    }
}
