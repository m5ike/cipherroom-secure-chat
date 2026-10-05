package cz.m5cet.app.fn;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/**
 * 6.11: the suggester's matching — what typed letters find in a keyword, a
 * name or a summary, and where (the parts to highlight). Case and Czech (or
 * any) diacritics do not count ("pocasi" finds "Počasí"). Best first: the
 * whole text, its start, the start of a word in it, anywhere in it, and —
 * for keywords — the letters in order from a word's start ("pl" finds
 * "phone-lookup": p…l; closer together is better). Pure.
 */
public final class Fuzzy {
    private Fuzzy() {}

    public static final int EXACT = 1100, PREFIX = 1000, WORD = 800, INSIDE = 600, SPREAD = 300;

    /** A match: how good (higher is better) and the parts of the text it found, as [start, end) pairs. */
    public static final class Match {
        public final int score;
        public final List<int[]> hits;
        Match(int score, List<int[]> hits) { this.score = score; this.hits = Collections.unmodifiableList(hits); }
    }

    private static final Match ALL = new Match(0, new ArrayList<>());

    /** One character as it is compared: lower case, without its diacritic. */
    static char fold(char c) {
        char lower = Character.toLowerCase(c);
        if (lower < 0x80) return lower;
        String d = Normalizer.normalize(String.valueOf(lower), Normalizer.Form.NFD);
        return d.isEmpty() ? lower : d.charAt(0);
    }

    /** A text folded character by character (the indexes stay those of the text). */
    static String fold(String s) {
        char[] out = new char[s.length()];
        for (int i = 0; i < out.length; i++) out[i] = fold(s.charAt(i));
        return new String(out);
    }

    private static boolean wordStart(String s, int i) {
        return i == 0 || !Character.isLetterOrDigit(s.charAt(i - 1));
    }

    private static List<int[]> one(int start, int end) {
        List<int[]> l = new ArrayList<>();
        l.add(new int[]{start, end});
        return l;
    }

    /**
     * Where query is in text; null when it is not. An empty query matches
     * everything (score 0, nothing to highlight). spread: the letters may
     * also lie apart, in order, starting at a word (keywords).
     */
    public static Match match(String query, String text, boolean spread) {
        if (query == null || query.isEmpty()) return ALL;
        if (text == null || text.isEmpty()) return null;
        String q = fold(query.toLowerCase(Locale.ROOT)), t = fold(text);
        int n = q.length();
        if (t.equals(q)) return new Match(EXACT, one(0, n));
        if (t.startsWith(q)) return new Match(PREFIX, one(0, n));
        for (int i = 1; i + n <= t.length(); i++) {
            if (wordStart(t, i) && t.startsWith(q, i)) return new Match(WORD - Math.min(i, 100), one(i, i + n));
        }
        int at = t.indexOf(q);
        if (at >= 0) return new Match(INSIDE - Math.min(at, 100), one(at, at + n));
        if (!spread || n < 2) return null;
        // The letters in order, the first at a word's start; closer together is better.
        for (int s = 0; s < t.length(); s++) {
            if (t.charAt(s) != q.charAt(0) || !wordStart(t, s)) continue;
            List<int[]> hits = new ArrayList<>();
            int j = 0, last = -2, first = s;
            for (int i = s; i < t.length() && j < n; i++) {
                if (t.charAt(i) != q.charAt(j)) continue;
                if (i == last + 1 && !hits.isEmpty()) hits.get(hits.size() - 1)[1] = i + 1;
                else hits.add(new int[]{i, i + 1});
                last = i;
                j++;
            }
            if (j == n) return new Match(Math.max(1, SPREAD - (last + 1 - first - n) * 10 - Math.min(first, 50)), hits);
        }
        return null;
    }
}
