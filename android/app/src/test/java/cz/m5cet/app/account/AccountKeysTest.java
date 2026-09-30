package cz.m5cet.app.account;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.security.GeneralSecurityException;

import cz.m5cet.app.security.Crypto;

/**
 * The account's key material against the web (client/src/lib/passkey.ts):
 * the vectors were made by the web's own deriveKeyProof / sealRoot / openRoot.
 */
public class AccountKeysTest {
    static final byte[] ROOT = Crypto.unb64("AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=");       // 1…32
    static final byte[] SECRET = Crypto.unb64("oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr8=");     // 0xa0…0xbf

    @Test
    public void keyProofAsTheWeb() {
        assertEquals("ihXn4Wh4-qLqyW1GATHHFOS0yXGdXYWv1k5xqATOLG0", AccountKeys.keyProof(ROOT));
        assertTrue(AccountKeys.keyProof(Crypto.random(32)).matches("[A-Za-z0-9_-]{43}"));   // what /register/verify accepts
    }

    @Test
    public void opensWhatTheWebSealed() throws Exception {
        JSONObject sealed = new JSONObject().put("iv", "pR6pkrNKqhwn3ZLN").put("ct", "vyW+GK+Arl2/N2S4HNzz7mYnjyz7I56HBli8VTlhXpIDgXnrPoSv0DHN+fWk+HIk");
        assertArrayEquals(ROOT, AccountKeys.openRoot(sealed, SECRET, AccountKeys.WRAP_RECOVERY));
        // Another info (a passkey's wrap) or another secret does not open it.
        try { AccountKeys.openRoot(sealed, SECRET, AccountKeys.WRAP_PASSKEY); fail(); } catch (GeneralSecurityException expected) { }
        try { AccountKeys.openRoot(sealed, ROOT, AccountKeys.WRAP_RECOVERY); fail(); } catch (GeneralSecurityException expected) { }
        try { AccountKeys.openRoot(new JSONObject().put("iv", "!!").put("ct", "??"), SECRET, AccountKeys.WRAP_RECOVERY); fail(); } catch (GeneralSecurityException expected) { }
    }

    @Test
    public void sealsAsTheWeb() throws Exception {
        // With the IV fixed, the web's format gives exactly this (and the web's openRoot opens it).
        JSONObject s = AccountKeys.sealRoot(ROOT, SECRET, AccountKeys.WRAP_PASSKEY, Crypto.unb64("EBESExQVFhcYGRob"));
        assertEquals("EBESExQVFhcYGRob", s.getString("iv"));
        assertEquals("fyDTLnQ9RpmWZ4oxAUwL3mEzHYjKZ7LnLVAWJ/44zTg+4s8Ak/3X0b1TyTRlePcj", s.getString("ct"));
        // A fresh IV each time, and it opens again.
        JSONObject a = AccountKeys.sealRoot(ROOT, SECRET, AccountKeys.WRAP_RECOVERY), b = AccountKeys.sealRoot(ROOT, SECRET, AccountKeys.WRAP_RECOVERY);
        assertFalse(a.getString("iv").equals(b.getString("iv")));
        assertArrayEquals(ROOT, AccountKeys.openRoot(a, SECRET, AccountKeys.WRAP_RECOVERY));
        // What the server's store accepts (validWrapped: base64, iv ≤ 32, ct ≤ 256 characters).
        assertTrue(a.getString("iv").length() <= 32 && a.getString("ct").length() <= 256);
    }

    @Test
    public void sealedRootInAnAnswer() throws Exception {
        assertFalse(AccountKeys.sealed(null));
        assertFalse(AccountKeys.sealed(new JSONObject()));
        assertFalse(AccountKeys.sealed(new JSONObject().put("iv", "").put("ct", "")));
        assertTrue(AccountKeys.sealed(new JSONObject().put("iv", "a").put("ct", "b")));
    }

    @Test
    public void prfOfACredential() throws Exception {
        String first = Crypto.b64url(SECRET);
        JSONObject c = new JSONObject().put("clientExtensionResults", new JSONObject().put("prf", new JSONObject().put("results", new JSONObject().put("first", first))));
        assertArrayEquals(SECRET, AccountKeys.prfOf(c));
        // Padded base64url too (some providers pad).
        c.getJSONObject("clientExtensionResults").getJSONObject("prf").getJSONObject("results").put("first", first + "=");
        assertArrayEquals(SECRET, AccountKeys.prfOf(c));
        // Created with PRF enabled but no result (the provider gives it only on an assertion — or never).
        assertNull(AccountKeys.prfOf(new JSONObject().put("clientExtensionResults", new JSONObject().put("prf", new JSONObject().put("enabled", true)))));
        assertNull(AccountKeys.prfOf(new JSONObject().put("clientExtensionResults", new JSONObject())));
        assertNull(AccountKeys.prfOf(new JSONObject()));
        assertNull(AccountKeys.prfOf(null));
        assertNull(AccountKeys.prfOf(new JSONObject().put("clientExtensionResults", new JSONObject().put("prf", new JSONObject().put("results", new JSONObject().put("first", "***"))))));
    }

