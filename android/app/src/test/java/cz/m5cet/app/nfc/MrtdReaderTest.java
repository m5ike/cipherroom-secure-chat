package cz.m5cet.app.nfc;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.json.JSONObject;
import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * The MRTD parsers (MrtdReader) — the Java port of test/nfc-mrtd.test.ts: the MRZ
 * of DG1, the data-group list of EF.COM and the face pulled out of DG2. The
 * reader's BAC + secure messaging are pinned in BacDesTest.
 */
public class MrtdReaderTest {

    private static byte[] tlv(int tag, byte[] value) {
        ByteArrayOutputStream w = new ByteArrayOutputStream();
        if (tag > 0xff) w.write((tag >> 8) & 0xff);
        w.write(tag & 0xff);
        w.write(value.length);
        w.write(value, 0, value.length);
        return w.toByteArray();
    }
    private static byte[] tlv(int tag, String ascii) { return tlv(tag, ascii.getBytes(StandardCharsets.US_ASCII)); }

    @Test
    public void parsesTd3PassportMrz() {
        String mrz = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<L898902C<3UTO6908061F9406236ZE184226B<<<<<10";
        JSONObject m = MrtdReader.parseMrz(mrz);
        assertEquals("P", m.optString("documentCode"));
        assertEquals("UTO", m.optString("issuer"));
        assertEquals("ERIKSSON", m.optString("surname"));
        assertEquals("ANNA MARIA", m.optString("givenNames"));
        assertEquals("L898902C", m.optString("documentNumber"));
        assertEquals("UTO", m.optString("nationality"));
        assertEquals("1969-08-06", m.optString("dateOfBirth"));
        assertEquals("F", m.optString("sex"));
        assertEquals("1994-06-23", m.optString("dateOfExpiry")); // the worked-example passport is an old one
    }

    @Test
    public void readsMrzOutOfDg1() {
        String mrzText = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<L898902C<3UTO6908061F9406236ZE184226B<<<<<10";
        byte[] dg1 = tlv(0x61, tlv(0x5f1f, mrzText));
        JSONObject m = MrtdReader.mrzFromDg1(dg1);
        assertEquals("ERIKSSON", m.optString("surname"));
        assertEquals("L898902C", m.optString("documentNumber"));
    }

    @Test
    public void listsDataGroupsFromEfCom() {
        // 60 { 5F01 (LDS version) 5F36 (unicode) 5C (tag list: 61 75 6C 6D) }
        byte[] com = tlv(0x60, Apdu.concat(tlv(0x5f01, "0107"), tlv(0x5f36, "040000"), tlv(0x5c, Apdu.u8(0x61, 0x75, 0x6c, 0x6d))));
        List<String> dg = MrtdReader.dataGroupsFromCom(com);
        assertEquals(java.util.Arrays.asList("DG1", "DG2", "DG12", "DG13"), dg);
    }

    @Test
    public void extractsEmbeddedJpegFace() {
        byte[] header = Apdu.u8(0x7f, 0x61, 0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
        byte[] jpeg = Apdu.u8(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9);
        MrtdReader.Face face = MrtdReader.faceFromDg2(Apdu.concat(header, jpeg));
        assertEquals("image/jpeg", face.mime);
        assertArrayEquals(Apdu.u8(0xff, 0xd8, 0xff), Apdu.slice(face.data, 0, 3));
    }

    @Test
    public void recognisesJpeg2000Face() {
        byte[] jp2 = Apdu.u8(0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a);
        MrtdReader.Face face = MrtdReader.faceFromDg2(Apdu.concat(Apdu.u8(0x75, 0x05, 0, 0, 0, 0, 0), jp2));
        assertEquals("image/jp2", face.mime);
    }

    @Test
    public void returnsNullWhenNoImage() {
        assertNull(MrtdReader.faceFromDg2(Apdu.u8(0x75, 0x03, 0x01, 0x02, 0x03)));
    }
}
