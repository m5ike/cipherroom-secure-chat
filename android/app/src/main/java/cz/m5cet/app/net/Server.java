package cz.m5cet.app.net;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.GeneralSecurityException;
import java.util.Locale;

import cz.m5cet.app.BuildConfig;
import cz.m5cet.app.core.Config;
import cz.m5cet.app.security.Crypto;
import cz.m5cet.app.security.Ec;
import cz.m5cet.app.security.Keystore;

/**
 * The server's device API (/api/android/*). Every request after enrolment
 * is signed with the device key in the Keystore
 * ("m5android/1|METHOD|path?query|time|nonce|b64(sha256(body))", P1363).
 */
public final class Server {
    public static final class HttpError extends IOException {
        public final int status;
        public final String code;
        HttpError(int status, String code, String message) { super(message); this.status = status; this.code = code; }
    }

    public interface Progress { void on(long done, long total); }

    private final Config config;

    public Server(Config config) { this.config = config; }

    public static String normalize(String url) {
        String u = url.trim();
        if (!u.matches("(?i)^https?://.*")) u = "https://" + u;
        while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        return u;
    }

    public static String signedString(String method, String pathAndQuery, String time, String nonce, byte[] body) {
        return "m5android/1|" + method.toUpperCase(Locale.ROOT) + "|" + pathAndQuery + "|" + time + "|" + nonce + "|" + Crypto.b64(Crypto.sha256(body));
    }

    /** The headers of a signed request (also stored for a request sent after a wipe). */
    public static JSONObject signHeaders(String deviceId, String method, String pathAndQuery, byte[] body, long time) throws GeneralSecurityException {
        String nonce = Crypto.b64url(Crypto.random(16));
        String t = String.valueOf(time);
        byte[] sig = Ec.sign(Keystore.signKey(), Crypto.utf8(signedString(method, pathAndQuery, t, nonce, body)));
        try {
            return new JSONObject().put("X-M5-Device", deviceId).put("X-M5-Time", t).put("X-M5-Nonce", nonce).put("X-M5-Signature", Crypto.b64(sig));
        } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    static HttpURLConnection open(String url, String method, int timeoutMs) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(15_000);
        c.setReadTimeout(timeoutMs);
        c.setUseCaches(false);
        c.setInstanceFollowRedirects(false);
        c.setRequestProperty("User-Agent", "M5cet-Android/" + BuildConfig.VERSION_NAME);
        c.setRequestProperty("Accept", "application/json");
        return c;
    }

