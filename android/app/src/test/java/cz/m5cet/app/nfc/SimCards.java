package cz.m5cet.app.nfc;

import static cz.m5cet.app.nfc.Tlvs.T;
import static cz.m5cet.app.nfc.Tlvs.ascii;
import static cz.m5cet.app.nfc.Tlvs.ok;
import static cz.m5cet.app.nfc.Tlvs.sw;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Simulated cards for the 6.10 template runner (TemplateRunnerTest): an EMV
 * card with any applications (PPSE and / or the contact PSE, counters, the
 * transaction log, GPO with its PDOL checked, the AFL's records and a file only
 * a deep read finds), a MIFARE DESFire EV1 and a plain ISO 7816-4 card that
 * answers with 61xx and 6Cxx. Each logs every command it gets and fails the
 * read on anything that is not one (VERIFY, GENERATE AC, a write). The e-ID
 * chip is MrtdDeepTest.Chip.
 */
final class SimCards {
    private SimCards() {}

    /** A card that logs what it gets; a forbidden command throws. */
    abstract static class Card implements Apdu.Transceiver {
        final List<String> seen = new ArrayList<>();
        final List<String> forbidden = new ArrayList<>();
        /** After this many commands the card leaves the field (-1: never). */
        int leaveAfter = -1;

        @Override public final byte[] transmit(byte[] cmd) throws IOException {
            if (leaveAfter >= 0 && seen.size() >= leaveAfter) throw new IOException("Tag was lost.");
            String h = Apdu.hex(cmd);
            seen.add(h);
            int cla = cmd[0] & 0xff, ins = cmd[1] & 0xff;
            if (ins == 0x20 || (cla == 0x80 && ins == 0xae) || ins == 0xd6 || ins == 0xdc || ins == 0xe2) {
                forbidden.add(h);
                throw new IOException("the reader must only read");
            }
            return answer(cmd);
        }

        abstract byte[] answer(byte[] cmd);

        static byte[] dataOf(byte[] cmd) { return cmd.length > 5 ? Apdu.slice(cmd, 5, 5 + (cmd[4] & 0xff)) : new byte[0]; }
    }

    /* ------------------------------------------------------------ EMV */

    static final byte[] LOG_FORMAT = Apdu.unhex("9A039F21039F02065F2A029F1A029C019F4E089F3602");
    static final byte[] PDOL = Apdu.unhex("9F66049F02069F37045F2A02");

    static byte[] logRecord(String date, String time, String amount, String merchant, int atc) {
        StringBuilder m = new StringBuilder(merchant);
        while (m.length() < 8) m.append(' ');
        return Apdu.concat(Apdu.unhex(date), Apdu.unhex(time), Apdu.unhex(amount), Apdu.unhex("0203"), Apdu.unhex("0203"), Apdu.unhex("00"),
            ascii(m.substring(0, 8)), Apdu.u8(atc >> 8, atc & 0xff));
    }

    static final Map<String, String> PANS = new HashMap<>();
    static final Map<String, String> LABELS = new HashMap<>();
    static {
        PANS.put("A0000000031010", "4111111111111111"); LABELS.put("A0000000031010", "VISA CREDIT");
        PANS.put("A0000000041010", "5413330089020011"); LABELS.put("A0000000041010", "MASTERCARD");
    }

    /** An EMV card: the applications it has, whether it answers the contactless (PPSE) and the contact (PSE) directory. */
    static final class Emv extends Card {
        final List<String> aids;
        final boolean ppse, pse;
        private String selected;

        Emv(boolean ppse, boolean pse, String... aids) { this.ppse = ppse; this.pse = pse; this.aids = Arrays.asList(aids); }

        String pan(String aid) { String p = PANS.get(aid); return p != null ? p : "6011000990139424"; }
        String label(String aid) { String l = LABELS.get(aid); return l != null ? l : "CARD " + aid.substring(aid.length() - 4); }

        private byte[] fci(String aid) {
            return T(0x6f, T(0x84, Apdu.unhex(aid)), T(0xa5, T(0x50, ascii(label(aid))), T(0x87, Apdu.u8(1)), T(0x9f38, PDOL)));
        }

