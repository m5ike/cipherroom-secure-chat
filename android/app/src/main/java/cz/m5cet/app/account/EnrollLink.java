package cz.m5cet.app.account;

import java.io.UnsupportedEncodingException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URLDecoder;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * The console's enrolment link, its QR code (server/android/admin-routes.ts):
 * m5cet://enroll?server=…&amp;code=…&amp;kid=… (the server URL-encoded, kid = the server's key id).
 * Pure Java (the server is checked with java.net.URI, not android.net.Uri),
 * so the JVM tests run it.
 *
 *   server   required; a bare host means https; http(s) only, no user, query
 *            or fragment (a path is kept, for a server behind a prefix)
 *   code     optional; letters, digits and dashes — anything else is ignored
 *            (the user types it)
 *   kid      optional; pins the server's signing key, so it must look like
 *            one (16 base64url characters) — a link with a damaged kid is
 *            refused rather than enrolling without the pin
 *
 * Unknown parameters are ignored; of repeated ones the first counts.
 */
public final class EnrollLink {
    private static final Pattern KID = Pattern.compile("[A-Za-z0-9_-]{16}");
    private static final Pattern CODE = Pattern.compile("[A-Za-z0-9-]{1,40}");

    /** The server's base address: scheme://host[:port][/path], no trailing slash. */
    public final String server;
    /** The enrolment code ("" when the link has none). */
    public final String code;
    /** The server key id the link pins ("" when none). */
    public final String kid;

    private EnrollLink(String server, String code, String kid) {
        this.server = server;
        this.code = code;
        this.kid = kid;
    }

    /** Is this an m5cet://enroll link at all (valid or not)? */
    public static boolean isEnrollLink(String link) {
        return link != null && LINK.matcher(link.trim()).matches();
    }

    /** m5cet://enroll[/][?query][#…] — the query is split by hand, so one broken parameter does not spoil the rest. */
    private static final Pattern LINK = Pattern.compile("(?i)m5cet://enroll/?(\\?[^#]*)?(#.*)?");

    /** The link's values, or null when it is not an enrolment link or its server or kid is unusable. */
    public static EnrollLink parse(String link) {
        if (!isEnrollLink(link)) return null;
        String s = link.trim();
        int q = s.indexOf('?'), hash = s.indexOf('#');
        if (q < 0 || (hash >= 0 && hash < q)) return null;
        String query = s.substring(q + 1, hash < 0 ? s.length() : hash);
        String server = null, code = null, kid = null;
        for (String pair : query.split("&")) {
            int eq = pair.indexOf('=');
            String k = decode(eq < 0 ? pair : pair.substring(0, eq));
            String v = decode(eq < 0 ? "" : pair.substring(eq + 1));
            if (k == null || v == null) continue;
            switch (k) {
                case "server": if (server == null) server = v; break;
                case "code": if (code == null) code = v; break;
                case "kid": if (kid == null) kid = v; break;
                default: break;
            }
        }
        String base = server(server);
        if (base == null) return null;
        String pin = kid == null ? "" : kid.trim();
        if (!pin.isEmpty() && !KID.matcher(pin).matches()) return null;
        return new EnrollLink(base, code(code), pin);
    }

    /** A server address as the app keeps it, or null when it is not an http(s) server. */
    public static String server(String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        if (s.isEmpty() || s.length() > 300) return null;
        if (!s.contains("://")) s = "https://" + s;
        URI u;
        try { u = new URI(s); } catch (URISyntaxException e) { return null; }
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
        if (!scheme.equals("https") && !scheme.equals("http")) return null;
        String host = u.getHost();
        if (host == null || host.isEmpty() || u.getRawUserInfo() != null || u.getRawQuery() != null || u.getRawFragment() != null) return null;
        if (u.getPort() > 65535) return null;
        String path = u.getRawPath() == null ? "" : u.getRawPath();
        while (path.endsWith("/")) path = path.substring(0, path.length() - 1);
        return scheme + "://" + host.toLowerCase(Locale.ROOT) + (u.getPort() >= 0 ? ":" + u.getPort() : "") + path;
    }

    /** Do two addresses name the same server (case, a trailing slash and a missing https:// do not matter)? */
    public static boolean sameServer(String a, String b) {
        String x = server(a), y = server(b);
        return x != null && x.equals(y);
    }

    /** The same host, port and path whatever the scheme. */
    public static boolean sameHost(String a, String b) {
        String x = server(a), y = server(b);
        return x != null && y != null && x.replaceFirst("^https?://", "").equals(y.replaceFirst("^https?://", ""));
    }

    /** The code as the server compares it (upper case, no spaces), or "" when it is not one. */
    static String code(String raw) {
        if (raw == null) return "";
        String c = raw.replaceAll("\\s+", "");
        return CODE.matcher(c).matches() ? c.toUpperCase(Locale.ROOT) : "";
    }

    /** A query component, form-decoded as URLSearchParams wrote it; null when its escapes are broken. */
    private static String decode(String s) {
        try { return URLDecoder.decode(s, "UTF-8"); }
        catch (IllegalArgumentException | UnsupportedEncodingException e) { return null; }
    }
}
