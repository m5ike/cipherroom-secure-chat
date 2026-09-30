package cz.m5cet.app.ui.media;

import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.pdf.PdfRenderer;
import android.media.MediaDataSource;
import android.media.MediaMetadataRetriever;
import android.os.Build;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

import cz.m5cet.app.M5;
import cz.m5cet.app.chat.ChatMessage;
import cz.m5cet.app.core.Log;

/**
 * Previews of an attachment in its bubble (6.2): the first lines of a text,
 * the first page of a PDF, a video's first frame. Everything is read from
 * the vault (VaultMedia) and kept in memory; see pdfFirstPage for the one
 * moment plaintext needs a file descriptor.
 */
public final class Previews {
    private Previews() {}

    public enum Type { IMAGE, AUDIO, VIDEO, PDF, TEXT, OTHER }

    private static final String[] TEXT_EXT = {"txt", "md", "markdown", "csv", "tsv", "json", "log", "xml", "yaml", "yml", "ini", "conf"};

    public static Type type(ChatMessage m) {
        String mime = m.fileMime == null ? "" : m.fileMime.toLowerCase(Locale.ROOT);
        String name = m.fileName == null ? "" : m.fileName.toLowerCase(Locale.ROOT);
        String ext = name.lastIndexOf('.') >= 0 ? name.substring(name.lastIndexOf('.') + 1) : "";
        if (m.fileImage) return Type.IMAGE;
        if (mime.startsWith("audio/")) return Type.AUDIO;
        if (mime.startsWith("video/")) return Type.VIDEO;
        if (mime.equals("application/pdf") || ext.equals("pdf")) return Type.PDF;
        if (mime.startsWith("text/") || mime.equals("application/json") || mime.equals("application/xml")) return Type.TEXT;
        for (String e : TEXT_EXT) if (e.equals(ext)) return Type.TEXT;
        return Type.OTHER;
    }

    /** The icon of a type (the footer, a file without a preview). */
    public static String icon(Type t) {
        switch (t) {
            case IMAGE: return "file-image";
            case AUDIO: return "file-headphone";
            case VIDEO: return "file-play";
            case PDF: case TEXT: return "file-text";
            default: return "file";
        }
    }

    /* -------------------------------------------------------------- text */

