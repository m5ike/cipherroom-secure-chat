package cz.m5cet.app.nfc;

import android.nfc.NdefMessage;
import android.nfc.NdefRecord;
import android.nfc.cardemulation.HostApduService;
import android.os.Bundle;

import java.util.Arrays;

/**
 * The phone as an NFC Forum Type 4 tag (6.1, extended 6.3) carrying one of the
 * app's own cards — only while the user has it on (NFC › Be a card) and only
 * the NDEF application (AID D2760000850101): SELECT the application, SELECT the
 * capability container (E103) or the NDEF file (E104), READ BINARY. Nothing is
 * writable; with no card set it answers "not found".
 *
 * 6.3: besides the room connection tag (a MIME record), it can hold an M5Cet
 * card — the encrypted container in an NDEF external record m5cet.cz:card — so
 * another phone (or the web workbench) reads it off the emulated tag.
 */
public final class CardService extends HostApduService {
    private static final byte[] AID = {(byte) 0xD2, 0x76, 0x00, 0x00, (byte) 0x85, 0x01, 0x01};
    private static final byte[] OK = {(byte) 0x90, 0x00}, NOT_FOUND = {0x6A, (byte) 0x82}, WRONG = {0x6D, 0x00}, BAD_P = {0x6B, 0x00};

    private static volatile byte[] ndefFile;

    /** The card to serve (null = none): the NDEF file is NLEN (2 bytes) + the message. */
    static void serve(NdefMessage msg) {
        if (msg == null) { ndefFile = null; return; }
        byte[] m = msg.toByteArray();
        byte[] f = new byte[m.length + 2];
        f[0] = (byte) (m.length >> 8);
        f[1] = (byte) m.length;
        System.arraycopy(m, 0, f, 2, m.length);
        ndefFile = f;
    }

    /** 6.3: answer as a Type 4 tag holding an M5Cet card (the container in an external record). */
    public static void serveM5Card(byte[] container) {
        serve(new NdefMessage(new NdefRecord[]{NdefRecord.createExternal("m5cet.cz", "card", container)}));
    }

    /** 6.3: answer as the room connection tag (its MIME record); see {@link Nfc#message}. */
    public static void serveConnection(NdefMessage connection) { serve(connection); }

    /** Stop emulating (answer "not found"). */
    public static void stopServing() { serve(null); }

    /** Whether the phone is answering as a card now. */
    public static boolean serving() { return ndefFile != null; }

    private byte[] selected;

    /** Mapping 2.0 capability container: MLe/MLc, the NDEF file E104 of its size, read only. */
    private static byte[] cc(int size) {
        return new byte[]{0x00, 0x0F, 0x20, 0x00, 0x3B, 0x00, 0x34, 0x04, 0x06, (byte) 0xE1, 0x04, (byte) (size >> 8), (byte) size, 0x00, (byte) 0xFF};
    }

    @Override
    public byte[] processCommandApdu(byte[] apdu, Bundle extras) {
        byte[] file = ndefFile;
        if (file == null || apdu == null || apdu.length < 4) return NOT_FOUND;
        int ins = apdu[1] & 0xff, p1 = apdu[2] & 0xff, p2 = apdu[3] & 0xff;
        if (ins == 0xA4) { // SELECT
            int lc = apdu.length > 4 ? apdu[4] & 0xff : 0;
            byte[] data = apdu.length >= 5 + lc ? Arrays.copyOfRange(apdu, 5, 5 + lc) : new byte[0];
            if (p1 == 0x04 && Arrays.equals(data, AID)) { selected = null; return OK; }
            if (p1 == 0x00 && data.length == 2 && data[0] == (byte) 0xE1 && data[1] == 0x03) { selected = cc(file.length); return OK; }
            if (p1 == 0x00 && data.length == 2 && data[0] == (byte) 0xE1 && data[1] == 0x04) { selected = file; return OK; }
            return NOT_FOUND;
        }
        if (ins == 0xB0) { // READ BINARY
            byte[] f = selected;
            if (f == null) return NOT_FOUND;
            int offset = (p1 << 8) | p2;
            int le = apdu.length > 4 ? (apdu[apdu.length - 1] & 0xff) : 0;
            if (le == 0) le = 256;
            if (offset > f.length) return BAD_P;
            int n = Math.min(le, f.length - offset);
            byte[] out = new byte[n + 2];
            System.arraycopy(f, offset, out, 0, n);
            out[n] = (byte) 0x90;
            out[n + 1] = 0x00;
            return out;
        }
        return WRONG;
    }

    @Override public void onDeactivated(int reason) { selected = null; }
}
