package cz.m5cet.app.fn;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicInteger;

import cz.m5cet.app.BuildConfig;

/**
 * The HTTP side of the server's app APIs (/api/functions, /api/ai,
 * /api/speech, /api/client-config): JSON requests and Server-Sent Events over
 * a POST. The caller's account is the Authorization header — the value as
 * the account gives it ("Bearer …"), or "" for a guest (no header then).
 *
 * Everything runs on a background thread of its own (a stream may stay open
 * for minutes); results come through the Executor the caller passes. A
 * cancelled call closes its connection and delivers nothing more.
 */
public final class Api {
    private Api() {}

    /** Why a call failed: the HTTP status (0: no answer), the server's code ("" when it gave none) and message. */
    public static final class Failure extends IOException {
        public final int status;
        public final String code;
        public Failure(int status, String code, String message) { super(message); this.status = status; this.code = code; }
    }

    public interface Callback<T> {
        void ok(T value);
        void fail(Failure failure);
    }

    /** What a stream delivers, on the caller's executor: events, then either the end or a failure. */
    interface Stream {
        void event(String name, JSONObject data);
        void end();
        void fail(Failure failure);
    }

    /** A call in flight; cancel() closes its connection. */
    public static final class Call {
        private volatile boolean cancelled;
        private volatile HttpURLConnection conn;

        public void cancel() {
            cancelled = true;
            HttpURLConnection c = conn;
            if (c != null) c.disconnect();
        }

        public boolean cancelled() { return cancelled; }

        void attach(HttpURLConnection c) {
            conn = c;
            if (cancelled) c.disconnect();
        }

        /** Runs r on the executor unless the call was cancelled by then. */
        void deliver(Executor ex, Runnable r) { if (!cancelled) ex.execute(() -> { if (!cancelled) r.run(); }); }
    }

    private static final ExecutorService BG = Executors.newCachedThreadPool(new java.util.concurrent.ThreadFactory() {
        private final AtomicInteger n = new AtomicInteger();
        @Override public Thread newThread(Runnable r) {
            Thread t = new Thread(r, "m5-fn-" + n.incrementAndGet());
            t.setDaemon(true);
            return t;
        }
    });

    static final int MAX_JSON = 64 << 20;

    static String url(String base, String path) {
        String b = base.trim();
        while (b.endsWith("/")) b = b.substring(0, b.length() - 1);
        return b + path;
    }

