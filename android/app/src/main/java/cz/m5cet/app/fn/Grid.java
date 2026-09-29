package cz.m5cet.app.fn;

import java.util.ArrayList;
import java.util.List;

/** A table as lines of monospace text: columns padded to their widest cell, a rule under the head. */
final class Grid {
    private Grid() {}

    /** rows.get(0) is the head. */
    static List<String> lines(List<List<String>> rows) {
        int cols = 0;
        for (List<String> r : rows) cols = Math.max(cols, r.size());
        int[] width = new int[cols];
        for (List<String> r : rows) for (int c = 0; c < r.size(); c++) width[c] = Math.max(width[c], length(r.get(c)));
        List<String> out = new ArrayList<>();
        for (int i = 0; i < rows.size(); i++) {
            List<String> r = rows.get(i);
            StringBuilder line = new StringBuilder();
            for (int c = 0; c < cols; c++) {
                String cell = c < r.size() ? r.get(c) : "";
                if (c > 0) line.append(" │ ");
                line.append(cell);
                if (c < cols - 1) line.append(Js.fill(' ', width[c] - length(cell)));
            }
            out.add(line.toString());
            if (i == 0) {
                StringBuilder rule = new StringBuilder();
                for (int c = 0; c < cols; c++) rule.append(c > 0 ? "─┼─" : "").append(Js.fill('─', width[c]));
                out.add(rule.toString());
            }
        }
        return out;
    }

    private static int length(String s) { return s.codePointCount(0, s.length()); }
}