    /** The first lines of a text file (at most 8 KB read, each line at most 160 characters); null when unreadable. */
    public static String textHead(M5 app, ChatMessage m, int lines) {
        byte[] head = new byte[8 * 1024];
        int n = 0;
        try (InputStream in = VaultMedia.open(app, m)) {
            int r;
            while (n < head.length && (r = in.read(head, n, head.length - n)) > 0) n += r;
        } catch (IOException e) {
            Log.w("media", "text preview: " + e.getMessage());
            return null;
        }
        CharBuffer chars;
        try {
            chars = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPLACE).onUnmappableCharacter(CodingErrorAction.REPLACE).decode(ByteBuffer.wrap(head, 0, n));
        } catch (java.nio.charset.CharacterCodingException e) { return null; }
        String[] all = chars.toString().replace("\r\n", "\n").split("\n", -1);
        StringBuilder b = new StringBuilder();
        int shown = 0;
        for (int i = 0; i < all.length && shown < lines; i++) {
            if (i == all.length - 1 && n == head.length) break; // cut in the middle
            String line = all[i].replace('\t', ' ');
            if (shown == 0 && line.trim().isEmpty()) continue;
            if (line.length() > 160) line = line.substring(0, 160) + "…";
            if (shown > 0) b.append('\n');
            b.append(line);
            shown++;
        }
        return b.toString();
    }

    /* --------------------------------------------------------------- PDF */

    /** The first page as a picture, and how many pages there are. */
    public static final class Page {
        public final Bitmap bitmap;
        public final int pages;
        Page(Bitmap b, int pages) { bitmap = b; this.pages = pages; }
    }

    /**
     * The first page of a PDF, at most maxWidth px wide; null when it cannot
     * be drawn (damaged, password-protected, over 40 MB).
     *
     * PdfRenderer needs a seekable file descriptor, not a stream. From
     * Android 11 the plaintext goes into an anonymous memory file
     * (memfd_create) and never touches the disk. On Android 10 it is written
     * to the app's private cache, and the file is deleted as soon as it is
     * open — before rendering — so it has no name while it exists and its
     * blocks are freed when the descriptor closes right after the page.
     */
    public static Page pdfFirstPage(M5 app, ChatMessage m, int maxWidth) {
        if (m.fileSize > 40L << 20) return null;
        ParcelFileDescriptor pfd = null;
        File tmp = null;
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                // The ParcelFileDescriptor holds its own copy of the memory file; the original closes at once.
                FileDescriptor fd = android.system.Os.memfd_create("m5-pdf", 0);
                try { pfd = ParcelFileDescriptor.dup(fd); } finally { android.system.Os.close(fd); }
                try (InputStream in = VaultMedia.open(app, m)) {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) for (int off = 0; off < n; ) off += android.system.Os.write(pfd.getFileDescriptor(), buf, off, n - off);
                }
                android.system.Os.lseek(pfd.getFileDescriptor(), 0, android.system.OsConstants.SEEK_SET);
            } else {
                File dir = new File(app.getCacheDir(), "preview");
                //noinspection ResultOfMethodCallIgnored
                dir.mkdirs();
                tmp = File.createTempFile("p", ".pdf", dir);
                try (InputStream in = VaultMedia.open(app, m); OutputStream out = new FileOutputStream(tmp)) { in.transferTo(out); }
                pfd = ParcelFileDescriptor.open(tmp, ParcelFileDescriptor.MODE_READ_ONLY);
                //noinspection ResultOfMethodCallIgnored
                tmp.delete();
                tmp = null;
            }
            try (PdfRenderer r = new PdfRenderer(pfd)) {
                if (r.getPageCount() == 0) return null;
                try (PdfRenderer.Page page = r.openPage(0)) {
                    float s = Math.min(3f, maxWidth / (float) Math.max(1, page.getWidth()));
                    int w = Math.max(1, Math.round(page.getWidth() * s)), h = Math.max(1, Math.round(page.getHeight() * s));
                    if (h > w * 3) h = w * 3;
                    Bitmap b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
                    b.eraseColor(Color.WHITE);
                    android.graphics.Matrix mx = new android.graphics.Matrix();
                    mx.setScale(s, s);
                    page.render(b, null, mx, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                    return new Page(b, r.getPageCount());
                }
            }
        } catch (Exception | OutOfMemoryError e) {
            Log.w("media", "PDF preview: " + e.getMessage());
            return null;
        } finally {
            if (pfd != null) try { pfd.close(); } catch (IOException ignored) { }
            if (tmp != null) //noinspection ResultOfMethodCallIgnored
                tmp.delete();
        }
    }

    /* ------------------------------------------------------------- video */

    /** A video's first frame and what the player needs to know before it plays. */
    public static final class Frame {
        public final Bitmap bitmap;
        public final long durationMs;
        public final int width, height;
        Frame(Bitmap b, long d, int w, int h) { bitmap = b; durationMs = d; width = w; height = h; }
    }

    /** Read through the vault's MediaDataSource (decrypted as it is read); null when it is not a playable video. */
    public static Frame videoFrame(M5 app, ChatMessage m, int maxPx) {
        MediaMetadataRetriever r = new MediaMetadataRetriever();
        try (MediaDataSource src = VaultMedia.source(app, m)) {
            r.setDataSource(src);
            long d = parse(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION));
            int w = (int) parse(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH));
            int h = (int) parse(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT));
            int rot = (int) parse(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION));
            if (rot == 90 || rot == 270) { int t = w; w = h; h = t; }
            Bitmap f = r.getFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC);
            if (f != null && Math.max(f.getWidth(), f.getHeight()) > maxPx) {
                float s = maxPx / (float) Math.max(f.getWidth(), f.getHeight());
                Bitmap small = Bitmap.createScaledBitmap(f, Math.max(1, Math.round(f.getWidth() * s)), Math.max(1, Math.round(f.getHeight() * s)), true);
                if (small != f) f.recycle();
                f = small;
            }
            if (f != null && (w <= 0 || h <= 0)) { w = f.getWidth(); h = f.getHeight(); }
            return new Frame(f, d, w, h);
        } catch (Exception | OutOfMemoryError e) {
            Log.w("media", "video preview: " + e.getMessage());
            return null;
        } finally {
            try { r.release(); } catch (Exception ignored) { }
        }
    }

    private static long parse(String s) {
        try { return s == null ? 0 : Long.parseLong(s.trim()); } catch (NumberFormatException e) { return 0; }
    }
}
