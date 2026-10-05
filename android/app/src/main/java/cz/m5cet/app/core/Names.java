package cz.m5cet.app.core;

import java.text.Normalizer;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * 6.12 (security analysis F-22): display names as the app shows them, and
 * names made to look like another. A member chooses their own name, so a
 * name can carry bidi overrides ("Alice‮nimda"), invisible characters
 * ("Al​ice"), compatibility forms ("Ａｌｉｃｅ") or letters of another
 * script that look Latin ("Аlice" with a Cyrillic А).
 *
 *   normalize(name)   strip every control and format character (\p{Cc}, \p{Cf}:
 *                     bidi controls, zero-width, BOM, soft hyphen…), NFKC,
 *                     strip them again (NFKC can produce none, but cheap),
 *                     every run of white space → one space, trimmed, at most
 *                     48 code points (the web's PAYLOAD_LIMITS.nameChars)
 *   skeleton(name)    normalize, NFD, drop the non-spacing marks (é → e),
 *                     map the Cyrillic and Greek letters that look Latin
 *                     (the table below, both cases) and 0 → o, 1 → l, lower
 *                     case (Locale.ROOT), the table once more (а from А)
 *   mixedScript(name) a word (between spaces) with letters of two of Latin,
 *                     Cyrillic and Greek
 *   flags(people)     who is flagged among people shown together (a room's
 *                     members): a mixed-script name, or another person (another
 *                     identity) with the same skeleton — both are flagged
 *
 * The UI shows a flagged name with "⚠ " before it (the member list, a
 * bubble's sender). android/app/src/test/resources/cz/m5cet/app/names-vectors.json
 * holds the cases; the web (client/src/lib/names.ts) must give the same
 * answers for them.
 *
 * Operator notices (the server's "wall", "message", "pinned") never name
 * their sender from the frame: OPERATOR is shown instead (ui: notice.operator).
 */
public final class Names {
    private Names() {}

    /** The longest name shown, in code points (the web's nameChars). */
    public static final int MAX = 48;
    /** Before a flagged name. */
    public static final String FLAG = "⚠ ";

    /** Cyrillic and Greek letters that look like a Latin one (and two digits). Both cases where both look alike. */
    private static final Map<Integer, Integer> LOOKALIKE = new HashMap<>();
    private static void map(String from, String to) {
        for (int i = 0; i < from.length(); i++) LOOKALIKE.put((int) from.charAt(i), (int) to.charAt(i));
    }
    static {
        // Cyrillic capitals: А В Е К М Н О Р С Т Х У Ѕ І Ј Ԛ Ԝ Ү
        map("АВЕКМНОРСТХУЅІЈԚԜҮ",
            "ABEKMHOPCTXYSIJQWY");
        // Cyrillic small: а е о р с у х ѕ і ј ԛ ԝ һ ү ӏ к
        map("аеорсухѕіјԛԝһүӏк",
            "aeopcyxsijqwhylk");
        // Greek capitals: Α Β Ε Ζ Η Ι Κ Μ Ν Ο Ρ Τ Υ Χ
        map("ΑΒΕΖΗΙΚΜΝΟΡΤΥΧ",
            "ABEZHIKMNOPTYX");
        // Greek small: ο ν α ι κ ρ υ χ γ
        map("οναικρυχγ",
            "ovaikpuxy");
        // Latin look-alikes within Latin: dotless ı, and two digits
        map("ı" + "01", "iol");
    }

    private static boolean hidden(int c) {
        int t = Character.getType(c);
        return t == Character.CONTROL || t == Character.FORMAT;
    }

    private static String strip(String s) {
        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); ) {
            int c = s.codePointAt(i);
            i += Character.charCount(c);
            // Line breaks and tabs are controls too: they become spaces (collapsed below), not glue.
            if (c == '\n' || c == '\r' || c == '\t') sb.append(' ');
            else if (!hidden(c)) sb.appendCodePoint(c);
        }
        return sb.toString();
    }

    /** The name as shown: no control or format character, NFKC, one space between words, at most MAX code points. */
    public static String normalize(String raw) {
        if (raw == null || raw.isEmpty()) return "";
        String s = strip(Normalizer.normalize(strip(raw), Normalizer.Form.NFKC));
        StringBuilder sb = new StringBuilder(s.length());
        boolean space = false;
        for (int i = 0; i < s.length(); ) {
            int c = s.codePointAt(i);
            i += Character.charCount(c);
            if (Character.isWhitespace(c) || Character.isSpaceChar(c)) { space = sb.length() > 0; continue; }
            if (space) { sb.append(' '); space = false; }
            sb.appendCodePoint(c);
        }
        String out = sb.toString();
        if (out.codePointCount(0, out.length()) > MAX) out = out.substring(0, out.offsetByCodePoints(0, MAX)).trim();
        return out;
    }

    private static String lookalike(String s) {
        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); ) {
            int c = s.codePointAt(i);
            i += Character.charCount(c);
            Integer m = LOOKALIKE.get(c);
            sb.appendCodePoint(m == null ? c : m);
        }
        return sb.toString();
    }

    /** What two names that look alike share (see the class comment). */
    public static String skeleton(String name) {
        String s = Normalizer.normalize(normalize(name), Normalizer.Form.NFD);
        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); ) {
            int c = s.codePointAt(i);
            i += Character.charCount(c);
            if (Character.getType(c) != Character.NON_SPACING_MARK) sb.appendCodePoint(c);
        }
        return lookalike(lookalike(sb.toString()).toLowerCase(Locale.ROOT));
    }

    private static int script(int c) {
        if (!Character.isLetter(c)) return 0;
        Character.UnicodeScript s = Character.UnicodeScript.of(c);
        if (s == Character.UnicodeScript.LATIN) return 1;
        if (s == Character.UnicodeScript.CYRILLIC) return 2;
        if (s == Character.UnicodeScript.GREEK) return 4;
        return 0;
    }

    /** A word with letters of two (or three) of Latin, Cyrillic and Greek. */
    public static boolean mixedScript(String name) {
        String s = normalize(name);
        int word = 0;
        for (int i = 0; i < s.length(); ) {
            int c = s.codePointAt(i);
            i += Character.charCount(c);
            if (c == ' ') { word = 0; continue; }
            word |= script(c);
            if (Integer.bitCount(word) > 1) return true;
        }
        return false;
    }

    /**
     * Who is flagged among people shown together: each entry is {identity,
     * name} (identity: what tells two people apart — a device key, an
     * account, a connection's id). Flagged: a mixed-script name, or a
     * skeleton another identity has too.
     */
    public static boolean[] flags(List<String[]> people) {
        Map<String, Set<String>> bySkeleton = new HashMap<>();
        String[] skel = new String[people.size()];
        for (int i = 0; i < people.size(); i++) {
            String[] p = people.get(i);
            skel[i] = skeleton(p[1]);
            if (skel[i].isEmpty()) continue;
            bySkeleton.computeIfAbsent(skel[i], k -> new HashSet<>()).add(p[0] == null ? "" : p[0]);
        }
        boolean[] out = new boolean[people.size()];
        for (int i = 0; i < people.size(); i++) {
            Set<String> ids = skel[i].isEmpty() ? null : bySkeleton.get(skel[i]);
            out[i] = mixedScript(people.get(i)[1]) || (ids != null && ids.size() > 1);
        }
        return out;
    }

    /**
     * A message's sender (not mine): flagged when the name mixes scripts,
     * looks like my own name, or — the sender being in the room now — looks
     * like another member's (another identity). A sender no longer in the
     * room is not compared with the members: a reconnection gives the same
     * person a new connection id. roster: {connection id, identity, name}.
     */
    public static boolean senderFlag(List<String[]> roster, String myName, String senderId, String senderName) {
        if (mixedScript(senderName)) return true;
        String sk = skeleton(senderName);
        if (sk.isEmpty()) return false;
        int at = -1;
        for (int i = 0; i < roster.size(); i++) if (roster.get(i)[0] != null && roster.get(i)[0].equals(senderId)) at = i;
        if (at < 0) return myName != null && sk.equals(skeleton(myName));
        java.util.List<String[]> people = new java.util.ArrayList<>();
        for (int i = 0; i < roster.size(); i++) people.add(new String[]{roster.get(i)[1], i == at ? senderName : roster.get(i)[2]});
        return flags(people)[at];
    }

    /** An operator notice's message id starts so (chat/RoomSession.onServerNotice). */
    public static final String NOTICE_ID = "notice-";

    /**
     * An operator notice's sender: its kind's sign (✉ a private message, 📌
     * pinned, 📣 a wall message) and always the operator's label — never the
     * name the server's frame gave (it could be anyone's, F-22). Also for
     * notices kept in a history from before 6.12.
     */
    public static String operator(String storedSender, String operatorLabel) {
        String sign = "📣";
        if (storedSender != null) for (String s : new String[]{"✉", "📌", "📣"}) if (storedSender.startsWith(s)) sign = s;
        return sign + " " + operatorLabel;
    }

    /** The name with the flag before it when flagged. */
    public static String shown(String name, boolean flagged) {
        String n = normalize(name);
        return flagged ? FLAG + n : n;
    }

    /** Whether two names look alike (the same skeleton) while not being the same name. */
    public static boolean confusable(String a, String b) {
        String na = normalize(a), nb = normalize(b);
        return !na.isEmpty() && !na.equals(nb) && skeleton(na).equals(skeleton(nb));
    }
}
