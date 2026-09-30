package cz.m5cet.app.ui.bubble;

import java.util.ArrayList;
import java.util.List;

/**
 * Web Mercator for the map preview (6.2): where a position falls in the
 * world of 256-px tiles at a zoom, and which tiles a view of w × h map
 * pixels centred exactly on it needs, with each tile's offset in the view.
 * No Android here, so it is unit-tested on the JVM.
 */
public final class TileMath {
    private TileMath() {}

    public static final int TILE = 256;
    /** Web Mercator stops here (the square world). */
    public static final double MAX_LAT = 85.0511287798;

    /** A tile of the view: its coordinates (x wrapped round the world) and where its top-left corner goes in the view (map px). */
    public static final class Tile {
        public final int z, x, y;
        public final double left, top;
        Tile(int z, int x, int y, double left, double top) { this.z = z; this.x = x; this.y = y; this.left = left; this.top = top; }
        @Override public String toString() { return z + "/" + x + "/" + y; }
    }

    /** The size of the world at zoom z, in map pixels. */
    public static double world(int z) { return TILE * Math.pow(2, z); }

    /** The position's pixel in the world at zoom z: {x, y}. */
    public static double[] project(double lat, double lon, int z) {
        double w = world(z);
        double la = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
        double lo = Math.max(-180, Math.min(180, lon));
        double x = (lo + 180) / 360 * w;
        double r = Math.toRadians(la);
        double y = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * w;
        return new double[]{x, y};
    }

    /** The tile a position is in (OpenStreetMap's slippy-map numbering). */
    public static int[] tileOf(double lat, double lon, int z) {
        double[] p = project(lat, lon, z);
        int n = 1 << z;
        return new int[]{Math.min(n - 1, (int) Math.floor(p[0] / TILE)), Math.min(n - 1, Math.max(0, (int) Math.floor(p[1] / TILE)))};
    }

    /**
     * The tiles for a w × h view centred on the position: rows top to bottom,
     * left to right. Tiles past the poles are left out (the view shows the
     * background there); x wraps across the date line.
     */
    public static List<Tile> tiles(double lat, double lon, int z, double w, double h) {
        double[] c = project(lat, lon, z);
        double left = c[0] - w / 2, top = c[1] - h / 2;
        int n = 1 << z;
        int x0 = (int) Math.floor(left / TILE), x1 = (int) Math.floor((left + w - 1e-9) / TILE);
        int y0 = (int) Math.floor(top / TILE), y1 = (int) Math.floor((top + h - 1e-9) / TILE);
        List<Tile> out = new ArrayList<>();
        for (int ty = y0; ty <= y1; ty++) {
            if (ty < 0 || ty >= n) continue;
            for (int tx = x0; tx <= x1; tx++) {
                int wx = ((tx % n) + n) % n;
                out.add(new Tile(z, wx, ty, tx * (double) TILE - left, ty * (double) TILE - top));
            }
        }
        return out;
    }

    /** Metres per map pixel at the latitude (for the accuracy circle). */
    public static double metersPerPixel(double lat, int z) {
        return 156543.03392 * Math.cos(Math.toRadians(Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)))) / Math.pow(2, z);
    }
}