    @Test
    public void webauthnJson() throws Exception {
        JSONObject options = AccountKeys.withPrf(new JSONObject().put("challenge", "abc").put("extensions", new JSONObject().put("credProps", true)));
        assertTrue(options.getJSONObject("extensions").getBoolean("credProps"));
        assertEquals("bTVjZXQ6cGFzc2tleTpwcmY6djE", options.getJSONObject("extensions").getJSONObject("prf").getJSONObject("eval").getString("first"));

        JSONObject registration = new JSONObject().put("id", "Y3JlZA").put("rawId", "Y3JlZA").put("type", "public-key")
            .put("response", new JSONObject().put("clientDataJSON", "x").put("attestationObject", "y").put("transports", new JSONArray().put("internal").put("hybrid")))
            .put("clientExtensionResults", new JSONObject()).put("authenticatorAttachment", "platform");
        JSONObject stripped = AccountKeys.strip(registration);
        assertEquals(4, stripped.length());   // id, rawId, type, response — not the extension results
        assertFalse(stripped.has("clientExtensionResults"));
        assertEquals("public-key", stripped.getString("type"));

        byte[] challenge = new byte[32];
        JSONObject r = AccountKeys.prfRequest("chat.fir.ma", registration, challenge);
        assertEquals(Crypto.b64url(challenge), r.getString("challenge"));
        assertEquals("chat.fir.ma", r.getString("rpId"));
        assertEquals("required", r.getString("userVerification"));
        JSONArray allow = r.getJSONArray("allowCredentials");
        assertEquals(1, allow.length());
        assertEquals("Y3JlZA", allow.getJSONObject(0).getString("id"));
        assertEquals("public-key", allow.getJSONObject(0).getString("type"));
        assertEquals(2, allow.getJSONObject(0).getJSONArray("transports").length());
        assertTrue(r.getJSONObject("extensions").getJSONObject("prf").has("eval"));
        assertEquals("Y3JlZA", AccountKeys.credentialId(registration));
    }

    @Test
    public void confirmWithAPasskeyOfTheAccount() throws Exception {
        JSONObject summary = new JSONObject().put("credentialId", "AAA")
            .put("passkeys", new JSONArray().put(new JSONObject().put("credentialId", "AAA").put("primary", true)).put(new JSONObject().put("credentialId", "BBB=")));
        JSONArray ids = AccountKeys.credentialIds(summary);
        assertEquals(2, ids.length());
        assertTrue(AccountKeys.contains(ids, "BBB"));
        assertFalse(AccountKeys.contains(ids, "CCC"));
        assertFalse(AccountKeys.contains(ids, ""));
        // An older summary without the list: its first passkey.
        assertEquals("[\"AAA\"]", AccountKeys.credentialIds(new JSONObject().put("credentialId", "AAA")).toString());

        JSONObject r = AccountKeys.confirmRequest("chat.fir.ma", ids, new byte[32]);
        assertEquals("chat.fir.ma", r.getString("rpId"));
        assertEquals("required", r.getString("userVerification"));
        assertEquals(2, r.getJSONArray("allowCredentials").length());
        assertFalse(r.has("extensions"));   // presence only: no key is derived
    }

    @Test
    public void usernameInTheUserHandle() throws Exception {
        String handle = Crypto.b64url(Crypto.utf8("bystry-sokol-7k3q"));
        assertEquals("bystry-sokol-7k3q", AccountKeys.handleName(new JSONObject().put("response", new JSONObject().put("userHandle", handle))));
        assertEquals("", AccountKeys.handleName(new JSONObject().put("response", new JSONObject())));
        assertEquals("", AccountKeys.handleName(new JSONObject().put("response", new JSONObject().put("userHandle", Crypto.b64url(new byte[]{0, 1, 2})))));
        assertEquals("", AccountKeys.handleName(null));
        // 6.4: a registered account's username (10 of abcdefghjkmnpqrstuvwxyz23456789).
        assertEquals("k7mq3xp9ab", AccountKeys.handleName(new JSONObject().put("response", new JSONObject().put("userHandle", Crypto.b64url(Crypto.utf8("k7mq3xp9ab"))))));
    }

    /* ------------------------------------------------------ vault (6.4) */

