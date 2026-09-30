package cz.m5cet.app.contacts;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** Safety numbers, fingerprints and key ids as the web computes them (client/src/lib/identity.ts; vectors from Node's WebCrypto). */
public class SafetyTest {
    private static final String A = "AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dzj6vH4/wYNFBsiKTA3PkVMU1phaG92fYSLkpmgp661vMPK0djf5u30+wIJEBceJSwzOkFIT1ZdZGtyeQ==";
    private static final String B = "yNXi7/wJFiMwPUpXZHF+i5ilsr/M2ebzAA0aJzRBTltodYKPnKm2w9Dd6vcEER4rOEVSX2x5hpOgrbrH1OHu+wgVIi88SVZjcH2Kl6SxvsvY5fL/DBkmM0BNWg==";
    private static final String NUMBER = "13286 60170 84613 24995 23962 36648 18264 48418 04707 59157 69365 29038";

    @Test
    public void theSameNumberOnBothSides() {
        assertEquals(NUMBER, Safety.number(A, B));
        assertEquals(NUMBER, Safety.number(B, A));
    }

    @Test
    public void noNumberWithoutBothKeys() {
        assertEquals("", Safety.number(A, ""));
        assertEquals("", Safety.number(null, B));
        assertEquals("", Safety.number(A, "not base64 !"));
    }

    @Test
    public void readAloudInThreeLines() {
        assertEquals("13286 60170 84613 24995\n23962 36648 18264 48418\n04707 59157 69365 29038", Safety.lines(NUMBER));
        assertEquals("", Safety.lines(""));
    }

    @Test
    public void fingerprintAndKeyId() {
        assertEquals("8537 3E64 524D FF04 7F54 2310 0FA3 B932", Safety.fingerprint(A));
        assertEquals("hTc-ZFJN_wR_VCMQ", Safety.keyId(A));
        assertEquals("", Safety.fingerprint(""));
        assertEquals("", Safety.keyId(null));
    }
}
