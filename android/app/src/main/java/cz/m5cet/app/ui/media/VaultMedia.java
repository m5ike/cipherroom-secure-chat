package cz.m5cet.app.ui.media;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaDataSource;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.ByteArrayInputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

import cz.m5cet.app.M5;
import cz.m5cet.app.chat.ChatMessage;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.security.FileVault;

/**
 * Media of a message without plaintext on the disk (6.1): an attachment is
 * either inline (a data URL in the message) or a file in the vault
 * (FileVault) — players read it through a MediaDataSource that decrypts on
 * the fly, pictures are decoded from the stream, and another app opening a
 * file gets it through FilesProvider (a pipe, decrypted as it is read).
 */
public final class VaultMedia {
    private VaultMedia() {}

    /** The attachment's bytes as a stream (inline data URL or the vault). */
    public static InputStream open(M5 app, ChatMessage m) throws IOException {
        if (m.fileDataUrl != null) {
            int comma = m.fileDataUrl.indexOf(',');
            if (comma < 0) throw new IOException("bad data URL");
            return new ByteArrayInputStream(android.util.Base64.decode(m.fileDataUrl.substring(comma + 1), android.util.Base64.DEFAULT));
        }
        if (m.filePath == null) throw new FileNotFoundException("no file");
        try { return FileVault.open(app, m.filePath); }
        catch (java.security.GeneralSecurityException e) { throw new IOException("the app is locked", e); }
    }

    /** A picture of the message, scaled to at most maxPx (null when it is not one or cannot be read). */
    public static Bitmap bitmap(M5 app, ChatMessage m, int maxPx) {
        try (InputStream in = open(app, m)) {
            byte[] b = readAll(in);
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(b, 0, b.length, o);
            int s = 1;
            while (o.outWidth / s > maxPx || o.outHeight / s > maxPx) s *= 2;
            o = new BitmapFactory.Options();
            o.inSampleSize = s;
            return BitmapFactory.decodeByteArray(b, 0, b.length, o);
        } catch (IOException | OutOfMemoryError e) {
            Log.w("media", "picture: " + e.getMessage());
            return null;
        }
    }

    /** A random-access source for MediaPlayer / MediaMetadataRetriever. */
    public static MediaDataSource source(M5 app, ChatMessage m) throws IOException {
        if (m.fileDataUrl != null) {
            byte[] b;
            try (InputStream in = open(app, m)) { b = readAll(in); }
            return new MediaDataSource() {
                @Override public int readAt(long pos, byte[] buf, int off, int len) { if (pos >= b.length) return -1; int n = (int) Math.min(len, b.length - pos); System.arraycopy(b, (int) pos, buf, off, n); return n; }
                @Override public long getSize() { return b.length; }
                @Override public void close() { }
            };
        }
        try {
            FileVault.Reader r = new FileVault.Reader(app, m.filePath);
            return new MediaDataSource() {
                @Override public int readAt(long pos, byte[] buf, int off, int len) throws IOException { return r.readAt(pos, buf, off, len); }
                @Override public long getSize() { return r.size; }
                @Override public void close() throws IOException { r.close(); }
            };
        } catch (java.security.GeneralSecurityException e) { throw new IOException("the app is locked", e); }
    }

    /** A content:// URI another app can read the file from (read permission granted with the intent). */
    public static Uri uriFor(M5 app, ChatMessage m) {
        return new Uri.Builder().scheme("content").authority(app.getPackageName() + ".files")
            .appendPath(m.roomKey == null ? "" : m.roomKey).appendPath(m.id).appendPath(m.fileName == null ? "file" : m.fileName).build();
    }

    /** Where the camera app writes a photo: content://<package>.files/capture (a file in the cache, deleted after sending). */
    public static Uri captureUri(M5 app) {
        java.io.File f = captureFile(app);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
        return new Uri.Builder().scheme("content").authority(app.getPackageName() + ".files").appendPath("capture").build();
    }

    public static java.io.File captureFile(M5 app) {
        java.io.File d = new java.io.File(app.getCacheDir(), "capture");
        //noinspection ResultOfMethodCallIgnored
        d.mkdirs();
        return new java.io.File(d, "photo.jpg");
    }

    /** Copies the plaintext to a stream the user chose (Save as…). */
    public static void copyTo(M5 app, ChatMessage m, OutputStream out) throws IOException {
        try (InputStream in = open(app, m); OutputStream o = out) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
        }
    }

    /** InputStream.readAllBytes / transferTo are Android 13+; the app runs from Android 10. */
    static byte[] readAll(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toByteArray();
    }

    /**
     * content://<package>.files/<room>/<message id>/<name> — the file decrypted
     * into a pipe as the other app reads it. Only while the app is unlocked,
     * only messages of the rooms in memory; the URI works for the intent's
     * receiver alone (grantUriPermissions, not exported).
     */
    public static final class FilesProvider extends ContentProvider {
        @Override public boolean onCreate() { return true; }

        private static ChatMessage find(Uri uri) {
            java.util.List<String> p = uri.getPathSegments();
            if (p.size() < 3) return null;
            M5 app = M5.get();
            cz.m5cet.app.chat.RoomSession r = app.rooms.session(p.get(0));
            if (r == null) return null;
            for (ChatMessage m : r.messagesCopy()) if (m.id.equals(p.get(1))) return m;
            return null;
        }

        @Override public String getType(Uri uri) {
            ChatMessage m = find(uri);
            return m == null || m.fileMime == null ? "application/octet-stream" : m.fileMime;
        }

        @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
            java.util.List<String> seg = uri.getPathSegments();
            if (seg.size() == 1 && "capture".equals(seg.get(0))) {
                // The camera app's photo: write only, into the cache (sent and deleted right after).
                if (!mode.contains("w")) throw new FileNotFoundException("write only");
                return ParcelFileDescriptor.open(captureFile(M5.get()), ParcelFileDescriptor.MODE_WRITE_ONLY | ParcelFileDescriptor.MODE_CREATE | ParcelFileDescriptor.MODE_TRUNCATE);
            }
            if (!"r".equals(mode)) throw new FileNotFoundException("read only");
            M5 app = M5.get();
            if (app.lock.isLocked()) throw new FileNotFoundException("the app is locked");
            ChatMessage m = find(uri);
            if (m == null) throw new FileNotFoundException("no such file");
            try {
                ParcelFileDescriptor[] pipe = ParcelFileDescriptor.createPipe();
                Io.bg(() -> {
                    try (OutputStream out = new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])) { copyTo(app, m, out); }
                    catch (IOException e) { Log.w("media", "provider: " + e.getMessage()); }
                });
                return pipe[0];
            } catch (IOException e) { throw new FileNotFoundException(e.getMessage()); }
        }

        @Override public Cursor query(Uri uri, String[] projection, String sel, String[] args, String sort) {
            ChatMessage m = find(uri);
            MatrixCursor c = new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE});
            if (m != null) c.addRow(new Object[]{m.fileName, m.fileSize});
            return c;
        }

        @Override public Uri insert(Uri uri, ContentValues v) { return null; }
        @Override public int delete(Uri uri, String s, String[] a) { return 0; }
        @Override public int update(Uri uri, ContentValues v, String s, String[] a) { return 0; }
    }
}
