package cz.m5cet.app.ui;

import android.app.AlertDialog;
import android.net.Uri;

import java.util.regex.Pattern;

/**
 * 6.7 (security analysis F-01, critical): what of the server's design may
 * reach the network. The design is signed by the server, but the end-to-end
 * promise holds against the server too — so a design must not be able to
 * carry decrypted content off the phone. An image whose src is computed
 * ("=…" or a template with {…}) — e.g. "https://x/{$msg.text}" — used to be
 * fetched with the plaintext in its URL.
 *
 *   image src   a computed value may only name a local source (asset:…,
 *               data:image/…); a remote https image only as a fixed literal
 *               of the design (nothing from $msg, $form, $user… in it)
 *   url.open    the design's literal only (6.10, G-20: ui/ActionGuard), and
 *               the person sees the whole address and confirms before it
 *               opens — an address too long to read, or with spaces or
 *               hidden (bidi, zero-width) characters, is refused instead of
 *               being shown cut short
 */
public final class DesignUrls {
    private DesignUrls() {}

    /** url.open: longer than this cannot be read in a dialog — refused, not cut. */
    static final int URL_MAX = 300;
    /** Spaces of any kind, control characters, and invisible formatting (bidi overrides, zero-width…). */
    private static final Pattern HIDDEN = Pattern.compile("[\\s\\p{Z}\\p{Cc}\\p{Cf}]");

    /** The value is computed from data at bind time: an expression or a template. */
    static boolean dynamic(String raw) {
        return raw == null || raw.startsWith("=") || raw.indexOf('{') >= 0;
    }

    /** A source on the phone (the design's assets, inline image data) — no request leaves it. */
    static boolean local(String src) {
        return src.startsWith("asset:") || src.startsWith("data:image/");
    }

    /** What the image element may load for this raw prop and its bound value ("" = nothing). */
    public static String image(String raw, String bound) {
        String src = bound == null ? "" : bound.trim();
        if (src.isEmpty()) return "";
        if (local(src)) return src;
        if (!src.startsWith("https://")) return "";
        // A remote image: only exactly the literal the design states, never a computed address.
        return !dynamic(raw) && raw.trim().equals(src) ? src : "";
    }

    /** 6.10 (G-20): whether url.open may offer this address — https, at most URL_MAX characters, all of it visible. */
    static boolean openable(String url) {
        return url != null && url.startsWith("https://") && url.length() > "https://".length() && url.length() <= URL_MAX && !HIDDEN.matcher(url).find();
    }

    /** url.open from the design: the whole address is shown (host first) and opens only when confirmed. */
    static void confirmOpen(MainActivity a, String url) {
        if (!openable(url)) {
            cz.m5cet.app.core.Log.w("action", "url.open refused: not an address the person could read in full");
            a.flash("", a.app().t("security.urlRefused"), "warn");
            return;
        }
        String host = Uri.parse(url).getHost();
        new AlertDialog.Builder(a)
            .setTitle(host == null ? url : host)
            .setMessage(url)
            .setPositiveButton(a.app().t("msg.open"), (d, w) -> a.openUrl(url))
            .setNegativeButton(a.app().t("nav.close"), null)
            .show();
    }
}
