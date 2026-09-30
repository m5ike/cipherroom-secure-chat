package cz.m5cet.app.nfc;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** The pure tech-detection mapping mirrors client/src/lib/nfc/cards/detect.ts. */
public class TagTechTest {
    private static final byte[] DESFIRE_ATS = {0x06, 0x75, 0x77, (byte) 0x81, 0x02, (byte) 0x80};

    private static List<String> techs(String... t) { return Arrays.asList(t); }

    @Test
    public void mifareClassicBySak() {
        assertEquals(NfcCatalog.MIFARE_CLASSIC_1K, TagTech.map(techs("NfcA", "MifareClassic", "Ndef"), 0x08, null, false, false));
        assertEquals(NfcCatalog.MIFARE_CLASSIC_4K, TagTech.map(techs("NfcA", "MifareClassic"), 0x18, null, false, false));
        assertEquals(NfcCatalog.MIFARE_CLASSIC_MINI, TagTech.map(techs("NfcA", "MifareClassic"), 0x09, null, false, false));
    }

    @Test
    public void ultralightAndNtag() {
        assertEquals(NfcCatalog.MIFARE_ULTRALIGHT, TagTech.map(techs("NfcA", "MifareUltralight", "Ndef"), 0x00, null, false, false));
        // Plain NfcA with SAK 00 and no Ultralight tech still lands on the Ultralight family.
        assertEquals(NfcCatalog.MIFARE_ULTRALIGHT, TagTech.map(techs("NfcA"), 0x00, null, false, false));
    }

    @Test
    public void isoDepAndDesfire() {
        assertEquals(NfcCatalog.MIFARE_DESFIRE, TagTech.map(techs("NfcA", "IsoDep"), 0x20, DESFIRE_ATS, false, false));
        assertEquals(NfcCatalog.ISO_DEP, TagTech.map(techs("NfcA", "IsoDep"), 0x20, new byte[]{0x78, (byte) 0x80}, false, false));
    }

    @Test
    public void felicaAndVicinity() {
        assertEquals(NfcCatalog.FELICA, TagTech.map(techs("NfcF"), -1, null, false, false));
        assertEquals(NfcCatalog.ISO15693, TagTech.map(techs("NfcV"), -1, null, false, false));
    }

    @Test
    public void plainNdefAndTypeAB() {
        assertEquals(NfcCatalog.NDEF, TagTech.map(techs("Ndef", "NdefFormatable"), -1, null, false, false));
        assertEquals(NfcCatalog.ISO14443B, TagTech.map(techs("NfcB"), -1, null, false, false));
        assertEquals(NfcCatalog.ISO_DEP, TagTech.map(techs("NfcA"), 0x20, null, false, false)); // ISO-DEP bit set
        assertEquals(NfcCatalog.ISO_DEP, TagTech.map(techs("NfcA"), 0x28, null, false, false)); // 0x28 also has the ISO-DEP bit
        assertEquals(NfcCatalog.ISO14443A, TagTech.map(techs("NfcA"), 0x04, null, false, false)); // no known/ISO-DEP bit
    }

    @Test
    public void appOwnCardsWinFirst() {
        assertEquals(NfcCatalog.M5CET_CARD, TagTech.map(techs("NfcA", "Ndef"), 0x00, null, false, true));
        assertEquals(NfcCatalog.CONNECTION_TAG, TagTech.map(techs("NfcA", "Ndef"), 0x00, null, true, false));
        // The M5Cet card beats the connection tag when both flags are set.
        assertEquals(NfcCatalog.M5CET_CARD, TagTech.map(techs("Ndef"), -1, null, true, true));
    }

    @Test
    public void unknownWhenNothingMatches() {
        assertEquals(NfcCatalog.UNKNOWN, TagTech.map(Collections.<String>emptyList(), -1, null, false, false));
    }

    @Test
    public void desfireAtsRecognised() {
        assertTrue(TagTech.isDesfireAts(DESFIRE_ATS));
        assertTrue(TagTech.isDesfireAts(new byte[]{0x75, 0x77, (byte) 0x81, 0x02, (byte) 0x80}));
        assertFalse(TagTech.isDesfireAts(new byte[]{0x11, 0x22}));
        assertFalse(TagTech.isDesfireAts(null));
    }
}