    /** Made by the web's own deriveKey + sealProfile (IV fixed to 0x30…0x3b) from ROOT. */
    static final String WEB_REGISTRATION = "MDEyMzQ1Njc4OTo7YMQEAIfxdtDjgKB97Caxu8AUZ3tuNNvKng7s/8MReuYP8N36QyRRwVem59RKnqzcSM80uV4GbYxfuimwME+3LWOCJsZP5DVow+W+TDhbwHi5Aj37alM6dWKC8j7BWmrBCE4vb8Cfgs63t5BOULCEGjY5ARX7lgaqLMu0LJYkfwaL5G44wcPfNGrvKg1y8H1B61PO2w8TbJTxvg==";
    static final String WEB_REGISTRATION_JSON = "{\"v\":1,\"firstName\":\"Jan\",\"lastName\":\"Novák\",\"country\":\"CZ\",\"phone\":\"+420777123456\",\"email\":\"jan@example.cz\",\"registeredAt\":1760000000000}";

    /** The same keys with the same values (flat objects; the JVM's org.json does not keep the order). */
    static void assertSameJson(JSONObject expected, JSONObject actual) {
        assertEquals(expected.length(), actual.length());
        for (java.util.Iterator<String> it = expected.keys(); it.hasNext(); ) {
            String k = it.next();
            assertEquals(k, String.valueOf(expected.opt(k)), String.valueOf(actual.opt(k)));
        }
    }

    @Test
    public void opensWhatTheWebSealedInTheVault() throws Exception {
        JSONObject r = AccountKeys.openProfile(WEB_REGISTRATION, AccountKeys.profileKey(ROOT));
        assertEquals(1, r.getInt("v"));
        assertEquals("Novák", r.getString("lastName"));
        assertEquals("+420777123456", r.getString("phone"));
        assertEquals(1760000000000L, r.getLong("registeredAt"));
        // Another root (another account's key) does not open it.
        try { AccountKeys.openProfile(WEB_REGISTRATION, AccountKeys.profileKey(SECRET)); fail(); } catch (GeneralSecurityException expected) { }
        // Nor does the key proof's or a wrap's key: the vault key has its own info.
        assertFalse(Crypto.b64url(AccountKeys.profileKey(ROOT)).equals(AccountKeys.keyProof(ROOT)));
    }

    @Test
    public void sealsTheVaultAsTheWeb() throws Exception {
        // The same key, IV and JSON text give exactly the web's bytes: iv ‖ AES-GCM, no AAD (the web's openProfile opens it).
        byte[] iv = new byte[12];
        for (int i = 0; i < 12; i++) iv[i] = (byte) (0x30 + i);
        byte[] key = AccountKeys.profileKey(ROOT);
        assertEquals(WEB_REGISTRATION, Crypto.b64(Crypto.concat(iv, Crypto.gcmSeal(key, iv, Crypto.utf8(WEB_REGISTRATION_JSON), null))));
        // …and sealProfile is that (the JVM's org.json orders keys its own way, so the text is compared opened).
        String sealed = AccountKeys.sealProfile(new JSONObject(WEB_REGISTRATION_JSON), key, iv);
        assertArrayEquals(iv, java.util.Arrays.copyOf(Crypto.unb64(sealed), 12));
        assertSameJson(new JSONObject(WEB_REGISTRATION_JSON), AccountKeys.openProfile(sealed, key));
    }

    @Test
    public void theRegistrationPartRoundTrip() throws Exception {
        byte[] key = AccountKeys.profileKey(Crypto.random(32));
        JSONObject record = Registration.record(new JSONObject().put("firstName", "Zoë").put("lastName", "O’Neil").put("country", "IE")
            .put("phone", "+353851234567").put("email", "zoe@example.ie"), 1760000000000L);
        String a = AccountKeys.sealProfile(record, key), b = AccountKeys.sealProfile(record, key);
        assertFalse(a.equals(b));   // a fresh IV each time
        JSONObject back = AccountKeys.openProfile(a, key);
        assertSameJson(record, back);
        assertSameJson(record, AccountKeys.openProfile(b, key));
        // Tampered, cut short or not base64: an error, never a guess.
        byte[] raw = Crypto.unb64(a);
        raw[raw.length - 1] ^= 1;
        try { AccountKeys.openProfile(Crypto.b64(raw), key); fail(); } catch (GeneralSecurityException expected) { }
        try { AccountKeys.openProfile(Crypto.b64(new byte[20]), key); fail(); } catch (GeneralSecurityException expected) { }
        try { AccountKeys.openProfile("***", key); fail(); } catch (GeneralSecurityException expected) { }
        // Sealed JSON that is not an object.
        byte[] iv = Crypto.random(12);
        String notObject = Crypto.b64(Crypto.concat(iv, Crypto.gcmSeal(key, iv, Crypto.utf8("[1,2]"), null)));
        try { AccountKeys.openProfile(notObject, key); fail(); } catch (GeneralSecurityException expected) { }
    }
}
