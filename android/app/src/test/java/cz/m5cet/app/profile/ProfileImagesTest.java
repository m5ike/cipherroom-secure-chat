package cz.m5cet.app.profile;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

/** 6.7: the profile pictures lose their metadata (EXIF with GPS, XMP, comments) and are cropped like the web's. */
public class ProfileImagesTest {
    private static void seg(ByteArrayOutputStream out, int marker, byte[] body) {
        out.write(0xff);
        out.write(marker);
        out.write(((body.length + 2) >> 8) & 0xff);
        out.write((body.length + 2) & 0xff);
        out.write(body, 0, body.length);
    }

    private static byte[] ascii(String s) { return s.getBytes(StandardCharsets.ISO_8859_1); }

    static byte[] jpegWithExif() {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(0xff);
        out.write(0xd8);
        seg(out, 0xe0, ascii("JFIF\0\1\1\0\0\1\0\1\0\0"));
        seg(out, 0xe1, ascii("Exif\0\0GPSLatitude=49.1951;Serial=SN12345"));
        seg(out, 0xfe, ascii("taken at home"));
        seg(out, 0xdb, new byte[65]);
        seg(out, 0xda, new byte[] { 1, 1, 0, 0, 0x3f, 0 });
        byte[] scan = { 0x12, 0x34, (byte) 0xff, 0x00, 0x56, (byte) 0xff, (byte) 0xd0, 0x78, (byte) 0xff, (byte) 0xd9 };
        out.write(scan, 0, scan.length);
        return out.toByteArray();
    }

    @Test
    public void exifGpsAndCommentsAreStripped() throws Exception {
        byte[] out = ProfileImages.stripJpeg(jpegWithExif());
        String s = new String(out, StandardCharsets.ISO_8859_1);
        assertFalse(s.contains("Exif"));
        assertFalse(s.contains("GPS"));
        assertFalse(s.contains("Serial"));
        assertFalse(s.contains("taken at home"));
        assertTrue(s.contains("JFIF"));
        assertEquals(0xff, out[0] & 0xff);
        assertEquals(0xd8, out[1] & 0xff);
        assertEquals(0xd9, out[out.length - 1] & 0xff);
        // Stripping again changes nothing.
        assertArrayEquals(out, ProfileImages.stripJpeg(out));
    }

    @Test
    public void notAJpegIsRefused() throws Exception {
        assertNull(ProfileImages.stripJpeg(ascii("<svg/>")));
        assertNull(ProfileImages.stripJpeg(new byte[] { (byte) 0xff, (byte) 0xd8, (byte) 0xff, (byte) 0xe1, (byte) 0xff, (byte) 0xff }));
        assertNull(ProfileImages.stripJpeg(null));
    }

    @Test
    public void cropsLikeTheWeb() throws Exception {
        assertArrayEquals(new int[] { 500, 0, 3000, 3000, ProfileCard.AVATAR_PX, ProfileCard.AVATAR_PX }, ProfileImages.cropFor("avatar", 4000, 3000));
        int[] cover = ProfileImages.cropFor("cover", 4000, 3000);
        assertEquals(4000, cover[2]);
        assertEquals(1333, cover[3]);
        assertEquals(ProfileCard.COVER_W, cover[4]);
        assertEquals(400, cover[5]);
        // Never scaled up.
        int[] small = ProfileImages.cropFor("avatar", 100, 50);
        assertEquals(50, small[4]);
        assertEquals(50, small[5]);
    }

    @Test
    public void theCleanPictureIsAValidProfileImage() throws Exception {
        String url = ProfileImages.dataUrl(ProfileImages.stripJpeg(jpegWithExif()));
        assertEquals(url, ProfileCard.cleanImage(url, ProfileCard.AVATAR_BYTES));
    }
}
