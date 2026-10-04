package cz.m5cet.app.security;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;

import java.security.KeyPair;

/** 6.7 (security analysis F-16): the device policy applies only as the pinned server key signed it for this device. */
public class SignedPolicyTest {
    /** Signed by the server's code (server/android/crypto.ts signPolicy) — the formats agree byte for byte. */
    private static final String NODE_KEY = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEkbXImCDqgGYKZpLQXxNgmWauLY/95ict9xpD99v0DRKBB2FBS04nu/7QDeGD/yDfS0KdIil5PTqP65jPmBRXGQ==";
    private static final String NODE_WIRE = "{\"at\":1767225600000,\"policy\":\"{\\\"lock\\\":{\\\"pinLength\\\":6,\\\"maxAttempts\\\":8,\\\"wipe\\\":true,\\\"screenshots\\\":false,\\\"autolockSeconds\\\":60},\\\"logs\\\":\\\"errors\\\"}\","
        + "\"sig\":\"MBx8PB0dZ3HvzifYelc46hPRQ2zAg2mDDTCvM+ZHQJ35DKYjsonwez7y8QzZCZ7XhKzqhAiVITVTdWqF0DUHOw==\"}";

    @Test
    public void theServersSignatureOpens() throws JSONException {
        JSONObject p = SignedPolicy.open(new JSONObject(NODE_WIRE), NODE_KEY, "and_test1", 0);
        assertNotNull(p);
        assertEquals(false, p.getJSONObject("lock").getBoolean("screenshots"));
        assertEquals(8, p.getJSONObject("lock").getInt("maxAttempts"));
        assertNotNull(SignedPolicy.open(new JSONObject(NODE_WIRE), NODE_KEY, "and_test1", 1767225600000L)); // the same again: fine
    }

    @Test
    public void anythingElseIsRefused() throws Exception {
        JSONObject wire = new JSONObject(NODE_WIRE);
        assertNull(SignedPolicy.open(wire, NODE_KEY, "and_other", 0));                         // signed for another device
        assertNull(SignedPolicy.open(wire, Ec.spki(Ec.generate().getPublic()), "and_test1", 0)); // not the pinned key
        assertNull(SignedPolicy.open(wire, NODE_KEY, "and_test1", 1767225600001L));            // older than the one applied (replay)
        JSONObject tampered = new JSONObject(NODE_WIRE);
        tampered.put("policy", tampered.getString("policy").replace("\"screenshots\":false", "\"screenshots\":true"));
        assertNull(SignedPolicy.open(tampered, NODE_KEY, "and_test1", 0));                     // FLAG_SECURE off by a proxy
        JSONObject moved = new JSONObject(NODE_WIRE).put("at", 1767225600002L);
        assertNull(SignedPolicy.open(moved, NODE_KEY, "and_test1", 0));                        // the time is signed too
        assertNull(SignedPolicy.open(null, NODE_KEY, "and_test1", 0));
        assertNull(SignedPolicy.open(new JSONObject(), NODE_KEY, "and_test1", 0));
        assertNull(SignedPolicy.open(wire, "", "and_test1", 0));
    }

    @Test
    public void aPolicySignedHereOpens() throws Exception {
        KeyPair k = Ec.generate();
        String json = new JSONObject().put("lock", new JSONObject().put("wipe", true)).toString();
        String sig = Crypto.b64(Ec.sign(k.getPrivate(), Crypto.utf8(SignedPolicy.signedString("and_x", 5, json))));
        JSONObject wire = new JSONObject().put("at", 5).put("policy", json).put("sig", sig);
        assertNotNull(SignedPolicy.open(wire, Ec.spki(k.getPublic()), "and_x", 4));
    }
}
