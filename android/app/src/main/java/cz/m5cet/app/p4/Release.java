package cz.m5cet.app.p4;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.regex.Pattern;

/**
 * Release manifests (docs/protocol-v4.md § 15, F-02; release.ts): release.json
 * lists every file with its size and SHA-256; release.json.sig is the
 * developer's Ed25519 signature over its exact bytes.
 */
public final class Release {
    private Release() {}

    public static final String FORMAT = "m5cet-release/1";
    private static final Pattern HEX64 = Pattern.compile("^[0-9a-f]{64}$");

    /** A path relative to the release root with "/": no leading "/", no "\", no empty, "." or ".." segment. */
    public static boolean isReleasePath(Object path) {
        if (!(path instanceof String)) return false;
        String p = (String) path;
        if (p.isEmpty() || p.startsWith("/") || p.contains("\\") || p.indexOf('\0') >= 0) return false;
        for (String seg : p.split("/", -1)) if (seg.isEmpty() || seg.equals(".") || seg.equals("..")) return false;
        return true;
    }

    /** Parses and validates release.json; files sorted by path (ordinal), no duplicates. */
    public static JSONObject parse(String text) throws P4Error {
        JSONObject m;
        try { m = new JSONObject(text); } catch (JSONException e) { throw P4Error.malformed("release manifest is not JSON"); }
        if (!FORMAT.equals(m.opt("format"))) throw P4Error.malformed("not an m5cet-release/1 manifest");
        for (String f : new String[]{"name", "version", "commit", "created"}) if (!(m.opt(f) instanceof String)) throw P4Error.malformed("manifest " + f + " missing");
        JSONArray files = m.optJSONArray("files");
        if (files == null) throw P4Error.malformed("manifest files missing");
        String previous = null;
        for (int i = 0; i < files.length(); i++) {
            JSONObject f = files.optJSONObject(i);
            if (f == null || !isReleasePath(f.opt("path")) || !Prim.isSafeCount(f.opt("size")) || !(f.opt("sha256") instanceof String) || !HEX64.matcher(f.optString("sha256")).matches()) {
                throw P4Error.malformed("bad manifest file entry");
            }
            String path = f.optString("path");
            if (previous != null && previous.compareTo(path) >= 0) throw P4Error.malformed("manifest files not sorted by path");
            previous = path;
        }
        return m;
    }

    /** Ed25519 over the exact manifest bytes; signature and key are b64 (surrounding whitespace ignored). Never throws. */
    public static boolean verifySignature(byte[] manifestBytes, String signature, String publicKey) {
        if (signature == null || publicKey == null) return false;
        return Prim.ed25519Verify(publicKey.trim(), manifestBytes, signature.trim());
    }

    public static String sha256Hex(byte[] bytes) { return Prim.hex(Prim.H(bytes)); }
}
