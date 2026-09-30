package cz.m5cet.app.ui.bubble;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

import cz.m5cet.app.BuildConfig;

/** A plain GET to the app's own server (the map policy, map tiles): no account, no cookies, no cache. */
final class Http {
    private Http() {}

    /** An answer other than 2xx: its status and the server's code ("map-off"…). */
    static final class Refused extends IOException {
        final int status;
        final String code;
        Refused(int status, String code) { super("HTTP " + status + (code.isEmpty() ? "" : " " + code)); this.status = status; this.code = code; }
    }

    static byte[] get(String url, int max) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setConnectTimeout(8_000);
            c.setReadTimeout(12_000);
            c.setUseCaches(false);
            c.setInstanceFollowRedirects(false);
            c.setRequestProperty("User-Agent", "M5cet-Android/" + BuildConfig.VERSION_NAME);
            int status = c.getResponseCode();
            if (status < 200 || status >= 300) {
                String code = "";
                try (InputStream err = c.getErrorStream()) {
                    if (err != null) code = new JSONObject(new String(read(err, 16 * 1024), "UTF-8")).optString("code", "");
                } catch (Exception ignored) { }
                throw new Refused(status, code);
            }
            try (InputStream in = c.getInputStream()) { return read(in, max); }
        } finally {
            c.disconnect();
        }
    }

    private static byte[] read(InputStream in, int max) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            if (out.size() > max) throw new IOException("the answer is too large");
        }
        return out.toByteArray();
    }
}
