package cz.m5cet.app.update;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.zip.GZIPInputStream;

import cz.m5cet.app.security.Crypto;
import cz.m5cet.app.security.Ec;
import cz.m5cet.app.security.Ecies;

/**
 * A downloaded bundle (.m5ab, docs/android-architecture.md §1.6):
 *   verify   the header's signature with the pinned server key
 *   unwrap   the content key (ECIES, purpose "bundle|<id>") for this device
 *   decrypt  256 KiB AES-256-GCM segments, checking both hashes
 *   unpack   gzip → M5PK container → files, each checked against the manifest
 */
public final class BundleFile {
    public static final int MAX_HEADER = 4 * 1024 * 1024;
    public static final int MAX_CONTENT = 64 * 1024 * 1024;

    public final JSONObject header;
    private final byte[] file;
    private final int bodyAt;

    private BundleFile(JSONObject header, byte[] file, int bodyAt) {
        this.header = header;
        this.file = file;
        this.bodyAt = bodyAt;
    }

    public static BundleFile parse(byte[] file) throws GeneralSecurityException {
        if (file.length < 9 || file[0] != 'M' || file[1] != '5' || file[2] != 'A' || file[3] != 'B' || file[4] != 1) throw new GeneralSecurityException("not an M5AB bundle");
        int n = ((file[5] & 0xff) << 24) | ((file[6] & 0xff) << 16) | ((file[7] & 0xff) << 8) | (file[8] & 0xff);
        if (n < 2 || n > MAX_HEADER || 9L + n > file.length) throw new GeneralSecurityException("bad bundle header");
        try {
            return new BundleFile(new JSONObject(new String(file, 9, n, StandardCharsets.UTF_8)), file, 9 + n);
        } catch (JSONException e) {
            throw new GeneralSecurityException("bad bundle header", e);
        }
    }

    public String id() { return header.optString("id"); }
    public int number() { return header.optInt("number"); }
    public String version() { return header.optString("version"); }
    public String channel() { return header.optString("channel"); }
    public long created() { return header.optLong("created"); }
    public int minAppCode() { return header.optInt("minAppCode"); }
    public String kid() { return header.optString("kid"); }

    public String signedString() {
        return "m5bundle/1|" + id() + "|" + number() + "|" + version() + "|" + channel() + "|" + created() + "|" + minAppCode() + "|"
            + header.optLong("size") + "|" + header.optString("sha256") + "|" + header.optInt("seg") + "|" + header.optInt("segments") + "|" + header.optString("ctSha256");
    }

    public boolean verify(PublicKey serverKey) {
        try { return Ec.verify(serverKey, Crypto.utf8(signedString()), Crypto.unb64(header.optString("sig"))); }
        catch (IllegalArgumentException e) { return false; }
    }

    public byte[] unwrapKey(PrivateKey deviceEncKey, String deviceId) throws GeneralSecurityException {
        JSONArray recipients = header.optJSONArray("recipients");
        if (recipients != null) {
            for (int i = 0; i < recipients.length(); i++) {
                JSONObject r = recipients.optJSONObject(i);
                if (r != null && deviceId.equals(r.optString("device"))) {
                    byte[] cek = Ecies.open(deviceEncKey, deviceId, "bundle|" + id(), new Ecies.Wire(r.optString("e"), r.optString("iv"), r.optString("ct")));
                    if (cek.length != 32) throw new GeneralSecurityException("bad bundle key");
                    return cek;
                }
            }
        }
        throw new GeneralSecurityException("the bundle is not encrypted for this device");
    }

