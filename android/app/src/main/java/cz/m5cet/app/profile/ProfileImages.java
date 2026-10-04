package cz.m5cet.app.profile;

import android.content.ContentResolver;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Rect;
import android.media.ExifInterface;
import android.net.Uri;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;

import cz.m5cet.app.security.Crypto;

/**
 * 6.7: the profile's photo and background, as the web makes them
 * (client/src/lib/profile/image.ts): decoded with the EXIF orientation
 * applied (that is all that is kept of the EXIF), cropped (a centred square,
 * a 3:1 band), scaled down, encoded as JPEG under a byte cap — and then every
 * metadata segment stripped byte for byte (stripJpeg), so no GPS position,
 * camera or serial number goes anywhere.
 */
public final class ProfileImages {
    private ProfileImages() {}

    public static int cap(String kind) { return "avatar".equals(kind) ? ProfileCard.AVATAR_BYTES : ProfileCard.COVER_BYTES; }

    /** {sx, sy, sw, sh, dw, dh}: the part of the source to draw and its size; never scaled up. */
    public static int[] cropFor(String kind, int w, int h) {
        double ratio = "avatar".equals(kind) ? 1 : (double) ProfileCard.COVER_W / ProfileCard.COVER_H;
        int sw = w, sh = (int) Math.round(w / ratio);
        if (sh > h) { sh = h; sw = (int) Math.round(h * ratio); }
        int sx = (w - sw) / 2, sy = (h - sh) / 2;
        int maxW = "avatar".equals(kind) ? ProfileCard.AVATAR_PX : ProfileCard.COVER_W;
        double scale = Math.min(1.0, (double) maxW / Math.max(1, sw));
        return new int[] { sx, sy, sw, sh, Math.max(1, (int) Math.round(sw * scale)), Math.max(1, (int) Math.round(sh * scale)) };
    }

    /** A JPEG without APP1–APP15 (EXIF, XMP, ICC, IPTC) and comments; null if it is not a well-formed JPEG. */
    public static byte[] stripJpeg(byte[] b) {
        if (b == null || b.length < 4 || (b[0] & 0xff) != 0xff || (b[1] & 0xff) != 0xd8) return null;
        ByteArrayOutputStream out = new ByteArrayOutputStream(b.length);
        out.write(0xff);
        out.write(0xd8);
        int i = 2;
        while (i + 1 < b.length) {
            if ((b[i] & 0xff) != 0xff) return null;
            int marker = b[i + 1] & 0xff;
            while (marker == 0xff && i + 2 < b.length) { i++; marker = b[i + 1] & 0xff; }
            if (marker == 0xd9) { out.write(0xff); out.write(0xd9); return out.toByteArray(); }
            if ((marker >= 0xd0 && marker <= 0xd7) || marker == 0x01) { out.write(0xff); out.write(marker); i += 2; continue; }
            if (i + 3 >= b.length) return null;
            int len = ((b[i + 2] & 0xff) << 8) | (b[i + 3] & 0xff);
            if (len < 2 || i + 2 + len > b.length) return null;
            boolean drop = (marker > 0xe0 && marker <= 0xef) || marker == 0xfe;
            if (!drop) out.write(b, i, 2 + len);
            i += 2 + len;
            // Start of scan: the entropy-coded data and the rest stay as they are.
            if (marker == 0xda) { out.write(b, i, b.length - i); return out.toByteArray(); }
        }
        return null;
    }

    public static String dataUrl(byte[] jpeg) { return "data:image/jpeg;base64," + Crypto.b64(jpeg); }

    private static final int[] QUALITIES = { 86, 78, 70, 60, 50 };
    private static final double[] SCALES = { 1, 0.8, 0.64, 0.5 };

    /**
     * A picked picture → a clean JPEG data: URL for the profile (blocking: run
     * it in the background). Throws "not-an-image" / "image-too-large".
     */
    public static String encode(ContentResolver cr, Uri uri, String kind) throws IOException {
        byte[] raw;
        try (InputStream in = cr.openInputStream(uri)) {
            if (in == null) throw new IOException("not-an-image");
            raw = readCapped(in, 25 * 1024 * 1024);
        }
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(raw, 0, raw.length, bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw new IOException("not-an-image");
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inSampleSize = 1;
        // Decode no larger than twice what is kept (a 50 MP photo would not fit the heap).
        int target = "avatar".equals(kind) ? ProfileCard.AVATAR_PX * 2 : ProfileCard.COVER_W * 2;
        while (Math.max(bounds.outWidth, bounds.outHeight) / (opts.inSampleSize * 2) >= target) opts.inSampleSize *= 2;
        Bitmap bm = BitmapFactory.decodeByteArray(raw, 0, raw.length, opts);
        if (bm == null) throw new IOException("not-an-image");
        bm = oriented(bm, raw);
        int[] c = cropFor(kind, bm.getWidth(), bm.getHeight());
        int limit = cap(kind);
        try {
            for (double scale : SCALES) {
                int w = Math.max(1, (int) Math.round(c[4] * scale)), h = Math.max(1, (int) Math.round(c[5] * scale));
                Bitmap out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
                Canvas canvas = new Canvas(out);
                canvas.drawColor(Color.WHITE); // JPEG has no alpha: white behind a transparent PNG
                canvas.drawBitmap(bm, new Rect(c[0], c[1], c[0] + c[2], c[1] + c[3]), new Rect(0, 0, w, h), new Paint(Paint.FILTER_BITMAP_FLAG));
                for (int q : QUALITIES) {
                    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                    out.compress(Bitmap.CompressFormat.JPEG, q, bytes);
                    byte[] jpeg = bytes.toByteArray();
                    if (jpeg.length > 0 && jpeg.length <= limit) {
                        out.recycle();
                        byte[] clean = stripJpeg(jpeg);
                        if (clean == null) throw new IOException("not-an-image");
                        return dataUrl(clean);
                    }
                }
                out.recycle();
            }
        } finally {
            bm.recycle();
        }
        throw new IOException("image-too-large");
    }

    private static byte[] readCapped(InputStream in, int max) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            if (out.size() > max) throw new IOException("image-too-large");
        }
        return out.toByteArray();
    }

    /** The picture turned the way the camera meant (EXIF orientation), the one thing read from its metadata. */
    private static Bitmap oriented(Bitmap bm, byte[] raw) {
        int orientation;
        try { orientation = new ExifInterface(new java.io.ByteArrayInputStream(raw)).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL); }
        catch (IOException | RuntimeException e) { return bm; }
        Matrix m = new Matrix();
        switch (orientation) {
            case ExifInterface.ORIENTATION_ROTATE_90: m.postRotate(90); break;
            case ExifInterface.ORIENTATION_ROTATE_180: m.postRotate(180); break;
            case ExifInterface.ORIENTATION_ROTATE_270: m.postRotate(270); break;
            case ExifInterface.ORIENTATION_FLIP_HORIZONTAL: m.postScale(-1, 1); break;
            case ExifInterface.ORIENTATION_FLIP_VERTICAL: m.postScale(1, -1); break;
            case ExifInterface.ORIENTATION_TRANSPOSE: m.postRotate(90); m.postScale(-1, 1); break;
            case ExifInterface.ORIENTATION_TRANSVERSE: m.postRotate(270); m.postScale(-1, 1); break;
            default: return bm;
        }
        Bitmap turned = Bitmap.createBitmap(bm, 0, 0, bm.getWidth(), bm.getHeight(), m, true);
        if (turned != bm) bm.recycle();
        return turned;
    }
}
