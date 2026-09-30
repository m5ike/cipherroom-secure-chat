package cz.m5cet.app.nfc;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;

/**
 * The pure byte-layout of the "NDEF onto any tag" write path (CardOps.ndefWriteAny):
 * the NDEF Message TLV, and the MIFARE Classic MAD / sector layout the writer lays
 * down. No hardware — just the maths, so a card written on a phone is a standard,
 * MIFARE-Classic-Tool-readable NDEF tag.
 */
public class NfcWriteTest {

    /* ------------------------------------------------------------- TLV */

    @Test
    public void tlvShort() {
        byte[] msg = {0x11, 0x22, 0x33};
        byte[] tlv = CardOps.ndefTlv(msg);
        // 03 | len | msg | FE
        assertArrayEquals(new byte[]{0x03, 0x03, 0x11, 0x22, 0x33, (byte) 0xFE}, tlv);
    }

    @Test
    public void tlvThreeByteLengthAt255() {
        byte[] msg = new byte[255];
        Arrays.fill(msg, (byte) 0x5A);
        byte[] tlv = CardOps.ndefTlv(msg);
        assertEquals(0x03, tlv[0] & 0xff);          // NDEF Message TLV
        assertEquals(0xFF, tlv[1] & 0xff);          // 3-byte length marker
        assertEquals(0x00, tlv[2] & 0xff);          // length high
        assertEquals(0xFF, tlv[3] & 0xff);          // length low = 255
        assertEquals(0x5A, tlv[4] & 0xff);          // payload starts
        assertEquals(0xFE, tlv[tlv.length - 1] & 0xff);
        assertEquals(1 + 3 + 255 + 1, tlv.length);
    }

    @Test
    public void tlvOneByteLengthBelow255() {
        byte[] tlv = CardOps.ndefTlv(new byte[254]);
        assertEquals(0x03, tlv[0] & 0xff);
        assertEquals(254, tlv[1] & 0xff);           // still 1-byte length
        assertEquals(1 + 1 + 254 + 1, tlv.length);
    }

    /* ---------------------------------------------------- sectors / capacity */

    @Test
    public void dataSectors1K() {
        int[] s = CardOps.ndefDataSectors(16);      // 1K: sector 0 is the MAD, 1..15 are data
        assertArrayEquals(new int[]{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}, s);
    }

    @Test
    public void dataSectors4KSkipsMad2() {
        int[] s = CardOps.ndefDataSectors(40);      // 4K: sector 16 is MAD2, skipped
        assertEquals(38, s.length);                 // 40 - sector0 - sector16
        assertFalseContains(s, 0);
        assertFalseContains(s, 16);
        assertEquals(1, s[0]);
        assertEquals(39, s[s.length - 1]);
    }

    @Test
    public void capacityMatchesNfcForum() {
        assertEquals(192, CardOps.classicDataCapacity(5));    // MINI: 4 data sectors × 48
        assertEquals(720, CardOps.classicDataCapacity(16));   // 1K: 15 × 48
        assertEquals(3360, CardOps.classicDataCapacity(40));  // 4K: 15×48 + 15×48 + 8×240
    }

    @Test
    public void blocksPerSector() {
        assertEquals(4, CardOps.blocksInSector(0));
        assertEquals(4, CardOps.blocksInSector(31));
        assertEquals(16, CardOps.blocksInSector(32));   // the large 4K sectors
        assertEquals(16, CardOps.blocksInSector(39));
    }

    /* ----------------------------------------------------------------- MAD */

    @Test
    public void madCrcOfFullyNdef1KIs0x14() {
        // A 1K card with every data sector NDEF: info 0x01 then 15 × (03 E1).
        byte[] madData = new byte[31];
        madData[0] = 0x01;
        for (int i = 0; i < 15; i++) { madData[1 + 2 * i] = 0x03; madData[2 + 2 * i] = (byte) 0xE1; }
        assertEquals((byte) 0x14, CardOps.madCrc(madData));
    }

    @Test
    public void mad1FullyNdefMatchesTheStandardBlocks() {
        boolean[] used = new boolean[16];
        for (int s = 1; s <= 15; s++) used[s] = true;
        byte[] mad = CardOps.buildMad1(used);
        // block 1: 14 01 03 E1 03 E1 03 E1 03 E1 03 E1 03 E1 03 E1
        assertEquals((byte) 0x14, mad[0]);          // CRC
        assertEquals(0x01, mad[1]);                 // info byte
        for (int s = 1; s <= 15; s++) {
            assertEquals(0x03, mad[2 * s] & 0xff);
            assertEquals(0xE1, mad[2 * s + 1] & 0xff);
        }
        assertEquals(32, mad.length);
    }

    @Test
    public void mad1MarksOnlyUsedSectors() {
        boolean[] used = new boolean[16];
        used[1] = true; used[2] = true;             // a small message → two data sectors
        byte[] mad = CardOps.buildMad1(used);
        assertEquals(0x03, mad[2] & 0xff);          // sector 1 AID
        assertEquals(0xE1, mad[3] & 0xff);
        assertEquals(0x03, mad[4] & 0xff);          // sector 2 AID
        assertEquals(0xE1, mad[5] & 0xff);
        assertEquals(0x00, mad[6] & 0xff);          // sector 3 not marked
        assertEquals(0x00, mad[7] & 0xff);
        // CRC is deterministic and set (not the fully-NDEF 0x14).
        assertTrue((mad[0] & 0xff) != 0x14);
    }

    @Test
    public void mad2Layout() {
        boolean[] used = new boolean[40];
        used[17] = true; used[39] = true;
        byte[] mad = CardOps.buildMad2(used, 40);
        assertEquals(48, mad.length);
        assertEquals(0x00, mad[1] & 0xff);          // MAD2 info byte
        assertEquals(0x03, mad[2] & 0xff);          // sector 17 AID
        assertEquals(0xE1, mad[3] & 0xff);
        assertEquals(0x00, mad[4] & 0xff);          // sector 18 not marked
        // sector 39 is slot 22 → bytes 2 + 2*22 = 46,47
        assertEquals(0x03, mad[46] & 0xff);
        assertEquals(0xE1, mad[47] & 0xff);
    }

    /* --------------------------------------------------------------- helpers */

    private static void assertFalseContains(int[] a, int v) {
        for (int x : a) if (x == v) throw new AssertionError("sector " + v + " should be skipped (a MAD sector)");
    }
}