    /** The plain content (gzipped container), every hash checked. */
    public byte[] decrypt(byte[] cek) throws GeneralSecurityException {
        int bodyLen = file.length - bodyAt;
        byte[] ctHash = Crypto.sha256(java.util.Arrays.copyOfRange(file, bodyAt, file.length));
        if (!Crypto.same(ctHash, Crypto.unb64(header.optString("ctSha256")))) throw new GeneralSecurityException("bundle ciphertext hash mismatch");
        long size = header.optLong("size");
        int seg = header.optInt("seg");
        int segments = header.optInt("segments");
        if (size < 0 || size > MAX_CONTENT || seg < 1024 || segments < 1 || (long) seg * (segments - 1) > size) throw new GeneralSecurityException("bad bundle segmentation");
        byte[] out = new byte[(int) size];
        int at = bodyAt;
        int outAt = 0;
        for (int i = 0; i < segments; i++) {
            boolean last = i == segments - 1;
            int plainLen = last ? (int) (size - (long) seg * (segments - 1)) : seg;
            if (at + 12 + plainLen + 16 > file.length) throw new GeneralSecurityException("truncated bundle");
            byte[] iv = java.util.Arrays.copyOfRange(file, at, at + 12);
            byte[] ct = java.util.Arrays.copyOfRange(file, at + 12, at + 12 + plainLen + 16);
            byte[] plain = Crypto.gcmOpen(cek, iv, ct, Crypto.utf8("m5bundle/1|" + id() + "|" + i + "|" + (last ? "1" : "0")));
            System.arraycopy(plain, 0, out, outAt, plain.length);
            outAt += plain.length;
            at += 12 + plainLen + 16;
        }
        if (at != file.length || bodyLen <= 0) throw new GeneralSecurityException("bundle has trailing bytes");
        if (!Crypto.same(Crypto.sha256(out), Crypto.unb64(header.optString("sha256")))) throw new GeneralSecurityException("bundle content hash mismatch");
        return out;
    }

    /** The files of a plain content, in order; the manifest first and checked. */
    public static Map<String, byte[]> unpack(byte[] gzipped) throws GeneralSecurityException {
        byte[] c;
        try (GZIPInputStream in = new GZIPInputStream(new ByteArrayInputStream(gzipped)); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > MAX_CONTENT) throw new GeneralSecurityException("bundle too large");
            }
            c = out.toByteArray();
        } catch (IOException e) {
            throw new GeneralSecurityException("bad bundle compression", e);
        }
        if (c.length < 9 || c[0] != 'M' || c[1] != '5' || c[2] != 'P' || c[3] != 'K' || c[4] != 1) throw new GeneralSecurityException("not an M5PK container");
        int count = be32(c, 5);
        Map<String, byte[]> files = new LinkedHashMap<>();
        int at = 9;
        for (int i = 0; i < count; i++) {
            if (at + 2 > c.length) throw new GeneralSecurityException("truncated container");
            int pl = ((c[at] & 0xff) << 8) | (c[at + 1] & 0xff);
            at += 2;
            if (at + pl + 4 > c.length) throw new GeneralSecurityException("truncated container");
            String path = new String(c, at, pl, StandardCharsets.UTF_8);
            at += pl;
            int len = be32(c, at);
            at += 4;
            if (len < 0 || at + len > c.length) throw new GeneralSecurityException("truncated container");
            if (path.contains("..") || path.startsWith("/")) throw new GeneralSecurityException("bad path in the container");
            files.put(path, java.util.Arrays.copyOfRange(c, at, at + len));
            at += len;
        }
        if (at != c.length) throw new GeneralSecurityException("trailing bytes in the container");
        byte[] manifestBytes = files.get("manifest.json");
        if (manifestBytes == null || !files.keySet().iterator().next().equals("manifest.json")) throw new GeneralSecurityException("the bundle has no manifest");
        try {
            JSONObject manifest = new JSONObject(new String(manifestBytes, StandardCharsets.UTF_8));
            JSONObject list = manifest.optJSONObject("files");
            if (list == null || manifest.optInt("format") != 1) throw new GeneralSecurityException("unknown bundle format");
            for (Iterator<String> it = list.keys(); it.hasNext(); ) {
                String path = it.next();
                JSONObject info = list.getJSONObject(path);
                byte[] data = files.get(path);
                if (data == null || data.length != info.optInt("size", -1) || !Crypto.hex(Crypto.sha256(data)).equals(info.optString("sha256"))) {
                    throw new GeneralSecurityException("bundle file " + path + " does not match its manifest");
                }
            }
        } catch (JSONException e) {
            throw new GeneralSecurityException("bad manifest", e);
        }
        return files;
    }

    private static int be32(byte[] b, int at) {
        return ((b[at] & 0xff) << 24) | ((b[at + 1] & 0xff) << 16) | ((b[at + 2] & 0xff) << 8) | (b[at + 3] & 0xff);
    }
}
