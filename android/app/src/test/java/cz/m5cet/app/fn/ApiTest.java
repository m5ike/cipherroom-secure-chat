package cz.m5cet.app.fn;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** The calls over real HTTP (an in-process server): headers, bodies, streams, failures, cancelling. */
public class ApiTest {
    private static final Executor NOW = Runnable::run;
    private ServerSocket server;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final Map<String, Handler> routes = new ConcurrentHashMap<>();
    private String base;
    /** The last request per route: its Authorization header ("-" when none), Content-Type, query and body. */
    private final Map<String, String[]> seen = new ConcurrentHashMap<>();
    private final AtomicInteger commandCalls = new AtomicInteger();
    private final CountDownLatch streamClosed = new CountDownLatch(1);

    /** Answers a request on out (HTTP/1.1, the connection closes after it). */
    private interface Handler { void handle(OutputStream out, String body) throws Exception; }

    private void route(String prefix, Handler h) { routes.put(prefix, h); }

    /** A little HTTP server (android.jar hides the JDK's): one request per connection. */
    private void serve(Socket s) {
        try (Socket sock = s) {
            InputStream in = sock.getInputStream();
            String[] request = line(in).split(" ");
            Map<String, String> headers = new HashMap<>();
            for (String h = line(in); !h.isEmpty(); h = line(in)) headers.put(h.substring(0, h.indexOf(':')).trim().toLowerCase(Locale.ROOT), h.substring(h.indexOf(':') + 1).trim());
            String body = new String(in.readNBytes(Integer.parseInt(headers.getOrDefault("content-length", "0"))), StandardCharsets.UTF_8);
            String target = request[1];
            String path = target.contains("?") ? target.substring(0, target.indexOf('?')) : target;
            String key = null;
            for (String prefix : routes.keySet()) if (path.startsWith(prefix) && (key == null || prefix.length() > key.length())) key = prefix;
            OutputStream out = sock.getOutputStream();
            if (key == null) { respond(out, 404, "text/html", "<h1>Not found</h1>"); return; }
            seen.put(key, new String[] { headers.getOrDefault("authorization", "-"), String.valueOf(headers.get("content-type")), target.contains("?") ? target.substring(target.indexOf('?') + 1) : "null", body });
            routes.get(key).handle(out, body);
        } catch (Exception ignored) {
            // the app went away
        }
    }

    private static String line(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        for (int c = in.read(); c >= 0 && c != '\n'; c = in.read()) if (c != '\r') sb.append((char) c);
        return sb.toString();
    }

