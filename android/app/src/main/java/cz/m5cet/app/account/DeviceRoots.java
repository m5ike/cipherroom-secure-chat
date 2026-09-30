package cz.m5cet.app.account;

import org.json.JSONException;
import org.json.JSONObject;

import java.security.GeneralSecurityException;

import cz.m5cet.app.security.Crypto;
import cz.m5cet.app.security.Vault;

/**
 * Account roots made on this phone (6.2). When the passkey provider gives no
 * PRF at all (e.g. Samsung Pass), sign-up registers 32 random bytes as the
 * account root instead: the server gets only the key proof, as always, and
 * the account opens here — elsewhere once a recovery code or a PRF passkey
 * carries the root sealed for it.
 *
 * Kept in the vault's user tier by server and account id, apart from the
 * signed-in state: signing out keeps them (the next sign-in with that passkey
 * needs the root again); only a wipe removes them. A root is stored before
 * the server is asked to register the account (a lost answer must not lose
 * it) and marked confirmed once the server accepted it.
 */
final class DeviceRoots {
    static final String RECORD = "account-roots";

    static final class Entry {
        final byte[] root;
        final boolean confirmed;
        Entry(byte[] root, boolean confirmed) { this.root = root; this.confirmed = confirmed; }
    }

    private final Vault vault;

    DeviceRoots(Vault vault) { this.vault = vault; }

    private static String key(String server, String accountId) { return server + "|" + accountId; }

    private JSONObject all() throws GeneralSecurityException {
        byte[] b = vault.get(Vault.Tier.USER, RECORD);
        try { return b == null ? new JSONObject() : new JSONObject(Crypto.str(b)); }
        catch (JSONException e) { throw new GeneralSecurityException("the device roots are unreadable"); }
        finally { Crypto.wipe(b); }
    }

    private void write(JSONObject all) throws GeneralSecurityException {
        byte[] b = Crypto.utf8(all.toString());
        try { vault.put(Vault.Tier.USER, RECORD, b); } finally { Crypto.wipe(b); }
    }

    /** The root kept for this account, or null (also while the vault is locked). */
    synchronized Entry get(String server, String accountId) {
        if (accountId == null || accountId.isEmpty() || !vault.unlocked()) return null;
        try {
            JSONObject e = all().optJSONObject(key(server, accountId));
            String root = e == null ? "" : e.optString("root");
            return root.isEmpty() ? null : new Entry(Crypto.unb64(root), e.optBoolean("confirmed"));
        } catch (GeneralSecurityException | IllegalArgumentException e) {
            return null;
        }
    }

    synchronized boolean has(String server, String accountId) {
        Entry e = get(server, accountId);
        if (e == null) return false;
        Crypto.wipe(e.root);
        return true;
    }

    /** Keeps a root; throws when it could not be written (the caller must not go on then). */
    synchronized void put(String server, String accountId, byte[] root, String credentialId, boolean confirmed) throws GeneralSecurityException {
        JSONObject all = all();
        try {
            all.put(key(server, accountId), new JSONObject().put("root", Crypto.b64(root)).put("credential", credentialId)
                .put("confirmed", confirmed).put("at", System.currentTimeMillis()));
        } catch (JSONException e) { throw new GeneralSecurityException(e); }
        write(all);
    }

    /** The server accepted it: under the account id it answered (normally the same as asked). */
    synchronized void confirm(String server, String pendingId, String accountId) throws GeneralSecurityException {
        JSONObject all = all();
        JSONObject e = all.optJSONObject(key(server, pendingId));
        if (e == null) return;
        try {
            e.put("confirmed", true);
            all.remove(key(server, pendingId));
            all.put(key(server, accountId), e);
        } catch (JSONException x) { throw new GeneralSecurityException(x); }
        write(all);
    }

    synchronized void remove(String server, String accountId) {
        try {
            JSONObject all = all();
            if (all.remove(key(server, accountId)) != null) write(all);
        } catch (GeneralSecurityException ignored) { }
    }
}
