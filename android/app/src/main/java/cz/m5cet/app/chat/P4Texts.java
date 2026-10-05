package cz.m5cet.app.chat;

import java.util.HashMap;
import java.util.Map;

import cz.m5cet.app.M5;

/**
 * 6.12: the protocol-4 texts — from the design (server/android/design-612*.ts,
 * cs / en / de), with these English words when the phone's published design
 * is older and does not have them yet.
 */
public final class P4Texts {
    private P4Texts() {}

    static final Map<String, String> EN = new HashMap<>();
    static {
        EN.put("p4.downgrade", "protocol downgrade refused — this device spoke protocol 4 before; its messages are not read");
        EN.put("p4.identityChanged", "identity changed — compare the safety number before you trust it");
        EN.put("p4.held", "identity changed — their messages are held until you verify them (People › Verify)");
        EN.put("p4.heldDropped", "{n} held messages were not shown (identity changed, not verified)");
        EN.put("p4.roomProof", "The server refused this device's proof that it holds the room key: another key is registered for this room on the server (someone may have claimed it first). Check the room name and passphrase with the others.");
        EN.put("p4.roomProofRequired", "This server admits only members who prove they hold the room key; this room cannot prove it (it is joined by its plain name).");
        EN.put("p4.trust.new", "new key — not verified");
        EN.put("p4.trust.verified", "verified");
        EN.put("p4.trust.account", "account key — not verified");
        EN.put("p4.trust.changed", "identity changed");
        EN.put("p4.legacy", "older protocol (no PCS / PQ)");
        EN.put("p4.protocol4", "protocol 4 (PQ + PCS)");
        EN.put("p4.unproven", "did not prove the room key to the server");
        EN.put("p4.kt.alert.inconsistent", "The server shows a rewritten key history (key transparency).");
        EN.put("p4.kt.alert.split-view", "The server shows different key histories to different people (key transparency).");
        EN.put("p4.kt.alert.key-changed", "The server's key-transparency key changed.");
        EN.put("p4.kt.ok", "in the key-transparency log");
        EN.put("p4.kt.revoked", "revoked in the key-transparency log");
        EN.put("p4.kt.missing", "not in the key-transparency log");
        EN.put("p4.kt.unverifiable", "the key-transparency log could not be checked");
        EN.put("p4.legacyShort", "older protocol");
        // 6.12 NFC connection tag v2 (protocol 4 § 16)
        EN.put("nfc.v2.kind.title", "How should the tag work?");
        EN.put("nfc.v2.kind.inv", "Invitation (recommended) — the room key stays on the server; the tag ends after 10 uses or 7 days");
        EN.put("nfc.v2.kind.off", "Offline — the room on the tag, opened with a code you give separately");
        EN.put("nfc.v2.preparing", "Preparing the tag…");
        EN.put("nfc.v2.code.title", "The tag's code");
        EN.put("nfc.v2.code.text", "Give this code to whoever may join — say it or write it down. It is not on the tag, nothing keeps it, and it is shown only now.");
        EN.put("nfc.v2.code.done", "I have it — write the tag");
        EN.put("nfc.v2.codeHint", "Code (new tags) or PIN (old tags)");
        EN.put("nfc.v2.invite", "Invitation tag");
        EN.put("nfc.v2.offline", "Offline tag");
        EN.put("nfc.v2.old", "Old connection tag (PIN)");
        EN.put("nfc.v2.weak", "Weak: anyone who has read this tag can guess its PIN offline. Rewrite it as a new tag.");
        EN.put("nfc.v2.rewrite", "Rewrite as a new tag");
        EN.put("nfc.v2.needCode", "Type the code you were given for this tag, then Open.");
        EN.put("nfc.v2.needPin", "Old tag: type its PIN, then Open.");
        EN.put("nfc.v2.needRedeem", "An invitation: Open asks the server (it uses one of the invitation's uses).");
        EN.put("nfc.v2.open", "Open");
        EN.put("nfc.v2.opening", "Opening the tag…");
        EN.put("nfc.v2.err.wrong-code", "Wrong code, or the tag was changed.");
        EN.put("nfc.v2.err.bad-code", "The code has 20 characters (letters and digits).");
        EN.put("nfc.v2.err.other-server", "This invitation is for another server ({origin}) — open M5cet there.");
        EN.put("nfc.v2.err.burned", "The invitation has been used up or ended.");
        EN.put("nfc.v2.err.not-found", "The invitation no longer exists (it expired or was ended).");
        EN.put("nfc.v2.err.network", "The server could not be reached.");
        EN.put("nfc.v2.err.bad-tag", "The tag is damaged or not a connection tag.");
        EN.put("nfc.v2.err.corrupt", "The invitation cannot be opened.");
        EN.put("p4.proven", "proved the room key");
    }

    public static String t(M5 app, String key) {
        String s = app == null ? key : app.t(key);
        if (s == null || s.equals(key)) { String en = EN.get(key); return en == null ? key : en; }
        return s;
    }
}
