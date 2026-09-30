package cz.m5cet.app.ui.parts;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** The PIN pad's keys sized to the room it gets (LockPad.keySizes): the last row always fits. */
public class LockPadSizeTest {
    /** Galaxy Z Fold6 cover screen: 968 × 2376 px at 420 dpi. */
    private static final float FOLD = 420 / 160f;

    private static int dp(int px, float density) { return Math.round(px / density); }

    /** Four rows and three columns fit, the keys stay in 40–84 dp. */
    private static int[] fits(int w, int h, float density) {
        int[] s = LockPad.keySizes(w, h, density);
        int key = s[0], gapH = s[1], gapV = s[2];
        assertTrue("key " + dp(key, density) + " dp", key >= Math.round(40 * density) && key <= Math.round(84 * density));
        if (w != Integer.MAX_VALUE) assertTrue("width " + (3 * key + 2 * gapH) + " > " + w, 3 * key + 2 * gapH <= w);
        if (h != Integer.MAX_VALUE) assertTrue("height " + (4 * key + 3 * gapV) + " > " + h, 4 * key + 3 * gapV <= h);
        return s;
    }

    @Test
    public void roomEnough() {
        // A tall phone: the keys at their largest.
        assertEquals(Math.round(84 * FOLD), fits(Math.round(340 * FOLD), Math.round(560 * FOLD), FOLD)[0]);
        // Unbounded (a scrolling design): the largest keys too.
        assertEquals(Math.round(84 * FOLD), fits(Integer.MAX_VALUE, Integer.MAX_VALUE, FOLD)[0]);
    }

    @Test
    public void foldCoverScreen() {
        // Portrait, header above the card: ~330 dp wide, ~560 dp left for the keys.
        fits(Math.round(330 * FOLD), Math.round(560 * FOLD), FOLD);
        // Landscape, header beside it: ~300 dp wide, ~230 dp high for the keys.
        int[] s = fits(Math.round(300 * FOLD), Math.round(230 * FOLD), FOLD);
        assertTrue(dp(s[0], FOLD) >= 44);
        // Split screen, half the height: ~330 × 200 dp.
        fits(Math.round(330 * FOLD), Math.round(200 * FOLD), FOLD);
    }

    @Test
    public void narrow() {
        // A narrow window: the width decides.
        int[] s = fits(Math.round(170 * FOLD), Math.round(600 * FOLD), FOLD);
        assertTrue(dp(s[0], FOLD) < 84);
    }

    @Test
    public void tooSmallStillHasFourRows() {
        // Below 4 × 40 dp the keys stay at 40 dp and the gaps give way (nothing negative).
        int[] s = LockPad.keySizes(Math.round(200 * FOLD), Math.round(150 * FOLD), FOLD);
        assertEquals(Math.round(40 * FOLD), s[0]);
        assertEquals(0, s[2]);
    }
}