    private static void respond(OutputStream out, int status, String type, String body) throws IOException {
        byte[] b = body.getBytes(StandardCharsets.UTF_8);
        out.write(("HTTP/1.1 " + status + " X\r\nContent-Type: " + type + "\r\nContent-Length: " + b.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
        out.write(b);
        out.flush();
    }

    private static void json(OutputStream out, int status, String json) throws IOException { respond(out, status, "application/json; charset=utf-8", json); }

    private static OutputStream events(OutputStream out) throws IOException {
        out.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
        out.flush();
        return out;
    }

    private static void send(OutputStream out, String s) throws IOException {
        out.write(s.getBytes(StandardCharsets.UTF_8));
        out.flush();
    }

    @Before
    public void start() throws IOException {
        server = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        route("/api/functions/run", (ex, body) -> {
            OutputStream out = events(ex);
            send(out, ": ping\n\nevent: start\ndata: {\"runId\":\"run_1\"}\n\n");
            send(out, "event: progress\ndata: {\"p\":1,\"text\":\"ž\"}\n\nevent: done\ndata: {\"runId\":\"run_1\",\"status\":\"done\",\"outputs\":[{\"type\":\"text\",\"text\":\"hi\"}],\"visibility\":\"caller\"}\n\n");
        });
        route("/api/functions/event", (ex, body) -> {
            OutputStream out = events(ex);
            send(out, "event: start\ndata: {\"runId\":\"run_2\"}\n\n");
            // Pings until the app goes away (a write then fails).
            try { for (int i = 0; i < 100; i++) { Thread.sleep(50); send(out, ": ping\n\n"); } }
            catch (IOException closed) { streamClosed.countDown(); }
        });
        route("/api/functions/commands", (ex, body) -> {
            commandCalls.incrementAndGet();
            json(ex, 200, "{\"ok\":true,\"enabled\":true,\"commands\":[{\"keyword\":\"dns\",\"name\":\"DNS\",\"summary\":\"\",\"inputs\":[{\"name\":\"name\",\"type\":\"hostname\",\"required\":true}],\"events\":[\"button\"],\"model\":\"m1\"}]}");
        });
        route("/api/functions/runs/", (ex, body) -> json(ex, 200, "{\"ok\":true}"));
        route("/api/ai/status", (ex, body) -> json(ex, 200, "{\"ok\":true,\"enabled\":true,\"state\":\"ready\",\"default\":\"p/b\",\"models\":[{\"ref\":\"p/a\",\"label\":\"A\",\"reasoning\":true},{\"ref\":\"p/b\",\"label\":\"B\"}],\"limits\":{\"maxInputChars\":100}}"));
        route("/api/ai/chat", (ex, body) -> {
            if (new JSONObject(body).getJSONArray("messages").length() >= 3) { json(ex, 429, "{\"ok\":false,\"code\":\"rate\",\"message\":\"slow down\"}"); return; }
            OutputStream out = events(ex);
            send(out, "event: delta\ndata: {\"text\":\"Ahoj\"}\n\nevent: reasoning\ndata: {\"text\":\"hm\"}\n\nevent: delta\ndata: {\"text\":\" světe\"}\n\n");
            send(out, "event: done\ndata: {\"text\":\"Ahoj světe\",\"ms\":1200,\"usage\":{\"input\":3,\"output\":7}}\n\n");
        });
        route("/api/speech/tts", (ex, body) -> json(ex, 200, "{\"ok\":true,\"audioBase64\":\"" + Base64.getEncoder().encodeToString(new byte[] { 1, 2, 3 }) + "\",\"mime\":\"audio/wav\"}"));
        route("/api/speech/stt", (ex, body) -> json(ex, 200, "{\"ok\":true,\"text\":\"slyším " + body.length() + "\"}"));
        pool.execute(() -> {
            while (!server.isClosed()) {
                try { Socket s = server.accept(); pool.execute(() -> serve(s)); } catch (IOException closed) { return; }
            }
        });
        base = "http://127.0.0.1:" + server.getLocalPort() + "/";
    }

    @After
    public void stop() throws IOException {
        server.close();
        pool.shutdownNow();
    }

    /** Listener → a queue of what it heard. */
    private static Run.Listener listener(BlockingQueue<String> q) {
        return new Run.Listener() {
            @Override public void start(String runId) { q.add("start " + runId); }
            @Override public void progress(double p, String text) { q.add("progress " + p + " " + text); }
            @Override public void done(Run.Done d) { q.add("done " + d.outputs.length() + " " + d.visibility); }
            @Override public void error(String code, String message) { q.add("error " + code + " " + message); }
        };
    }

    @Test
    public void runStreamsWithTheAccount() throws Exception {
        BlockingQueue<String> q = new LinkedBlockingQueue<>();
        Commands commands = new Commands(base);
        commands.run("Bearer tok", "dns", null, new JSONObject().put("name", "a.cz"), new Run.Origin(null, "dev1", "cs", "Europe/Prague"), listener(q), NOW);
        assertEquals("start run_1", q.poll(5, TimeUnit.SECONDS));
        assertEquals("progress 1.0 ž", q.poll(5, TimeUnit.SECONDS));
        assertEquals("done 1 caller", q.poll(5, TimeUnit.SECONDS));
        String[] req = seen.get("/api/functions/run");
        assertEquals("Bearer tok", req[0]);
        assertEquals("application/json", req[1]);
        OutputsTest.same("{\"keyword\":\"dns\",\"inputs\":{\"name\":\"a.cz\"},\"room\":null,\"client\":\"dev1\",\"lang\":\"cs\",\"tz\":\"Europe/Prague\",\"stream\":true}", new JSONObject(req[3]));
    }

    @Test
    public void cancellingClosesTheConnection() throws Exception {
        BlockingQueue<String> q = new LinkedBlockingQueue<>();
        JSONObject meta = new JSONObject("{\"keyword\":\"demo\",\"model\":\"m1\",\"chain\":\"chn_1\",\"call\":2}");
        Api.Call call = new Commands(base).event("", meta, Commands.button("go", null), new Run.Origin("room1", "", "en", null), listener(q), NOW);
        assertEquals("start run_2", q.poll(5, TimeUnit.SECONDS));
        call.cancel();
        assertTrue("the server saw the connection close", streamClosed.await(5, TimeUnit.SECONDS));
        assertNull(q.poll(300, TimeUnit.MILLISECONDS));
        String[] req = seen.get("/api/functions/event");
        assertEquals("-", req[0]);
        OutputsTest.same("{\"model\":\"m1\",\"keyword\":\"demo\",\"chain\":\"chn_1\",\"call\":2,\"room\":\"room1\",\"client\":null,\"lang\":\"en\",\"type\":\"button\",\"name\":\"go\",\"stream\":true}", new JSONObject(req[3]));
    }

    @Test
    public void failuresCarryTheServersWords() throws Exception {
        BlockingQueue<String> q = new LinkedBlockingQueue<>();
        new Commands(base + "nothing-here").run("", "x", null, null, new Run.Origin(null, null, "en", null), listener(q), NOW);
        assertEquals("error error HTTP 404", q.poll(5, TimeUnit.SECONDS));
        new Commands("http://127.0.0.1:1").run("", "x", null, null, new Run.Origin(null, null, "en", null), listener(q), NOW);
        assertTrue(q.poll(5, TimeUnit.SECONDS).startsWith("error network "));
    }

    @Test
    public void theCommandListIsKeptTenSecondsPerAccount() throws Exception {
        Commands commands = new Commands(base);
        BlockingQueue<Commands.State> q = new LinkedBlockingQueue<>();
        assertNull(commands.state("Bearer a").enabled);
        commands.refresh("Bearer a", false, NOW, q::add);
        Commands.State s = q.poll(5, TimeUnit.SECONDS);
        assertTrue(s.enabled);
        assertEquals("m1", s.find("dns").model);
        assertEquals(List.of("button"), s.find("dns").events);
        commands.refresh("Bearer a", false, NOW, q::add);
        q.poll(5, TimeUnit.SECONDS);
        assertEquals(1, commandCalls.get());
        commands.refresh("Bearer a", true, NOW, q::add);
        q.poll(5, TimeUnit.SECONDS);
        assertEquals(2, commandCalls.get());
        assertNull(commands.state("Bearer b").enabled);
        commands.refresh("Bearer b", false, NOW, q::add);
        q.poll(5, TimeUnit.SECONDS);
        assertEquals(3, commandCalls.get());
        assertEquals("Bearer b", seen.get("/api/functions/commands")[0]);

        commands.answer("Bearer a", "run 1", "int_1", new JSONObject().put("a", "b"));
        for (int i = 0; i < 50 && seen.get("/api/functions/runs/") == null; i++) Thread.sleep(20);
        OutputsTest.same("{\"interactionId\":\"int_1\",\"value\":{\"a\":\"b\"}}", new JSONObject(seen.get("/api/functions/runs/")[3]));
    }

    @Test
    public void theAssistantKeepsTheConversation() throws Exception {
        Assistant ai = new Assistant(base);
        BlockingQueue<Object> q = new LinkedBlockingQueue<>();
        ai.setModel("p/a");
        ai.loadStatus("Bearer t", NOW, q::add);
        Assistant.Status st = (Assistant.Status) q.poll(5, TimeUnit.SECONDS);
        assertEquals("ready", st.state);
        assertEquals(100, st.maxInputChars);
        assertEquals(2048, st.maxOutputTokens);
        assertEquals("p/a", ai.model());
        ai.setReasoning("high");
        Assistant.Listener l = new Assistant.Listener() {
            @Override public void changed(Assistant.Turn answer) { }
            @Override public void finished(Assistant.Turn answer) { q.add(answer); }
        };
        assertTrue(ai.send("Bearer t", " Ahoj? ", NOW, l));
        Assistant.Turn t = (Assistant.Turn) q.poll(5, TimeUnit.SECONDS);
        assertEquals("Ahoj světe", t.text);
        assertEquals("hm", t.reasoning);
        assertEquals(7, t.outputTokens);
        OutputsTest.same("{\"model\":\"p/a\",\"reasoning\":\"high\",\"messages\":[{\"role\":\"user\",\"content\":\"Ahoj?\"}],\"stream\":true}", new JSONObject(seen.get("/api/ai/chat")[3]));
        // The second question carries the first with its answer; a refusal is the server's code.
        assertTrue(ai.send("Bearer t", "A dál?", NOW, l));
        Assistant.Turn second = (Assistant.Turn) q.poll(5, TimeUnit.SECONDS);
        assertEquals("rate", second.errorCode);
        assertEquals("slow down", second.errorMessage);
        JSONArray sent = new JSONObject(seen.get("/api/ai/chat")[3]).getJSONArray("messages");
        assertEquals(3, sent.length());
        assertEquals("Ahoj světe", sent.getJSONObject(1).getString("content"));
        // A failed answer and its question are left out of the next one.
        assertTrue(ai.send("Bearer t", "Třetí", NOW, l));
        q.poll(5, TimeUnit.SECONDS);
        JSONArray third = new JSONObject(seen.get("/api/ai/chat")[3]).getJSONArray("messages");
        assertEquals(3, third.length());
        assertEquals("Třetí", third.getJSONObject(2).getString("content"));
        assertFalse(ai.send("Bearer t", "   ", NOW, l));
        assertEquals("Ahoj světe", ai.lastAnswer().text);
        assertEquals(6, ai.turns().size());
    }

    @Test
    public void speech() throws Exception {
        SpeechApi speech = new SpeechApi(base);
        BlockingQueue<Object> q = new LinkedBlockingQueue<>();
        speech.tts("Bearer t", "Ahoj", "p/v", null, NOW, new Api.Callback<SpeechApi.Audio>() {
            @Override public void ok(SpeechApi.Audio a) { q.add(a); }
            @Override public void fail(Api.Failure f) { q.add(f); }
        });
        SpeechApi.Audio a = (SpeechApi.Audio) q.poll(5, TimeUnit.SECONDS);
        assertArrayEquals(new byte[] { 1, 2, 3 }, a.bytes);
        assertEquals("audio/wav", a.mime);
        OutputsTest.same("{\"text\":\"Ahoj\",\"connector\":\"p/v\"}", new JSONObject(seen.get("/api/speech/tts")[3]));
        speech.stt("", "RIFF1234".getBytes(StandardCharsets.US_ASCII), "p/w x", NOW, new Api.Callback<String>() {
            @Override public void ok(String text) { q.add(text); }
            @Override public void fail(Api.Failure f) { q.add(f); }
        });
        assertEquals("slyším 8", q.poll(5, TimeUnit.SECONDS));
        String[] req = seen.get("/api/speech/stt");
        assertEquals("audio/wav", req[1]);
        assertEquals("connector=p%2Fw%20x", req[2]);
    }
}
