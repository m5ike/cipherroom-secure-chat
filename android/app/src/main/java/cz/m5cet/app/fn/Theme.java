package cz.m5cet.app.fn;

import android.graphics.Typeface;

/**
 * How the app looks and speaks, as the outputs and Markdown are drawn: the
 * design's colour tokens (@primary, @onPrimary, @onSurface, @muted,
 * @surfaceVariant, @border, @danger, @success, @warning), dp, the fonts —
 * and the app's words for the web's i18n keys (fnui.*, functions.*).
 */
public interface Theme {
    int color(String token);

    int dp(float value);

    Typeface typeface(boolean bold);

    /** The translation of a key; null (or the key itself) falls back to English. */
    default String text(String key) { return null; }
}
