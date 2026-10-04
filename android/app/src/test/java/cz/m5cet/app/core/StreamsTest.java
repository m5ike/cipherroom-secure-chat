package cz.m5cet.app.core;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;

/** 6.7 (audit V5): reading a stream whole without the API 33 InputStream.readAllBytes(). */
public class StreamsTest {
    @Test
    public void readsEverything() throws IOException {
        byte[] data = new byte[100_000];
        for (int i = 0; i < data.length; i++) data[i] = (byte) (i * 31);
        assertArrayEquals(data, Streams.readAll(new ByteArrayInputStream(data)));
        assertEquals(0, Streams.readAll(new ByteArrayInputStream(new byte[0])).length);
    }

    /** A stream that hands out a few bytes at a time (as sockets and content providers do). */
    @Test
    public void readsShortReads() throws IOException {
        InputStream trickle = new InputStream() {
            int left = 5000;
            @Override public int read() { return left-- > 0 ? 7 : -1; }
            @Override public int read(byte[] b, int off, int len) {
                if (left <= 0) return -1;
                int n = Math.min(Math.min(len, 3), left);
                for (int i = 0; i < n; i++) b[off + i] = 7;
                left -= n;
                return n;
            }
        };
        assertEquals(5000, Streams.readAll(trickle).length);
    }

    @Test
    public void refusesMoreThanTheLimit() throws IOException {
        assertEquals(10, Streams.readAll(new ByteArrayInputStream(new byte[10]), 10).length);
        try {
            Streams.readAll(new ByteArrayInputStream(new byte[11]), 10);
            fail("11 bytes over a limit of 10");
        } catch (IOException expected) { }
    }
}
