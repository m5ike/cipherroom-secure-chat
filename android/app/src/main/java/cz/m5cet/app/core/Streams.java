package cz.m5cet.app.core;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * 6.7 (audit V5): reading a whole stream without InputStream.readAllBytes(),
 * which exists only from API 33 — the app runs from API 29 (Android 10), where
 * the call ends in NoSuchMethodError (an Error, not caught by catch Exception).
 * Pure Java, so the JVM tests run it.
 */
public final class Streams {
    private Streams() {}

    /** Everything the stream still holds (it is not closed). */
    public static byte[] readAll(InputStream in) throws IOException {
        return readAll(in, Long.MAX_VALUE);
    }

    /** At most max bytes; more is an IOException, so a hostile source cannot fill the memory. */
    public static byte[] readAll(InputStream in, long max) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16 * 1024];
        long total = 0;
        int n;
        while ((n = in.read(buf)) != -1) {
            total += n;
            if (total > max) throw new IOException("more than " + max + " bytes");
            out.write(buf, 0, n);
        }
        return out.toByteArray();
    }
}
