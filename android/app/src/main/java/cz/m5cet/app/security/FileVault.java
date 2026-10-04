package cz.m5cet.app.security;

import java.io.Closeable;
import java.io.EOFException;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.security.GeneralSecurityException;

import cz.m5cet.app.M5;

/**
 * Files at rest (6.1): what the chat receives or sends as a file is kept in
 * the vault's directory, encrypted with the USER tier's key — unreadable
 * until the PIN or biometrics open the app.
 *
 * Format: "M5F1" | nonce (8) | segments; each segment is AES-256-GCM over up
 * to 64 KiB with IV = nonce ‖ index (u32 BE), AAD = "m5file|<id>|<index>|<last>"
 * — so segments cannot be reordered, dropped at the end or moved between files.
 */
public final class FileVault {
    private FileVault() {}

    static final int SEGMENT = 64 * 1024;
    private static final byte[] MAGIC = {'M', '5', 'F', '1'};

    public static File dir(M5 app) {
        File d = new File(app.vault.dir(), "files");
        //noinspection ResultOfMethodCallIgnored
        d.mkdirs();
        return d;
    }

    public static File fileOf(M5 app, String id) {
        if (!id.matches("[A-Za-z0-9_.:-]{1,120}")) throw new IllegalArgumentException("bad file id");
        return new File(dir(app), id.replace(':', '_') + ".m5f");
    }

    public static boolean has(M5 app, String id) { return fileOf(app, id).exists(); }

    public static void delete(M5 app, String id) {
        //noinspection ResultOfMethodCallIgnored
        fileOf(app, id).delete();
    }

    private static byte[] aad(String id, long index, boolean last) {
        return Crypto.utf8("m5file|" + id + "|" + index + "|" + (last ? 1 : 0));
    }

    private static byte[] iv(byte[] nonce, long index) {
        return ByteBuffer.allocate(12).put(nonce).putInt((int) index).array();
    }

    /** Writes plaintext segment by segment; close() seals the last one. */
    public static final class Writer implements Closeable {
        private final OutputStream out;
        private final byte[] key, nonce;
        private final String id;
        private final byte[] buf = new byte[SEGMENT];
        private int filled = 0;
        private long index = 0;
        private final File tmp, target;

        public Writer(M5 app, String id) throws IOException, GeneralSecurityException {
            this.id = id;
            this.key = app.vault.userKey();
            this.nonce = Crypto.random(8);
            this.target = fileOf(app, id);
            this.tmp = new File(target.getPath() + ".part");
            this.out = new FileOutputStream(tmp);
            out.write(MAGIC);
            out.write(nonce);
        }

        public void write(byte[] b, int off, int len) throws IOException {
            while (len > 0) {
                if (filled == SEGMENT) flushSegment(false);
                int n = Math.min(len, SEGMENT - filled);
                System.arraycopy(b, off, buf, filled, n);
                filled += n; off += n; len -= n;
            }
        }

        private void flushSegment(boolean last) throws IOException {
            byte[] plain = java.util.Arrays.copyOf(buf, filled);
            out.write(Crypto.gcmSeal(key, iv(nonce, index), plain, aad(id, index, last)));
            index++;
            filled = 0;
        }

        @Override public void close() throws IOException {
            flushSegment(true);
            out.close();
            if (!tmp.renameTo(target)) throw new IOException("cannot store the file");
        }

        public void abort() {
            try { out.close(); } catch (IOException ignored) { }
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
        }
    }