    static byte[] readAll(InputStream in, long total, Progress progress, long max) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[64 * 1024];
        int n;
        long done = 0;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            done += n;
            if (done > max) throw new IOException("the answer is too large");
            if (progress != null) progress.on(done, total);
        }
        return out.toByteArray();
    }

    /** Sends a request; answers the body, or throws HttpError with the server's message. */
    public static byte[] send(String url, String method, byte[] body, JSONObject headers, Progress progress, long max) throws IOException {
        HttpURLConnection c = open(url, method, 60_000);
        try {
            if (headers != null) {
                for (java.util.Iterator<String> it = headers.keys(); it.hasNext(); ) { String k = it.next(); c.setRequestProperty(k, headers.optString(k)); }
            }
            if (body != null && !method.equals("GET")) {
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                c.setFixedLengthStreamingMode(body.length);
                try (OutputStream out = c.getOutputStream()) { out.write(body); }
            }
            int status = c.getResponseCode();
            if (status >= 200 && status < 300) {
                try (InputStream in = c.getInputStream()) { return readAll(in, c.getContentLengthLong(), progress, max); }
            }
            String message = "HTTP " + status;
            String code = "";
            try (InputStream in = c.getErrorStream()) {
                if (in != null) {
                    JSONObject err = new JSONObject(new String(readAll(in, -1, null, 64 * 1024), "UTF-8"));
                    message = err.optString("message", message);
                    code = err.optString("code", "");
                }
            } catch (JSONException | IOException ignored) { }
            throw new HttpError(status, code, message);
        } finally {
            c.disconnect();
        }
    }

    private static JSONObject json(byte[] b) throws IOException {
        try { return new JSONObject(new String(b, "UTF-8")); } catch (JSONException e) { throw new IOException("not a JSON answer", e); }
    }

    /* ------------------------------------------------------------ unsigned */

    public static JSONObject info(String base) throws IOException {
        return json(send(normalize(base) + "/api/android/info", "GET", null, null, null, 1 << 20));
    }

    public JSONObject enroll(String base, String code, String name, String model, String manufacturer, String fcmToken, String locale) throws IOException, GeneralSecurityException {
        String signKey = Config.signPublicKey();
        String encKey = config.encPublicKey();
        long time = System.currentTimeMillis();
        byte[] proof = Ec.sign(Keystore.signKey(), Crypto.utf8("m5android/enroll/1|" + signKey + "|" + encKey + "|" + time));
        try {
            JSONObject body = new JSONObject()
                .put("code", code).put("name", name).put("model", model).put("manufacturer", manufacturer)
                .put("os", "Android " + android.os.Build.VERSION.RELEASE).put("sdk", android.os.Build.VERSION.SDK_INT)
                .put("appVersion", BuildConfig.VERSION_NAME).put("appCode", BuildConfig.VERSION_CODE).put("locale", locale)
                .put("signKey", signKey).put("encKey", encKey).put("fcmToken", fcmToken == null ? "" : fcmToken)
                .put("time", time).put("proof", Crypto.b64(proof));
            return json(send(normalize(base) + "/api/android/enroll", "POST", Crypto.utf8(body.toString()), null, null, 1 << 20));
        } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    /* -------------------------------------------------------------- signed */

    public byte[] signed(String method, String path, JSONObject body, Progress progress, long max) throws IOException, GeneralSecurityException {
        byte[] raw = body == null ? new byte[0] : Crypto.utf8(body.toString());
        String base = config.server();
        String basePath = new URL(base).getPath();
        JSONObject headers = signHeaders(config.deviceId(), method, basePath + path, raw, System.currentTimeMillis());
        return send(base + path, method, method.equals("GET") ? null : raw, headers, progress, max);
    }

    public JSONObject checkin(JSONObject body) throws IOException, GeneralSecurityException {
        return json(signed("POST", "/api/android/checkin", body, null, 4 << 20));
    }

    public void ack(String id, boolean ok, Object result, String error) throws IOException, GeneralSecurityException {
        try {
            signed("POST", "/api/android/ack", new JSONObject().put("id", id).put("ok", ok).put("result", result == null ? JSONObject.NULL : result).put("error", error == null ? "" : error), null, 1 << 20);
        } catch (JSONException e) { throw new IllegalStateException(e); }
    }

    public void events(JSONArray events) throws IOException, GeneralSecurityException {
        try { signed("POST", "/api/android/events", new JSONObject().put("events", events), null, 1 << 20); }
        catch (JSONException e) { throw new IllegalStateException(e); }
    }

    public byte[] bundle(String id, Progress p) throws IOException, GeneralSecurityException {
        return signed("GET", "/api/android/bundles/" + id, null, p, 80L << 20);
    }

    public JSONObject release(String id) throws IOException, GeneralSecurityException {
        return json(signed("GET", "/api/android/releases/" + id, null, null, 1 << 20));
    }

    public byte[] apk(String id, Progress p) throws IOException, GeneralSecurityException {
        return signed("GET", "/api/android/releases/" + id + "/apk", null, p, 400L << 20);
    }

    /** ICE servers for WebRTC (/api/turn, public). */
    public JSONObject turn() throws IOException {
        return json(send(config.server() + "/api/turn", "GET", null, null, null, 1 << 20));
    }
}
