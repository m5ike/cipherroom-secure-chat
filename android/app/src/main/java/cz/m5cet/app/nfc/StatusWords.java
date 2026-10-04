package cz.m5cet.app.nfc;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * What a status word means (6.10) — the Java port of client/src/lib/nfc/cards/apdu.ts
 * describeSw (ISO 7816-4 and the common proprietary codes, DESFire's 91xx), word
 * for word, so a template run's "← … (meaning)" lines read the same on the web
 * and on the phone. Pure.
 */
public final class StatusWords {
    private StatusWords() {}

    private static final Map<Integer, String> TABLE = new HashMap<>();
    private static final Map<Integer, String> DESFIRE = new HashMap<>();
    static {
        Object[] t = {
            0x6200, "Warning: no information", 0x6281, "Part of returned data may be corrupted", 0x6283, "Selected file invalidated",
            0x6300, "Authentication failed", 0x6581, "Memory failure", 0x6700, "Wrong length", 0x6800, "Functions in CLA not supported",
            0x6881, "Logical channel not supported", 0x6882, "Secure messaging not supported", 0x6900, "Command not allowed",
            0x6981, "Command incompatible with file structure", 0x6982, "Security status not satisfied", 0x6983, "Authentication method blocked",
            0x6984, "Referenced data invalidated", 0x6985, "Conditions of use not satisfied", 0x6986, "Command not allowed (no current EF)",
            0x6987, "Expected secure messaging data objects missing", 0x6988, "Secure messaging data objects incorrect",
            0x6a80, "Incorrect parameters in data field", 0x6a81, "Function not supported", 0x6a82, "File or application not found",
            0x6a83, "Record not found", 0x6a84, "Not enough memory space", 0x6a86, "Incorrect P1/P2", 0x6a87, "Lc inconsistent with P1/P2",
            0x6a88, "Referenced data not found", 0x6b00, "Wrong parameters P1/P2", 0x6d00, "Instruction not supported", 0x6e00, "Class not supported",
            0x6f00, "No precise diagnosis / card mute",
        };
        for (int i = 0; i < t.length; i += 2) TABLE.put((Integer) t[i], (String) t[i + 1]);
        Object[] d = {
            0x00, " (OPERATION_OK)", 0x0c, " (NO_CHANGES)", 0x0e, " (OUT_OF_EEPROM)", 0x1c, " (ILLEGAL_COMMAND)", 0x1e, " (INTEGRITY_ERROR)",
            0x40, " (NO_SUCH_KEY)", 0x7e, " (LENGTH_ERROR)", 0x9d, " (PERMISSION_DENIED)", 0x9e, " (PARAMETER_ERROR)", 0xa0, " (APPLICATION_NOT_FOUND)",
            0xae, " (AUTHENTICATION_ERROR)", 0xaf, " (ADDITIONAL_FRAME)", 0xbe, " (BOUNDARY_ERROR)", 0xca, " (COMMAND_ABORTED)", 0xf0, " (FILE_NOT_FOUND)",
        };
        for (int i = 0; i < d.length; i += 2) DESFIRE.put((Integer) d[i], (String) d[i + 1]);
    }

    /** "9000", "6A82" (upper hex, four digits). */
    public static String hex(int sw) { return String.format(Locale.ROOT, "%04X", sw & 0xffff); }

    /** A status word in hex ("6A82") → its value, -1 when it is not one. */
    public static int parse(String hex) {
        if (hex == null || !hex.matches("[0-9A-Fa-f]{4}")) return -1;
        return Integer.parseInt(hex, 16);
    }

    /** Human-readable status word (apdu.ts describeSw). */
    public static String describe(int sw) {
        int sw1 = (sw >> 8) & 0xff, sw2 = sw & 0xff;
        if (sw == 0x9000) return "OK";
        if (sw1 == 0x61) return "OK, " + sw2 + " more byte(s) available (GET RESPONSE)";
        if (sw1 == 0x6c) return "Wrong Le, retry with Le=" + sw2;
        if (sw1 == 0x63 && (sw2 & 0xf0) == 0xc0) return "Verification failed, " + (sw2 & 0x0f) + " retries left";
        if (sw1 == 0x62 && sw2 == 0x82) return "End of file reached before Le";
        if (sw1 == 0x63 && sw2 == 0x00) return "Verification failed / no info";
        if (sw1 == 0x91) { String m = DESFIRE.get(sw2); return "DESFire status " + String.format(Locale.ROOT, "%02x", sw2) + (m == null ? "" : m); }
        String m = TABLE.get(sw);
        return m != null ? m : "Unknown status " + hex(sw);
    }

    /** The meaning of a recorded status word ("" = the card gave no answer). */
    public static String describe(String hex) {
        int sw = parse(hex);
        return sw < 0 ? "no answer" : describe(sw);
    }
}