    /** Streams the plaintext of a stored file. */
    public static InputStream open(M5 app, String id) throws IOException, GeneralSecurityException {
        byte[] key = app.vault.userKey();
        File f = fileOf(app, id);
        long total = f.length();
        InputStream in = new FileInputStream(f);
        byte[] head = new byte[12];
        readFully(in, head);
        if (head[0] != 'M' || head[1] != '5' || head[2] != 'F' || head[3] != '1') { in.close(); throw new IOException("not a vault file"); }
        byte[] nonce = java.util.Arrays.copyOfRange(head, 4, 12);
        final long segments = Math.max(1, (total - 12 + SEGMENT + 16 - 1) / (SEGMENT + 16));
        return new InputStream() {
            private byte[] plain = new byte[0];
            private int at = 0;
            private long index = 0;

            private boolean next() throws IOException {
                if (index >= segments) return false;
                boolean last = index == segments - 1;
                long remaining = total - 12 - index * (SEGMENT + 16);
                int len = (int) Math.min(SEGMENT + 16, remaining);
                byte[] ct = new byte[len];
                readFully(in, ct);
                try { plain = Crypto.gcmOpen(key, iv(nonce, index), ct, aad(id, index, last)); }
                catch (GeneralSecurityException e) { throw new IOException("the file is damaged", e); }
                at = 0;
                index++;
                return true;
            }

            @Override public int read() throws IOException {
                byte[] one = new byte[1];
                return read(one, 0, 1) < 0 ? -1 : one[0] & 0xff;
            }

            @Override public int read(byte[] b, int off, int len) throws IOException {
                while (at >= plain.length) if (!next()) return -1;
                int n = Math.min(len, plain.length - at);
                System.arraycopy(plain, at, b, off, n);
                at += n;
                return n;
            }

            @Override public void close() throws IOException { in.close(); }
        };
    }

    /** Random access to a stored file's plaintext (media players, resending a chunk). */
    public static final class Reader implements Closeable {
        private final java.io.RandomAccessFile f;
        private final byte[] key, nonce;
        private final String id;
        private final long segments;
        public final long size;
        private long cachedIndex = -1;
        private byte[] cached;

        public Reader(M5 app, String id) throws IOException, GeneralSecurityException {
            this.id = id;
            this.key = app.vault.userKey();
            this.f = new java.io.RandomAccessFile(fileOf(app, id), "r");
            byte[] head = new byte[12];
            f.readFully(head);
            if (head[0] != 'M' || head[1] != '5' || head[2] != 'F' || head[3] != '1') { f.close(); throw new IOException("not a vault file"); }
            this.nonce = java.util.Arrays.copyOfRange(head, 4, 12);
            long body = f.length() - 12;
            this.segments = Math.max(1, (body + SEGMENT + 16 - 1) / (SEGMENT + 16));
            long lastLen = body - (segments - 1) * (SEGMENT + 16) - 16;
            this.size = (segments - 1) * (long) SEGMENT + Math.max(0, lastLen);
        }

        private byte[] segment(long index) throws IOException {
            if (index == cachedIndex) return cached;
            boolean last = index == segments - 1;
            long pos = 12 + index * (SEGMENT + 16);
            int len = (int) Math.min(SEGMENT + 16, f.length() - pos);
            byte[] ct = new byte[len];
            f.seek(pos);
            f.readFully(ct);
            try { cached = Crypto.gcmOpen(key, iv(nonce, index), ct, aad(id, index, last)); }
            catch (GeneralSecurityException e) { throw new IOException("the file is damaged", e); }
            cachedIndex = index;
            return cached;
        }

        /** Reads up to len bytes at position; −1 at the end. */
        public synchronized int readAt(long position, byte[] b, int off, int len) throws IOException {
            if (position >= size) return -1;
            int done = 0;
            while (done < len && position + done < size) {
                long p = position + done;
                byte[] seg = segment(p / SEGMENT);
                int at = (int) (p % SEGMENT);
                int n = Math.min(len - done, seg.length - at);
                if (n <= 0) break;
                System.arraycopy(seg, at, b, off + done, n);
                done += n;
            }
            return done;
        }

        @Override public void close() throws IOException { f.close(); }
    }

    public static byte[] readAll(M5 app, String id) throws IOException, GeneralSecurityException {
        try (InputStream in = open(app, id)) { return cz.m5cet.app.core.Streams.readAll(in); }
    }

    static void readFully(InputStream in, byte[] b) throws IOException {
        int off = 0;
        while (off < b.length) {
            int n = in.read(b, off, b.length - off);
            if (n < 0) throw new EOFException();
            off += n;
        }
    }
}
