package cz.m5cet.app.ui;

import android.app.AlertDialog;
import android.net.Uri;

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
 *   url.open    the person sees the address and confirms before it opens
 */
public final class DesignUrls {
    private DesignUrls() {}

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

    /** url.open from the design: the address is shown (host first) and opens only when confirmed. */
    static void confirmOpen(MainActivity a, String url) {
        if (url == null || !url.startsWith("https://")) return;
        String host = Uri.parse(url).getHost();
        String shown = url.length() > 300 ? url.substring(0, 299) + "…" : url;
        new AlertDialog.Builder(a)
            .setTitle(host == null ? url : host)
            .setMessage(shown)
            .setPositiveButton(a.app().t("msg.open"), (d, w) -> a.openUrl(url))
            .setNegativeButton(a.app().t("nav.close"), null)
            .show();
    }
}