    private static HttpURLConnection open(Call call, String url, String method, String bearer, int readTimeoutMs) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        call.attach(c);
        c.setRequestMethod(method);
        c.setConnectTimeout(15_000);
        c.setReadTimeout(readTimeoutMs);
        c.setUseCaches(false);
        // A redirect would carry the account's token elsewhere.
        c.setInstanceFollowRedirects(false);
        c.setRequestProperty("User-Agent", "M5cet-Android/" + BuildConfig.VERSION_NAME);
        if (bearer != null && !bearer.isEmpty()) c.setRequestProperty("Authorization", bearer);
        return c;
    }

    private static void send(HttpURLConnection c, byte[] body, String contentType) throws IOException {
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", contentType);
        c.setFixedLengthStreamingMode(body.length);
        try (OutputStream out = c.getOutputStream()) { out.write(body); }
    }

    private static byte[] readAll(InputStream in, int max) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            if (out.size() > max) throw new IOException("the answer is too large");
        }
        return out.toByteArray();
    }

    /** The server's refusal: { ok: false, code, message } when it says so, else "HTTP <status>". */
    private static Failure refusal(HttpURLConnection c, int status) {
        String code = "";
        String message = "HTTP " + status;
        try (InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream()) {
            if (in != null) {
                Object v = Js.parse(new String(readAll(in, 1 << 20), StandardCharsets.UTF_8));
                if (v instanceof JSONObject) {
                    JSONObject o = (JSONObject) v;
                    if (o.opt("code") instanceof String) code = o.optString("code");
                    if (o.opt("message") instanceof String && !o.optString("message").isEmpty()) message = o.optString("message");
                }
            }
        } catch (IOException | JSONException ignored) { }
        return new Failure(status, code, message);
    }

    private static Failure network(IOException e) {
        return e instanceof Failure ? (Failure) e : new Failure(0, "network", e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
    }

    /** A JSON request (body null: GET); a 2xx answer with ok: false is a failure too. */
    static Call json(String base, String path, String bearer, JSONObject body, Executor ex, Callback<JSONObject> cb) {
        byte[] raw = body == null ? null : body.toString().getBytes(StandardCharsets.UTF_8);
        return request(base, path, bearer, raw, "application/json", 60_000, ex, cb);
    }

    /** Raw bytes up (audio), a JSON answer back. */
    static Call request(String base, String path, String bearer, byte[] body, String contentType, int readTimeoutMs, Executor ex, Callback<JSONObject> cb) {
        Call call = new Call();
        BG.execute(() -> {
            HttpURLConnection c = null;
            try {
                c = open(call, url(base, path), body == null ? "GET" : "POST", bearer, readTimeoutMs);
                c.setRequestProperty("Accept", "application/json");
                if (body != null) send(c, body, contentType);
                int status = c.getResponseCode();
                if (status < 200 || status >= 300) { Failure f = refusal(c, status); call.deliver(ex, () -> cb.fail(f)); return; }
                Object v;
                try (InputStream in = c.getInputStream()) { v = Js.parse(new String(readAll(in, MAX_JSON), StandardCharsets.UTF_8)); }
                catch (JSONException e) { throw new Failure(status, "bad-answer", "not a JSON answer"); }
                if (!(v instanceof JSONObject)) throw new Failure(status, "bad-answer", "not a JSON answer");
                JSONObject o = (JSONObject) v;
                if (Boolean.FALSE.equals(o.opt("ok"))) {
                    Failure f = new Failure(status, o.opt("code") instanceof String ? o.optString("code") : "", o.opt("message") instanceof String ? o.optString("message") : "HTTP " + status);
                    call.deliver(ex, () -> cb.fail(f));
                    return;
                }
                call.deliver(ex, () -> cb.ok(o));
            } catch (IOException e) {
                Failure f = network(e);
                call.deliver(ex, () -> cb.fail(f));
            } finally {
                if (c != null) c.disconnect();
            }
        });
        return call;
    }

    /**
     * POSTs body as JSON asking for an event stream. An answer that is not
     * 2xx or not text/event-stream is a failure with the server's code and
     * message; a connection that breaks is a "network" failure.
     */
    static Call stream(String base, String path, String bearer, JSONObject body, Executor ex, Stream s) {
        Call call = new Call();
        BG.execute(() -> {
            HttpURLConnection c = null;
            try {
                // The server pings every 15 s: a minute of silence is a dead connection.
                c = open(call, url(base, path), "POST", bearer, 60_000);
                c.setRequestProperty("Accept", "text/event-stream");
                send(c, body.toString().getBytes(StandardCharsets.UTF_8), "application/json");
                int status = c.getResponseCode();
                String type = c.getContentType();
                if (status < 200 || status >= 300 || type == null || !type.contains("event-stream")) {
                    Failure f = refusal(c, status);
                    call.deliver(ex, () -> s.fail(f));
                    return;
                }
                try (InputStream in = c.getInputStream()) {
                    Sse.read(in, (name, data) -> call.deliver(ex, () -> s.event(name, data)));
                }
                call.deliver(ex, s::end);
            } catch (IOException e) {
                Failure f = network(e);
                call.deliver(ex, () -> s.fail(f));
            } finally {
                if (c != null) c.disconnect();
            }
        });
        return call;
    }

    /** Runs blocking work off the caller's thread (what the calls above use). */
    static void background(Runnable r) { BG.execute(r); }
}
