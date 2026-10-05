package cz.m5cet.app.core;

import java.text.DateFormat;
import java.text.NumberFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/**
 * 6.13: numbers, dates and times as the app's language writes them — its BCP 47
 * tag (Locales.tag: cs-CZ, sk-SK, fi-FI …), not the phone's region, so a text
 * and the date in it speak one language. java.text with the platform's CLDR data.
 */
public final class Formats {
    private Formats() {}

    private static Locale loc(String lang) { return Locales.locale(lang); }

    /** A whole number: 7, 1 234 (cs), 1.234 (de), 1,234 (en). */
    public static String count(String lang, long n) {
        if (n > -1000 && n < 1000) return Long.toString(n);
        return NumberFormat.getIntegerInstance(loc(lang)).format(n);
    }

    /** A number with at most {@code digits} decimals: 1,5 (cs), 1.5 (en). */
    public static String decimal(String lang, double v, int digits) {
        NumberFormat f = NumberFormat.getNumberInstance(loc(lang));
        f.setMaximumFractionDigits(Math.max(0, digits));
        f.setMinimumFractionDigits(Math.max(0, digits));
        return f.format(v);
    }

    /** A day: 5. 10. 2026 (cs), 05.10.2026 (de), 5 Oct 2026 (en-GB). */
    public static String date(String lang, long at) { return date(lang, at, null); }

    public static String date(String lang, long at, TimeZone tz) {
        return in(DateFormat.getDateInstance(DateFormat.MEDIUM, loc(lang)), tz).format(new Date(at));
    }

    /** A time of day, hours and minutes. */
    public static String time(String lang, long at) { return time(lang, at, null); }

    public static String time(String lang, long at, TimeZone tz) {
        return in(DateFormat.getTimeInstance(DateFormat.SHORT, loc(lang)), tz).format(new Date(at));
    }

    /** A time of day with seconds. */
    public static String timeSeconds(String lang, long at) {
        return DateFormat.getTimeInstance(DateFormat.MEDIUM, loc(lang)).format(new Date(at));
    }

    /** Day and time (short day, minutes). */
    public static String dateTime(String lang, long at) { return dateTime(lang, at, null); }

    public static String dateTime(String lang, long at, TimeZone tz) {
        return in(DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT, loc(lang)), tz).format(new Date(at));
    }

    /** Day and time in full (a message's details): the long day, the time with seconds. */
    public static String full(String lang, long at) {
        return DateFormat.getDateTimeInstance(DateFormat.LONG, DateFormat.MEDIUM, loc(lang)).format(new Date(at));
    }

    /** Short day and the time with seconds. */
    public static String shortFull(String lang, long at) {
        return DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.MEDIUM, loc(lang)).format(new Date(at));
    }

    private static DateFormat in(DateFormat f, TimeZone tz) {
        if (tz != null) f.setTimeZone(tz);
        return f;
    }
}
