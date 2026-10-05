package cz.m5cet.app.p4;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import cz.m5cet.app.security.Ec;

/**
 * test/vectors/p4.json "handshake" and "ratchet": both hellos verify (the
 * protocol-3 sig, sig4 with its mb / acc digests), replaying each party's tape
 * rebuilds the same hellos, KEM messages, TH / RK0 / CK_B0 / SID, and the whole
 * scripted conversation byte for byte — every send produces exactly the web's
 * frame, every receive opens the web's frame to the same inner message.
 */
public class HandshakeRatchetVectorTest {
    static Prim.DeviceSigner signerOf(String pkcs8, String pk) throws P4Error {
        Prim.P256 pair = Prim.importP256Pkcs8(pkcs8);
        assertEquals(pk, pair.spki);
        return Prim.signer(pair.privateKey, pk);
    }

    @Test
    public void handshakeAndWholeRatchetScript() throws Exception {
        JSONObject V = Vectors.get();
        JSONObject hs = V.getJSONObject("handshake");
        String roomId = hs.getString("roomId"), check = hs.getString("check"), roomName = hs.getString("roomName");
        long now = hs.getLong("now");
        JSONObject[] party = {hs.getJSONObject("A"), hs.getJSONObject("B")};
        Rng.Tape[] rng = {new Rng.Tape(party[0].getJSONArray("tape")), new Rng.Tape(party[1].getJSONArray("tape"))};
        Handshake.Built[] built = new Handshake.Built[2];

        for (int side = 0; side < 2; side++) {
            JSONObject p = party[side], q = party[1 - side];
            JSONObject hello = p.getJSONObject("hello");
            // The protocol-3 signature (over the readable room name) and sig4.
            assertTrue(Ec.verify(p.getString("pk"), Prim.utf8("m5cet/hello/1|" + roomName + "|" + p.getString("peerId") + "|" + q.getString("peerId") + "|" + check + "|" + p.getString("dh")), hello.getString("sig")));
            assertEquals(p.getString("sig4Data"), Vectors.text(Handshake.sig4Data(roomId, p.getString("peerId"), q.getString("peerId"), hello)));
            Handshake.Verdict verdict = Handshake.verifyHello(hello, roomId, p.getString("peerId"), q.getString("peerId"), check, now);
            assertTrue(verdict.why, verdict.ok);
            if (hello.isNull("mb")) assertNull(verdict.mailbox);
            else Vectors.assertJson("mailbox", hello.getJSONObject("mb"), verdict.mailbox.json());
            assertEquals(p.getString("mbDigest"), Handshake.mbDigest(hello.opt("mb")));
            assertEquals(p.getString("accDigest"), Handshake.accDigest(hello.opt("acc")));
            assertEquals(p.getString("helloRef"), Handshake.helloRef(hello));
            // A hello for another recipient, another room or with a changed byte does not verify as v4.
            assertEquals("bad-sig4", Handshake.verifyHello(hello, roomId, p.getString("peerId"), "peer-x", check, now).why);
            assertEquals("bad-sig4", Handshake.verifyHello(hello, "r3.other", p.getString("peerId"), q.getString("peerId"), check, now).why);
            assertEquals("key-mismatch", Handshake.verifyHello(hello, roomId, p.getString("peerId"), q.getString("peerId"), "0000000000000000", now).why);
            // Replaying the tape gives the same hello (but the randomized sig4).
            JSONObject v3 = new JSONObject().put("check", check).put("pk", p.getString("pk")).put("dh", p.getString("dh")).put("sig", hello.getString("sig"))
                .put("caps", new JSONArray().put("bin").put("media"));
            built[side] = Handshake.buildHello(roomId, p.getString("peerId"), q.getString("peerId"), v3, signerOf(p.getString("devicePkcs8"), p.getString("pk")),
                hello.opt("mb"), hello.opt("acc"), hello.opt("sth"), rng[side]);
            Vectors.assertJson("hello " + side, Vectors.without(hello, "sig4"), Vectors.without(built[side].hello, "sig4"));
            assertTrue(Handshake.verifyHello(built[side].hello, roomId, p.getString("peerId"), q.getString("peerId"), check, now).ok);
        }

        // A's mailbox bundle (from its own tape) and B's v2 account certificate.
        JSONObject A = party[0], B = party[1];
        JSONObject mbHello = A.getJSONObject("hello").getJSONObject("mb");
        Mailbox.Keys mbRebuilt = Mailbox.createBundle(signerOf(A.getString("devicePkcs8"), A.getString("pk")), now, new Rng.Tape(A.getJSONArray("mailboxBundleTape")));
        Vectors.assertJson("bundle", Vectors.without(mbHello, "sig"), Vectors.without(mbRebuilt.bundle.json(), "sig"));
        assertEquals(A.getString("mailboxBundleSignedData"), Vectors.text(Mailbox.signedData(mbHello.getString("id"), mbHello.getString("dh"), mbHello.getString("kem"), mbHello.getLong("exp"))));
        assertNull(Mailbox.check(mbHello, A.getString("pk"), now));
        assertEquals("expired", Mailbox.check(mbHello, A.getString("pk"), mbHello.getLong("exp")));
        assertEquals("bad-signature", Mailbox.check(mbHello, B.getString("pk"), now));
        JSONObject acc = B.getJSONObject("hello").getJSONObject("acc");
        byte[] accountSeed = Prim.unb64(B.getString("accountSeed"));
        assertEquals(acc.getString("apk"), Prim.b64(Prim.ed25519Public(accountSeed)));
        assertEquals(B.getString("certSignedData"), Prim.joinText(P4.L_DEVICE_CERT, B.getString("pk"), acc.getLong("exp")));
        Handshake.AccountCheck ac = Handshake.verifyAccount(acc, B.getString("pk"), now);
        assertTrue(ac.valid);
        assertEquals(2, ac.v);
        assertFalse(Handshake.verifyAccount(acc, A.getString("pk"), now).valid);
        assertFalse(Handshake.verifyAccount(acc, B.getString("pk"), acc.getLong("exp")).valid);
        // Ed25519 is deterministic: this port certifies the device exactly as the web did.
        assertEquals(acc.getString("ac"), Handshake.certifyDeviceV2(accountSeed, B.getString("pk"), acc.getLong("exp"), now).getString("sig"));

        // KEM messages: A's (to B's k) first in A's tape after its hello.
        Handshake.KemSent toB = Handshake.buildKemMessage(B.getJSONObject("hello"), rng[0]);
        Handshake.KemSent toA = Handshake.buildKemMessage(A.getJSONObject("hello"), rng[1]);
        Vectors.assertJson("kemAtoB", hs.getJSONObject("kemAtoB").getJSONObject("message"), toB.message);
        Vectors.assertJson("kemBtoA", hs.getJSONObject("kemBtoA").getJSONObject("message"), toA.message);
        assertEquals(hs.getJSONObject("kemAtoB").getString("ss"), Prim.b64(toB.ss));
        assertEquals(hs.getJSONObject("kemBtoA").getString("ss"), Prim.b64(toA.ss));
        byte[][] atA = Handshake.openKemMessage(hs.getJSONObject("kemBtoA").getJSONObject("message"), built[0].hello, built[0].secrets);
        byte[][] atB = Handshake.openKemMessage(hs.getJSONObject("kemAtoB").getJSONObject("message"), built[1].hello, built[1].secrets);
        assertEquals(hs.getJSONObject("kemBtoA").getString("ss"), Prim.b64(atA[1]));
        assertEquals(hs.getJSONObject("kemAtoB").getString("ss"), Prim.b64(atB[1]));
        // A KEM message for another hello is ignored.
        assertNull(Handshake.openKemMessage(hs.getJSONObject("kemAtoB").getJSONObject("message"), built[0].hello, built[0].secrets));

        // § 4: dh0, TH, RK0, CK_B0, SID.
        assertEquals(hs.getString("dh0"), Prim.b64(Prim.ecdh(built[0].secrets.e.privateKey, B.getJSONObject("hello").getString("e"))));
        assertEquals(hs.getString("dh0"), Prim.b64(Prim.ecdh(built[1].secrets.e.privateKey, A.getJSONObject("hello").getString("e"))));
        byte[][] root = Handshake.rootSchedule(Prim.unb64(hs.getString("TH")), Prim.unb64(hs.getString("dh0")), Prim.unb64(hs.getJSONObject("kemAtoB").getString("ss")), Prim.unb64(hs.getJSONObject("kemBtoA").getString("ss")));
        assertEquals(hs.getString("RK0"), Prim.b64(root[0]));
        assertEquals(hs.getString("CK_B0"), Prim.b64(root[1]));
        assertEquals(hs.getString("SID"), Prim.b64(root[2]));
        Handshake.Session sa = Handshake.establish(roomId, check, A.getString("peerId"), built[0].hello, built[0].secrets, B.getString("peerId"), B.getJSONObject("hello"),
            new byte[][]{toB.ct, toB.ss}, atA, rng[0]);
        Handshake.Session sb = Handshake.establish(roomId, check, B.getString("peerId"), built[1].hello, built[1].secrets, A.getString("peerId"), A.getJSONObject("hello"),
            new byte[][]{toA.ct, toA.ss}, atB, rng[1]);
        assertEquals("A", sa.role);
        assertEquals("B", sb.role);
        assertEquals(hs.getString("TH"), Prim.b64(sa.th));
        assertEquals(hs.getString("TH"), Prim.b64(sb.th));
        assertEquals(hs.getString("SID"), Prim.b64(sa.sid));
        assertEquals(hs.getString("SID"), Prim.b64(sb.sid));

        // The script: every send byte for byte, every receive to its inner message.
        Ratchet[] r = {sa.ratchet, sb.ratchet};
        String[] ids = {A.getString("peerId"), B.getString("peerId")};
        JSONArray script = V.getJSONObject("ratchet").getJSONArray("script");
        JSONObject[] wires = new JSONObject[script.length()];
        int kct = 0, sends = 0, recvs = 0;
        for (int i = 0; i < script.length(); i++) {
            JSONObject step = script.getJSONObject(i);
            int by = "A".equals(step.getString("by")) ? 0 : 1;
            if ("send".equals(step.getString("op"))) {
                JSONObject frame = r[by].encrypt(step.getString("json"));
                Vectors.assertJson("send #" + step.getInt("frame"), step.getJSONObject("wire"), frame);
                assertEquals(step.getString("aad"), Vectors.text(Ratchet.pairAad(roomId, ids[by], ids[1 - by], sa.th, frame.getJSONObject("h"))));
                wires[step.getInt("frame")] = step.getJSONObject("wire");
                if (frame.getJSONObject("h").has("kct")) kct++;
                sends++;
            } else {
                Ratchet.Result res = r[by].decrypt(wires[step.getInt("frame")]);
                assertTrue("recv #" + step.getInt("frame") + ": " + res.message, res.ok);
                Vectors.assertJson("recv #" + step.getInt("frame"), step.getJSONObject("inner"), res.inner);
                recvs++;
            }
        }
        assertTrue(sends >= 12);
        assertEquals(sends, recvs);
        JSONObject steps = V.getJSONObject("ratchet").getJSONObject("kemSteps");
        assertEquals(steps.getInt("A") + steps.getInt("B"), kct);
        assertTrue(steps.getInt("A") >= 3 && steps.getInt("B") >= 3);
        assertEquals(0, rng[0].remaining());
        assertEquals(0, rng[1].remaining());

        // A frame already opened is a replay; the session keeps working, the second failure asks for a reset.
        Ratchet.Result again = r[0].decrypt(wires[sends - 1]);
        assertFalse(again.ok);
        assertFalse(again.reset);
        Ratchet.Result twice = r[0].decrypt(wires[sends - 1]);
        assertTrue(twice.reset);
        assertNotNull(twice.error);
    }
}