        private Map<String, byte[]> files(String aid) {
            Map<String, byte[]> f = new LinkedHashMap<>();
            // The holder record: the PAN, Track 2 (57), Track 1 in ASCII (56) and its discretionary data (9F1F).
            f.put("1:1", T(0x70, T(0x5a, Apdu.unhex(pan(aid))), T(0x5f24, Apdu.unhex("281231")), T(0x5f20, ascii("NOVAK/JAN")), T(0x5f28, Apdu.unhex("0203")),
                T(0x57, Apdu.unhex(pan(aid) + "D28122011234567890")), T(0x56, ascii("B" + pan(aid) + "^NOVAK/JAN^2812201123456789")), T(0x9f1f, ascii("1234567890"))));
            f.put("2:1", T(0x70, T(0x8c, Apdu.unhex("9F02069F03069F1A02")), T(0x8e, Apdu.unhex("000000000000000042031E031F03"))));
            // Not in the AFL — only a deep read finds it.
            f.put("3:1", T(0x70, T(0x9f08, Apdu.unhex("0002")), T(0x5f30, Apdu.unhex("0201"))));
            return f;
        }

        private static final byte[][] LOG = {
            logRecord("250914", "183005", "000000012345", "BILLA", 41),
            logRecord("250912", "091500", "000000000990", "DPP", 40),
        };

        @Override byte[] answer(byte[] cmd) {
            int cla = cmd[0] & 0xff, ins = cmd[1] & 0xff, p1 = cmd[2] & 0xff, p2 = cmd[3] & 0xff;
            if (ins == 0xa4 && p1 == 0x04) {
                String name = Apdu.hex(dataOf(cmd));
                if (name.equals(Apdu.hex(ascii("2PAY.SYS.DDF01")))) {
                    if (!ppse) return sw(0x6a82);
                    selected = "PPSE";
                    List<byte[]> entries = new ArrayList<>();
                    for (int i = 0; i < aids.size(); i++) entries.add(T(0x61, T(0x4f, Apdu.unhex(aids.get(i))), T(0x50, ascii(label(aids.get(i)))), T(0x87, Apdu.u8(i + 1))));
                    return ok(T(0x6f, T(0x84, ascii("2PAY.SYS.DDF01")), T(0xa5, T(0xbf0c, entries.toArray(new byte[0][])))));
                }
                if (name.equals(Apdu.hex(ascii("1PAY.SYS.DDF01")))) {
                    if (!pse) return sw(0x6a82);
                    selected = "PSE";
                    return ok(T(0x6f, T(0x84, ascii("1PAY.SYS.DDF01")), T(0xa5, T(0x88, Apdu.u8(1)), T(0x5f2d, ascii("encs")))));
                }
                if (aids.contains(name)) { selected = name; return ok(fci(name)); }
                return sw(0x6a82);
            }
            if (cla == 0x80 && ins == 0xca) {
                if (selected == null || selected.endsWith("PSE")) return sw(0x6985);
                String tag = String.format("%04X", (p1 << 8) | p2);
                switch (tag) {
                    case "9F36": return ok(T(0x9f36, Apdu.u8(0x00, 0x2a)));
                    case "9F13": return ok(T(0x9f13, Apdu.u8(0x00, 0x28)));
                    case "9F17": return ok(T(0x9f17, Apdu.u8(0x03)));
                    case "9F4D": return ok(T(0x9f4d, Apdu.u8(0x0b, 0x02)));
                    case "9F4F": return ok(T(0x9f4f, LOG_FORMAT));
                    default: return sw(0x6a88);
                }
            }
            if (cla == 0x80 && ins == 0xa8) {
                if (selected == null || selected.endsWith("PSE")) return sw(0x6985);
                byte[] d = dataOf(cmd);
                // The PDOL filled: tag 83, then 4 + 6 + 4 + 2 bytes.
                if (d.length != 18 || (d[0] & 0xff) != 0x83 || (d[1] & 0xff) != 16) return sw(0x6700);
                return ok(T(0x77, T(0x82, Apdu.unhex("1980")), T(0x94, Apdu.unhex("0801010010010100"))));
            }
            if (ins == 0xb2) {
                int sfi = p2 >> 3;
                if ("PSE".equals(selected)) {
                    if (sfi != 1 || p1 > aids.size()) return sw(0x6a83);
                    String aid = aids.get(p1 - 1);
                    return ok(T(0x70, T(0x61, T(0x4f, Apdu.unhex(aid)), T(0x50, ascii(label(aid))), T(0x87, Apdu.u8(p1)))));
                }
                if (selected == null || "PPSE".equals(selected)) return sw(0x6a82);
                if (sfi == 0x0b) return p1 <= LOG.length ? ok(LOG[p1 - 1]) : sw(0x6a83);
                Map<String, byte[]> files = files(selected);
                byte[] f = files.get(sfi + ":" + p1);
                if (f != null) return ok(f);
                for (String k : files.keySet()) if (k.startsWith(sfi + ":")) return sw(0x6a83);
                return sw(0x6a82);
            }
            return sw(0x6d00);
        }
    }

