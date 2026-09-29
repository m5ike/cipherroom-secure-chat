package cz.m5cet.app.ui;

import android.graphics.Path;

/**
 * The SVG path language (M L H V C S Q T A Z, absolute and relative) into
 * an android.graphics.Path — enough for every lucide icon. Arcs become cubic
 * Béziers (at most 90° each), as the SVG spec's conversion describes.
 */
final class SvgPath {
    private SvgPath() {}

    private static final class Reader {
        final String s; int i = 0;
        Reader(String s) { this.s = s; }
        void skip() { while (i < s.length() && (Character.isWhitespace(s.charAt(i)) || s.charAt(i) == ',')) i++; }
        boolean more() { skip(); return i < s.length(); }
        boolean isCommand() { skip(); return i < s.length() && Character.isLetter(s.charAt(i)) && s.charAt(i) != 'e' && s.charAt(i) != 'E'; }
        char command() { skip(); return s.charAt(i++); }
        float number() {
            skip();
            int start = i;
            if (i < s.length() && (s.charAt(i) == '-' || s.charAt(i) == '+')) i++;
            boolean dot = false, exp = false;
            while (i < s.length()) {
                char c = s.charAt(i);
                if (Character.isDigit(c)) { i++; }
                else if (c == '.' && !dot && !exp) { dot = true; i++; }
                else if ((c == 'e' || c == 'E') && !exp) { exp = true; i++; if (i < s.length() && (s.charAt(i) == '-' || s.charAt(i) == '+')) i++; }
                else break;
            }
            return start == i ? 0 : Float.parseFloat(s.substring(start, i));
        }
        /** Arc flags may be written without separators ("a1 1 0 01 1 1"). */
        boolean flag() { skip(); char c = s.charAt(i++); return c == '1'; }
    }

    static Path parse(String d) {
        Path p = new Path();
        Reader r = new Reader(d);
        float x = 0, y = 0, sx = 0, sy = 0, cx = 0, cy = 0, qx = 0, qy = 0;
        char cmd = 'M', prev = ' ';
        while (r.more()) {
            if (r.isCommand()) cmd = r.command();
            else if (cmd == 'M') cmd = 'L';
            else if (cmd == 'm') cmd = 'l';
            boolean rel = Character.isLowerCase(cmd);
            switch (Character.toUpperCase(cmd)) {
                case 'M': { float nx = r.number(), ny = r.number(); if (rel) { nx += x; ny += y; } p.moveTo(nx, ny); x = sx = nx; y = sy = ny; break; }
                case 'L': { float nx = r.number(), ny = r.number(); if (rel) { nx += x; ny += y; } p.lineTo(nx, ny); x = nx; y = ny; break; }
                case 'H': { float nx = r.number(); if (rel) nx += x; p.lineTo(nx, y); x = nx; break; }
                case 'V': { float ny = r.number(); if (rel) ny += y; p.lineTo(x, ny); y = ny; break; }
                case 'C': {
                    float x1 = r.number(), y1 = r.number(), x2 = r.number(), y2 = r.number(), nx = r.number(), ny = r.number();
                    if (rel) { x1 += x; y1 += y; x2 += x; y2 += y; nx += x; ny += y; }
                    p.cubicTo(x1, y1, x2, y2, nx, ny); cx = x2; cy = y2; x = nx; y = ny; break;
                }
                case 'S': {
                    float x2 = r.number(), y2 = r.number(), nx = r.number(), ny = r.number();
                    if (rel) { x2 += x; y2 += y; nx += x; ny += y; }
                    char pu = Character.toUpperCase(prev);
                    float x1 = pu == 'C' || pu == 'S' ? 2 * x - cx : x, y1 = pu == 'C' || pu == 'S' ? 2 * y - cy : y;
                    p.cubicTo(x1, y1, x2, y2, nx, ny); cx = x2; cy = y2; x = nx; y = ny; break;
                }
                case 'Q': {
                    float x1 = r.number(), y1 = r.number(), nx = r.number(), ny = r.number();
                    if (rel) { x1 += x; y1 += y; nx += x; ny += y; }
                    p.quadTo(x1, y1, nx, ny); qx = x1; qy = y1; x = nx; y = ny; break;
                }
                case 'T': {
                    float nx = r.number(), ny = r.number();
                    if (rel) { nx += x; ny += y; }
                    char pu = Character.toUpperCase(prev);
                    float x1 = pu == 'Q' || pu == 'T' ? 2 * x - qx : x, y1 = pu == 'Q' || pu == 'T' ? 2 * y - qy : y;
                    p.quadTo(x1, y1, nx, ny); qx = x1; qy = y1; x = nx; y = ny; break;
                }
                case 'A': {
                    float rx = r.number(), ry = r.number(), rot = r.number();
                    boolean large = r.flag(), sweep = r.flag();
                    float nx = r.number(), ny = r.number();
                    if (rel) { nx += x; ny += y; }
                    arc(p, x, y, nx, ny, rx, ry, rot, large, sweep);
                    x = nx; y = ny; break;
                }
                case 'Z': p.close(); x = sx; y = sy; break;
                default: return p;
            }
            prev = cmd;
        }
        return p;
    }

    /** SVG 1.1 F.6.5: endpoint to centre parameterisation, then ≤ 90° cubic pieces. */
    private static void arc(Path p, float x0, float y0, float x, float y, float rx, float ry, float angle, boolean large, boolean sweep) {
        if (rx == 0 || ry == 0) { p.lineTo(x, y); return; }
        if (x0 == x && y0 == y) return;
        rx = Math.abs(rx); ry = Math.abs(ry);
        double phi = Math.toRadians(angle % 360), cos = Math.cos(phi), sin = Math.sin(phi);
        double dx = (x0 - x) / 2.0, dy = (y0 - y) / 2.0;
        double x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
        double lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
        if (lambda > 1) { double s = Math.sqrt(lambda); rx *= s; ry *= s; }
        double num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
        double den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
        double coef = (large != sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / den));
        double cx1 = coef * (rx * y1 / ry), cy1 = coef * -(ry * x1 / rx);
        double cx = cos * cx1 - sin * cy1 + (x0 + x) / 2.0, cy = sin * cx1 + cos * cy1 + (y0 + y) / 2.0;
        double theta1 = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
        double delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
        if (!sweep && delta > 0) delta -= 2 * Math.PI;
        else if (sweep && delta < 0) delta += 2 * Math.PI;
        int segments = (int) Math.ceil(Math.abs(delta) / (Math.PI / 2));
        double step = delta / segments;
        double t = 4.0 / 3.0 * Math.tan(step / 4);
        double a = theta1;
        for (int i = 0; i < segments; i++) {
            double c1 = Math.cos(a), s1 = Math.sin(a), c2 = Math.cos(a + step), s2 = Math.sin(a + step);
            double e1x = c1 - t * s1, e1y = s1 + t * c1, e2x = c2 + t * s2, e2y = s2 - t * c2;
            p.cubicTo(
                (float) (cx + rx * e1x * cos - ry * e1y * sin), (float) (cy + rx * e1x * sin + ry * e1y * cos),
                (float) (cx + rx * e2x * cos - ry * e2y * sin), (float) (cy + rx * e2x * sin + ry * e2y * cos),
                (float) (cx + rx * c2 * cos - ry * s2 * sin), (float) (cy + rx * c2 * sin + ry * s2 * cos));
            a += step;
        }
    }

    private static double angle(double ux, double uy, double vx, double vy) {
        double a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
        return a;
    }
}
