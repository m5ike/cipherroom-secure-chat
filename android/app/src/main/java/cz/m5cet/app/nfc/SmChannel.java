package cz.m5cet.app.nfc;

import java.io.IOException;

/**
 * A secure-messaging channel (6.6) — what BAC and PACE both give the MRTD reader
 * once the holder's document is open: send a plain APDU, get the plain answer
 * back. BAC wraps with 3DES + retail MAC ({@link Bac}); PACE with AES + CMAC or
 * 3DES ({@link Pace}). The reader ({@link MrtdReader}) never cares which. The
 * Java port of client/src/lib/nfc/cards/sm.ts.
 */
public interface SmChannel {
    /** One plain answer: the data and the status word. */
    final class Reply {
        public final byte[] data;
        public final int sw;
        public Reply(byte[] data, int sw) { this.data = data; this.sw = sw; }
    }

    /** How the document was opened: "bac" or "pace". */
    String kind();

    /** One exchange: protect → transmit → unprotect. */
    Reply send(byte[] cmd) throws IOException;

    /** The channel a BAC session gives (3DES secure messaging, ICAO 9303-11 §9.8). */
    static SmChannel bac(Apdu.Transceiver t, Bac.Session s) {
        return new SmChannel() {
            @Override public String kind() { return "bac"; }
            @Override public Reply send(byte[] cmd) throws IOException {
                try {
                    Bac.Sm r = Bac.unprotectResponse(s, t.transmit(Bac.protectApdu(s, cmd)));
                    return new Reply(r.data, r.sw);
                } catch (RuntimeException e) { // a MAC that does not verify, a malformed answer
                    throw new IOException(e.getMessage() != null ? e.getMessage() : "secure messaging failed", e);
                }
            }
        };
    }
}