    /* ------------------------------------------------------------ DESFire */

    /** A MIFARE DESFire EV1 8K: GetVersion in three frames, two applications, 4 KB free, the PICC's key settings. */
    static final class Desfire extends Card {
        private int frame;

        @Override byte[] answer(byte[] cmd) {
            String h = Apdu.hex(cmd);
            switch (h) {
                case "9060000000": frame = 1; return Apdu.concat(Apdu.unhex("04010101001A05"), sw(0x91af));
                case "90AF000000":
                    if (frame == 1) { frame = 2; return Apdu.concat(Apdu.unhex("04010101041A05"), sw(0x91af)); }
                    if (frame == 2) { frame = 0; return Apdu.concat(Apdu.unhex("04112233445566BA7C1234561219"), sw(0x9100)); }
                    return sw(0x911c);
                case "906A000000": return Apdu.concat(Apdu.unhex("5634120D0C0B"), sw(0x9100));
                case "906E000000": return Apdu.concat(Apdu.unhex("001000"), sw(0x9100));
                case "9045000000": return Apdu.concat(Apdu.unhex("0F81"), sw(0x9100));
                default: return sw(0x911c);
            }
        }
    }

    /* ------------------------------------------------------------ ISO 7816-4 */

    static final byte[] DIR1 = T(0x61, T(0x4f, Apdu.unhex("A0000002471001")), T(0x50, ascii("ICAO eMRTD")));
    static final byte[] DIR2 = T(0x61, T(0x4f, Apdu.unhex("A0000000041010")), T(0x50, ascii("MASTERCARD")), T(0x51, Apdu.unhex("3F00")));
    static final byte[] ATR = Apdu.concat(T(0x43, Apdu.u8(0xf0)), T(0x47, Apdu.u8(0x94, 0x81, 0xc1)));

    /** A plain ISO 7816-4 card: MF, EF.DIR with two records (the first one through GET RESPONSE), EF.ATR answering 6Cxx first. */
    static final class Iso extends Card {
        private int current = -1;
        private byte[] pending;

        @Override byte[] answer(byte[] cmd) {
            int ins = cmd[1] & 0xff, p1 = cmd[2] & 0xff, p2 = cmd[3] & 0xff;
            if (ins == 0xa4) {
                byte[] d = dataOf(cmd);
                int fid = d.length == 2 ? ((d[0] & 0xff) << 8) | (d[1] & 0xff) : -1;
                if (fid == 0x3f00 || fid == 0x2f00 || fid == 0x2f01) { current = fid; return sw(0x9000); }
                return sw(0x6a82);
            }
            if (ins == 0xb2) {
                if (current != 0x2f00) return sw(0x6986);
                if (p1 == 1) { pending = DIR1; return sw(0x6100 | DIR1.length); }
                if (p1 == 2) return ok(DIR2);
                return sw(0x6a83);
            }
            if (ins == 0xc0) {
                if (pending == null) return sw(0x6985);
                byte[] out = pending;
                pending = null;
                return ok(out);
            }
            if (ins == 0xb0) {
                if (current != 0x2f01) return sw(0x6986);
                int le = cmd.length == 5 ? cmd[4] & 0xff : -1;
                if (le != ATR.length) return sw(0x6c00 | ATR.length);
                return ok(ATR);
            }
            return sw(0x6d00);
        }
    }
}
