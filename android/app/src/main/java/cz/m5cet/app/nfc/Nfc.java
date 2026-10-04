package cz.m5cet.app.nfc;

import android.app.Activity;
import android.content.Context;
import android.nfc.FormatException;
import android.nfc.NdefMessage;
import android.nfc.NdefRecord;
import android.nfc.NfcAdapter;
import android.nfc.Tag;
import android.nfc.tech.Ndef;
import android.nfc.tech.NdefFormatable;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.Base64;

import javax.crypto.Cipher;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;

import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;

/**
 * NFC (6.1): a room's connection card, compatible with the web client
 * (client/src/lib/nfc.ts, nfc/cards/connection-card.ts) —
 *  - the card is an NDEF record of type application/vnd.m5cet.conn whose
 *    payload is "m5cet:nfc:v1:" + base64(salt 16 ‖ iv 12 ‖ AES-GCM) of
 *    {v: 1, room, passphrase, name?, app?}, the key PBKDF2-SHA256 of a PIN
 *    (4–16 digits, 200 000 rounds), no AAD; an older form is a text record
 *    with the same string;
 *  - read: any NDEF tag (its records are listed), a card is opened with the
 *    PIN and offered for joining;
 *  - write: the active room onto a tag (NTAG215/216 — ~250 bytes);
 *  - emulate: the phone answers as a Type 4 tag with that card
 *    (CardService), so another phone reads it.
 * The tag's own identity is shown as the phone sees it; nothing else of a
 * tag is read than its NDEF content.
 */
public final class Nfc {
    public interface Listener { void onNfc(JSONObject state); }

    public static final String MIME = "application/vnd.m5cet.conn";
    static final String PREFIX = "m5cet:nfc:v1:";
    static final int ROUNDS = 200_000;
    private static final SecureRandom RNG = new SecureRandom();

    private final Activity activity;
    private final Listener listener;
    private String mode = "idle";
    private String pin = "";
    private JSONObject card;
    private JSONObject last;
    private String message = "";

    public Nfc(Activity a, Listener l) { this.activity = a; this.listener = l; }

    public static boolean available(Context c) { return NfcAdapter.getDefaultAdapter(c) != null; }

    public boolean enabled() { NfcAdapter n = NfcAdapter.getDefaultAdapter(activity); return n != null && n.isEnabled(); }

    public JSONObject state() {
        JSONObject o = new JSONObject();
        try {
            o.put("available", available(activity)).put("enabled", enabled()).put("state", mode).put("message", message)
                .put("last", last == null ? JSONObject.NULL : last).put("emulating", "emulate".equals(mode));
        } catch (JSONException ignored) { }
        return o;
    }

    private void emit() { JSONObject s = state(); Io.main(() -> listener.onNfc(s)); }

    public static boolean validPin(String p) { return p != null && p.matches("^[0-9]{4,16}$"); }

    /* ------------------------------------------------------------ modes */

    /** Waits for a tag to read (pin opens a card on it; may be empty — then the records are only listed). */
    public void read(String pin) { start("read", pin, null); }

    /** Waits for a tag to write the card to (the card: {room, passphrase, name}). */
    public void write(String pin, JSONObject card) { start("write", pin, card); }

    /** Answers as a tag with the card until stop(). */
    public void emulate(String pin, JSONObject card) {
        stopReader();
        try {
            CardService.serve(message(seal(card, pin)));
            mode = "emulate";
            message = "";
        } catch (Exception e) {
            mode = "idle";
            message = e.getMessage();
        }
        emit();
    }

    public void stop() {
        stopReader();
        CardService.serve(null);
        mode = "idle";
        emit();
    }

    private void start(String m, String p, JSONObject c) {
        CardService.serve(null);
        mode = m;
        pin = p == null ? "" : p;
        card = c;
        message = "";
        NfcAdapter n = NfcAdapter.getDefaultAdapter(activity);
        if (n == null) { mode = "idle"; message = "unavailable"; emit(); return; }
        int flags = NfcAdapter.FLAG_READER_NFC_A | NfcAdapter.FLAG_READER_NFC_B | NfcAdapter.FLAG_READER_NFC_F | NfcAdapter.FLAG_READER_NFC_V;
        // 6.6: through ReaderMode, so a model's read can borrow it and hand it back.
        ReaderMode.enable(activity, this, this::onTag, flags, null);
        emit();
    }

    private void stopReader() { ReaderMode.release(activity, this); }

    /** On the NFC thread: read or write, then back to idle. */
    private void onTag(Tag tag) {
        try {
            if ("write".equals(mode)) writeTo(tag);
            else last = readFrom(tag);
        } catch (Exception e) {
            Log.w("nfc", mode + ": " + e.getMessage());
            message = e.getMessage() == null ? "error" : e.getMessage();
        }
        mode = "idle";
        Io.main(this::stopReader);
        emit();
    }

    /* ------------------------------------------------------------ read */

