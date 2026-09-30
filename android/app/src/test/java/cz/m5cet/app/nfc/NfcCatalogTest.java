package cz.m5cet.app.nfc;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.HashSet;
import java.util.Set;

/** The catalogue mirrors client/src/lib/nfc/catalog.ts — same op ids, same readers. */
public class NfcCatalogTest {

    private static Set<String> opIds(String tech) {
        Set<String> ids = new HashSet<>();
        for (NfcCatalog.Op o : NfcCatalog.opsFor(tech)) ids.add(o.id);
        return ids;
    }

    @Test
    public void everyTechCarriesTheCommonOps() {
        for (NfcCatalog.TechInfo t : NfcCatalog.CATALOG) {
            if (t.tech.equals(NfcCatalog.UNKNOWN)) continue;
            Set<String> ids = opIds(t.tech);
            assertTrue(t.tech + " has scan", ids.contains("scan"));
            assertTrue(t.tech + " has read-uid", ids.contains("read-uid"));
            assertTrue(t.tech + " has read-public", ids.contains("read-public"));
        }
    }

    @Test
    public void ndefOps() {
        Set<String> ids = opIds(NfcCatalog.NDEF);
        assertTrue(ids.contains("ndef-read"));
        assertTrue(ids.contains("ndef-write"));
        assertTrue(ids.contains("ndef-lock"));
    }

    @Test
    public void classicOpsAndUidWrite() {
        Set<String> ids = opIds(NfcCatalog.MIFARE_CLASSIC_1K);
        assertTrue(ids.contains("classic-read"));
        assertTrue(ids.contains("classic-write"));
        assertTrue(ids.contains("classic-dump"));
        assertTrue(ids.contains("classic-restore"));
        assertTrue(ids.contains("write-uid"));
        assertTrue(NfcCatalog.supportsOp(NfcCatalog.MIFARE_CLASSIC_4K, "classic-dump"));
        assertFalse(NfcCatalog.supportsOp(NfcCatalog.NDEF, "classic-read"));
    }

    @Test
    public void m5cetCardOps() {
        Set<String> ids = opIds(NfcCatalog.M5CET_CARD);
        assertTrue(ids.contains("m5-read"));
        assertTrue(ids.contains("m5-write"));
        assertTrue(ids.contains("m5-erase"));
        assertTrue(ids.contains("m5-emulate"));
    }

    @Test
    public void emvAndEidArePublicOnly() {
        assertTrue(NfcCatalog.supportsOp(NfcCatalog.EMV, "emv-public"));
        assertTrue(NfcCatalog.supportsOp(NfcCatalog.EID, "eid-public"));
        // No recovery / write ops leaked into EMV or e-ID.
        assertFalse(NfcCatalog.supportsOp(NfcCatalog.EMV, "classic-write"));
    }

    @Test
    public void unknownTechFallsBack() {
        assertEquals(NfcCatalog.UNKNOWN, NfcCatalog.techInfo("no-such-tech").tech);
        assertTrue(NfcCatalog.opsFor("no-such-tech").isEmpty());
    }

    @Test
    public void readersMatchTheWeb() {
        Set<String> kinds = new HashSet<>();
        for (NfcCatalog.ReaderInfo r : NfcCatalog.READERS) kinds.add(r.kind);
        assertTrue(kinds.contains(NfcCatalog.READER_INTERNAL));
        assertTrue(kinds.contains(NfcCatalog.READER_USB));
        assertTrue(kinds.contains(NfcCatalog.READER_BLUETOOTH));
        assertTrue(kinds.contains(NfcCatalog.READER_SERIAL));
    }
}
