package cz.m5cet.app.p4;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** test/vectors/p4.json: join, pad, unpad, HKDF, KDF_RK, KDF_CK, keyIv, ML-KEM-768. */
public class PrimitivesVectorTest {
    @Test
    public void joinPadUnpad() throws Exception {
        JSONObject V = Vectors.get();
        assertEquals("m5cet-p4-vectors/1", V.getString("format"));
        JSONArray joins = V.getJSONArray("join");
        assertTrue(joins.length() >= 2);
        for (int i = 0; i < joins.length(); i++) {
            JSONObject j = joins.getJSONObject(i);
            JSONArray parts = j.getJSONArray("parts");
            Object[] p = new Object[parts.length()];
            for (int k = 0; k < p.length; k++) p[k] = parts.get(k) instanceof Number ? (Object) ((Number) parts.get(k)).longValue() : parts.get(k);
            assertEquals(j.getString("text"), Prim.joinText(p));
        }
        JSONArray pads = V.getJSONArray("pad");
        assertEquals(11, pads.length());
        for (int i = 0; i < pads.length(); i++) {
            JSONObject c = pads.getJSONObject(i);
            byte[] m = Vectors.bytes(c.getInt("len"), x -> x % 251);
            byte[] p = Pad.pad(m);
            assertEquals(c.getInt("paddedLength"), p.length);
            assertEquals(c.getInt("paddedLength"), Pad.paddedLength(c.getInt("len")));
            assertEquals(c.getString("sha256"), Prim.hex(Prim.H(p)));
            if (c.has("in")) { assertEquals(c.getString("in"), Prim.b64(m)); assertEquals(c.getString("out"), Prim.b64(p)); }
            assertEquals(Prim.b64(m), Prim.b64(Pad.unpad(p)));
        }
        JSONArray unpads = V.getJSONArray("unpad");
        for (int i = 0; i < unpads.length(); i++) {
            JSONObject c = unpads.getJSONObject(i);
            byte[] in = Prim.unb64(c.getString("in"));
            if (c.getBoolean("ok")) assertEquals(c.getString("out"), Prim.b64(Pad.unpad(in)));
            else try { Pad.unpad(in); fail("unpad " + i); } catch (P4Error e) { assertEquals("malformed", e.code); }
        }
    }

    @Test
    public void joinRefusesSeparatorsAndBadIntegers() {
        for (Object bad : new Object[]{"a|b", "é", "\n", -1L, Prim.MAX_SAFE + 1, 1.5}) {
            try { Prim.join("x", bad); fail("accepted " + bad); } catch (P4Error e) { assertEquals("malformed", e.code); }
        }
    }

    @Test
    public void hkdfKdfRkKdfCkKeyIv() throws Exception {
        JSONObject V = Vectors.get();
        JSONArray hk = V.getJSONArray("hkdf");
        for (int i = 0; i < hk.length(); i++) {
            JSONObject c = hk.getJSONObject(i);
            assertEquals(c.getString("okm"), Prim.b64(Prim.hkdf(Prim.unb64(c.getString("salt")), Prim.unb64(c.getString("ikm")), c.getString("info"), c.getInt("length"))));
        }
        JSONArray rk = V.getJSONArray("kdfRk");
        for (int i = 0; i < rk.length(); i++) {
            JSONObject c = rk.getJSONObject(i);
            byte[][] r = Ratchet.kdfRk(Prim.unb64(c.getString("rk")), Prim.unb64(c.getString("dh")), c.isNull("kss") ? null : Prim.unb64(c.getString("kss")));
            assertEquals(c.getString("rkOut"), Prim.b64(r[0]));
            assertEquals(c.getString("ck"), Prim.b64(r[1]));
        }
        JSONObject ck = V.getJSONArray("kdfCk").getJSONObject(0);
        byte[][] r = Ratchet.kdfCk(Prim.unb64(ck.getString("ck")));
        assertEquals(ck.getString("mk"), Prim.b64(r[0]));
        assertEquals(ck.getString("next"), Prim.b64(r[1]));
        JSONArray ki = V.getJSONArray("keyIv");
        for (int i = 0; i < ki.length(); i++) {
            JSONObject c = ki.getJSONObject(i);
            byte[][] k = Prim.keyIv(Prim.unb64(c.getString("mk")), c.getString("label"));
            assertEquals(c.getString("key"), Prim.b64(k[0]));
            assertEquals(c.getString("iv"), Prim.b64(k[1]));
        }
    }

    @Test
    public void mlKem768KeygenEncapsDecaps() throws Exception {
        JSONArray cases = Vectors.get().getJSONArray("mlkem");
        assertEquals(2, cases.length());
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.getJSONObject(i);
            Kem.KeyPair kp = Kem.keygenFromSeed(Prim.unb64(c.getString("seed")));
            assertEquals(c.getString("ek"), Prim.b64(kp.ek));
            assertEquals(c.getString("dk"), Prim.b64(kp.dk));
            assertEquals(c.getString("kid"), Kem.kid(kp.ek));
            Kem.Encapsulated e = Kem.encapsWith(kp.ek, Prim.unb64(c.getString("m")));
            assertEquals(c.getString("ct"), Prim.b64(e.ct));
            assertEquals(c.getString("ss"), Prim.b64(e.ss));
            assertEquals(c.getString("ss"), Prim.b64(Kem.decaps(Prim.unb64(c.getString("ct")), kp.dk)));
            // Implicit rejection: a changed ciphertext gives another secret, never an error.
            byte[] bad = Prim.unb64(c.getString("ct"));
            bad[17] ^= 1;
            assertTrue(!c.getString("ss").equals(Prim.b64(Kem.decaps(bad, kp.dk))));
        }
    }

    @Test
    public void mlKemRefusesWrongSizesAndInvalidKeys() throws Exception {
        Kem.KeyPair kp = Kem.keygenFromSeed(new byte[64]);
        try { Kem.encapsWith(new byte[1183], new byte[32]); fail(); } catch (P4Error e) { assertEquals("malformed", e.code); }
        try { Kem.decaps(new byte[1087], kp.dk); fail(); } catch (P4Error e) { assertEquals("kct", e.code); }
        byte[] ek = kp.ek.clone();
        ek[0] = (byte) 0xff; ek[1] = (byte) 0xff; // a coefficient >= q: FIPS 203 § 7.2 input check
        try { Kem.encapsWith(ek, new byte[32]); fail(); } catch (P4Error e) { assertEquals("malformed", e.code); }
    }

    @Test
    public void strictBase64() {
        for (String bad : new String[]{"QQ", "QR==", "Q Q==", "QQ==\n", "QQ=="}) {
            try {
                byte[] b = Prim.unb64(bad, 2);
                if (!bad.equals("QQ==")) fail("accepted " + bad); else fail("length");
            } catch (P4Error e) { assertEquals("malformed", e.code); }
        }
        try { Prim.unb64url("QR", -1); fail(); } catch (P4Error e) { assertEquals("malformed", e.code); }
    }
}
