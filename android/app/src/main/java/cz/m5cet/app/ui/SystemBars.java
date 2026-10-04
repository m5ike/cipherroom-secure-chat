package cz.m5cet.app.ui;

import android.os.Build;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;

/**
 * 6.7 (audit V5): edge-to-edge drawing, the bars' insets and their light or
 * dark icons on every Android the app runs on. The window-insets API used
 * before is from API 30 (Android 11); on Android 10 (API 29, the app's
 * minSdk) the same is done with the older system-UI flags.
 */
@SuppressWarnings("deprecation")
final class SystemBars {
    private SystemBars() {}

    /** The content draws behind the status and navigation bars (the insets pad it). */
    static void edgeToEdge(Window w) {
        if (Build.VERSION.SDK_INT >= 30) { w.setDecorFitsSystemWindows(false); return; }
        View decor = w.getDecorView();
        decor.setSystemUiVisibility(decor.getSystemUiVisibility() | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    /** {left, top, right, bottom} of the system bars and the keyboard. */
    static int[] insets(WindowInsets in) {
        if (Build.VERSION.SDK_INT >= 30) {
            android.graphics.Insets b = in.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
            return new int[]{b.left, b.top, b.right, b.bottom};
        }
        return new int[]{in.getSystemWindowInsetLeft(), in.getSystemWindowInsetTop(), in.getSystemWindowInsetRight(), in.getSystemWindowInsetBottom()};
    }

    /** The insets are used up here (nothing below pads itself again). */
    static WindowInsets consumed(WindowInsets in) {
        return Build.VERSION.SDK_INT >= 30 ? WindowInsets.CONSUMED : in.consumeSystemWindowInsets();
    }

    /** Dark icons on light bars (a light theme), light icons otherwise. */
    static void lightBars(Window w, boolean light) {
        View decor = w.getDecorView();
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = decor.getWindowInsetsController();
            int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            if (c != null) c.setSystemBarsAppearance(light ? mask : 0, mask);
            return;
        }
        int flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        int v = decor.getSystemUiVisibility();
        decor.setSystemUiVisibility(light ? v | flags : v & ~flags);
    }
}
