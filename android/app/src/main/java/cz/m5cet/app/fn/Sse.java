package cz.m5cet.app.fn;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.Reader;
import java.nio.charset.StandardCharsets;

/**
 * Server-Sent Events as the server writes them ("event: x\ndata: {json}\n\n",
 * ": ping" in between) — a port of readEvents() in client/src/lib/ai.ts: a
 * block ends at a blank line, "event:" names it (default "message"), the
 * "data:" lines joined by "\n" are its JSON; a block without data or with
 * data that is not a JSON object is skipped. Chunks may split anywhere.
 */
public final class Sse {
    public interface Sink { void event(String name, JSONObject data); }

    /** One event may be this large (a run's outputs arrive in one "done"). */
    static final int MAX_BLOCK = 64 << 20;

    private final Sink sink;
    private final StringBuilder buf = new StringBuilder();
    /** Where the search for the next "\n\n" goes on (a large block arrives in many chunks). */
    private int scanned;

    public Sse(Sink sink) { this.sink = sink; }

    /** Adds text as it arrives; hands over every complete block. */
    public void feed(CharSequence chunk) throws IOException {
        buf.append(chunk);
        int at;
        while ((at = buf.indexOf("\n\n", scanned)) >= 0) {
            String block = buf.substring(0, at);
            buf.delete(0, at + 2);
            scanned = 0;
            emit(block);
        }
        scanned = Math.max(0, buf.length() - 1);
        if (buf.length() > MAX_BLOCK) throw new IOException("an event is too large");
    }

    private void emit(String block) {
        String event = "message";
        StringBuilder data = null;
        for (String line : block.split("\n", -1)) {
            if (line.startsWith("event:")) event = Js.trim(line.substring(6));
            else if (line.startsWith("data:")) {
                String d = line.startsWith("data: ") ? line.substring(6) : line.substring(5);
                if (data == null) data = new StringBuilder(d);
                else data.append('\n').append(d);
            }
        }
        if (data == null) return;
        Object v;
        try { v = Js.parse(data.toString()); } catch (JSONException e) { return; }
        if (v instanceof JSONObject) sink.event(event, (JSONObject) v);
    }

    /** Reads a whole stream (UTF-8, decoded across chunk boundaries) until it ends. */
    public static void read(InputStream in, Sink sink) throws IOException {
        Sse sse = new Sse(sink);
        Reader r = new InputStreamReader(in, StandardCharsets.UTF_8);
        char[] chunk = new char[8192];
        int n;
        while ((n = r.read(chunk)) >= 0) if (n > 0) sse.feed(java.nio.CharBuffer.wrap(chunk, 0, n));
    }
}