    private JSONObject readFrom(Tag tag) throws IOException, FormatException, JSONException {
        JSONObject out = new JSONObject();
        JSONArray techs = new JSONArray();
        for (String t : tag.getTechList()) techs.put(t.substring(t.lastIndexOf('.') + 1));
        out.put("tech", techs).put("id", hex(tag.getId()));
        Ndef ndef = Ndef.get(tag);
        if (ndef == null) { out.put("ndef", false); return out; }
        ndef.connect();
        try {
            out.put("ndef", true).put("type", ndef.getType()).put("capacity", ndef.getMaxSize()).put("writable", ndef.isWritable());
            NdefMessage msg = ndef.getNdefMessage();
            JSONArray records = new JSONArray();
            String blob = null;
            if (msg != null) for (NdefRecord r : msg.getRecords()) {
                JSONObject rec = describe(r);
                records.put(rec);
                String s = rec.optString("text", "");
                if (MIME.equals(rec.optString("mime")) || s.startsWith(PREFIX)) blob = rec.optString("mime").equals(MIME) ? new String(r.getPayload(), StandardCharsets.UTF_8) : s;
            }
            out.put("records", records);
            if (blob != null) {
                out.put("card", true);
                if (validPin(pin)) {
                    JSONObject opened = open(blob, pin);
                    if (opened == null) message = "wrong-pin";
                    else out.put("room", opened);
                }
            }
        } finally {
            try { ndef.close(); } catch (IOException ignored) { }
        }
        return out;
    }

    static JSONObject describe(NdefRecord r) throws JSONException {
        JSONObject o = new JSONObject().put("tnf", r.getTnf());
        String type = new String(r.getType(), StandardCharsets.US_ASCII);
        if (r.getTnf() == NdefRecord.TNF_MIME_MEDIA) o.put("mime", type);
        else if (r.getTnf() == NdefRecord.TNF_WELL_KNOWN && type.equals("T")) {
            byte[] p = r.getPayload();
            int lang = p.length > 0 ? p[0] & 0x3f : 0;
            boolean utf16 = p.length > 0 && (p[0] & 0x80) != 0;
            o.put("kind", "text").put("text", new String(p, 1 + lang, Math.max(0, p.length - 1 - lang), utf16 ? StandardCharsets.UTF_16 : StandardCharsets.UTF_8));
        } else if (r.toUri() != null) o.put("kind", "uri").put("uri", r.toUri().toString());
        o.put("size", r.getPayload().length);
        return o;
    }

    /* ----------------------------------------------------------- write */

    private void writeTo(Tag tag) throws Exception {
        if (card == null || !validPin(pin)) throw new IOException("pin");
        NdefMessage msg = message(seal(card, pin));
        int need = msg.getByteArrayLength();
        Ndef ndef = Ndef.get(tag);
        if (ndef != null) {
            ndef.connect();
            try {
                if (!ndef.isWritable()) throw new IOException("read-only");
                if (ndef.getMaxSize() < need) throw new IOException("too-small");
                ndef.writeNdefMessage(msg);
            } finally { try { ndef.close(); } catch (IOException ignored) { } }
        } else {
            NdefFormatable f = NdefFormatable.get(tag);
            if (f == null) throw new IOException("not-ndef");
            f.connect();
            try { f.format(msg); } finally { try { f.close(); } catch (IOException ignored) { } }
        }
        message = "written";
    }

    public static NdefMessage message(String blob) {
        return new NdefMessage(new NdefRecord[]{NdefRecord.createMime(MIME, blob.getBytes(StandardCharsets.UTF_8))});
    }

    /* ---------------------------------------------------------- crypto */

    /** {v:1, room, passphrase, name?, app?} sealed with the PIN (nfc.ts sealWithPin). */
    public static String seal(JSONObject card, String pin) throws GeneralSecurityException {
        if (!validPin(pin)) throw new GeneralSecurityException("pin");
        byte[] salt = new byte[16], iv = new byte[12];
        RNG.nextBytes(salt);
        RNG.nextBytes(iv);
        byte[] key = key(pin, salt);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
        byte[] ct = c.doFinal(card.toString().getBytes(StandardCharsets.UTF_8));
        byte[] all = new byte[16 + 12 + ct.length];
        System.arraycopy(salt, 0, all, 0, 16);
        System.arraycopy(iv, 0, all, 16, 12);
        System.arraycopy(ct, 0, all, 28, ct.length);
        return PREFIX + Base64.getEncoder().encodeToString(all);
    }

    /** The card, or null when the PIN is wrong or it is not one. */
    public static JSONObject open(String blob, String pin) {
        try {
            if (blob == null || !blob.startsWith(PREFIX)) return null;
            byte[] all = Base64.getDecoder().decode(blob.substring(PREFIX.length()).trim());
            if (all.length < 29) return null;
            byte[] salt = java.util.Arrays.copyOfRange(all, 0, 16), iv = java.util.Arrays.copyOfRange(all, 16, 28);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key(pin, salt), "AES"), new GCMParameterSpec(128, iv));
            JSONObject o = new JSONObject(new String(c.doFinal(java.util.Arrays.copyOfRange(all, 28, all.length)), StandardCharsets.UTF_8));
            if (!(o.opt("room") instanceof String) || !(o.opt("passphrase") instanceof String)) return null;
            return o;
        } catch (Exception e) {
            return null;
        }
    }

    static byte[] key(String pin, byte[] salt) throws GeneralSecurityException {
        PBEKeySpec spec = new PBEKeySpec(pin.toCharArray(), salt, ROUNDS, 256);
        try { return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded(); }
        finally { spec.clearPassword(); }
    }

    static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02X", x));
        return s.toString();
    }
}
