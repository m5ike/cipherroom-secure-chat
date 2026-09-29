package cz.m5cet.app.fn;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/** Server-Sent Events as the server writes them, arriving in any pieces. */
public class SseTest {
    // (One key per object: org.json on the JVM keeps no order.)
    private static final String STREAM = ": ping\n\n"
        + "event: start\ndata: {\"runId\":\"run_1 Počasí ☀\"}\n\n"
        + ": ping\n\n"
        + "event: progress\ndata: {\"p\":0.5}\n\n"
        + "event: output\ndata:{\"text\":\n"
        + "data: \"a\\n\\nb 😀\"}\n\n"
        + "event: nothing\n\n"
        + "event: broken\ndata: {not json\n\n"
        + "event: scalar\ndata: 5\n\n"
        + "data: {\"plain\":true}\n\n"
        + "event:  done \ndata: {\"outputs\":[]}\n\n"
        + "event: tail\ndata: {\"never\":true}";

    private static final List<String> EXPECTED = List.of(
        "start {\"runId\":\"run_1 Počasí ☀\"}",
        "progress {\"p\":0.5}",
        "output {\"text\":\"a\\n\\nb 😀\"}",
        "message {\"plain\":true}",
        "done {\"outputs\":[]}");

    /** What the parser handed over, as "name data". */
    private static List<String> collect(Sse.Sink[] sink) {
        List<String> out = new ArrayList<>();
        sink[0] = (name, data) -> out.add(name + " " + Js.stringify(data));
        return out;
    }

    @Test
    public void wholeStream() throws IOException {
        Sse.Sink[] sink = new Sse.Sink[1];
        List<String> got = collect(sink);
        new Sse(sink[0]).feed(STREAM);
        assertEquals(EXPECTED, got);
    }

    @Test
    public void textSplitAtEveryPoint() throws IOException {
        for (int cut = 0; cut <= STREAM.length(); cut++) {
            for (int cut2 = cut; cut2 <= STREAM.length(); cut2 += 7) {
                Sse.Sink[] sink = new Sse.Sink[1];
                List<String> got = collect(sink);
                Sse sse = new Sse(sink[0]);
                sse.feed(STREAM.substring(0, cut));
                sse.feed(STREAM.substring(cut, cut2));
                sse.feed(STREAM.substring(cut2));
                assertEquals("cut at " + cut + "/" + cut2, EXPECTED, got);
            }
        }
    }

    /** Bytes in pieces of n — UTF-8 characters split between reads. */
    private static InputStream trickle(byte[] bytes, int n) {
        return new ByteArrayInputStream(bytes) {
            @Override public synchronized int read(byte[] b, int off, int len) { return super.read(b, off, Math.min(len, n)); }
        };
    }

    @Test
    public void bytesSplitInsideCharacters() throws IOException {
        byte[] bytes = STREAM.getBytes(StandardCharsets.UTF_8);
        for (int n = 1; n <= 7; n++) {
            Sse.Sink[] sink = new Sse.Sink[1];
            List<String> got = collect(sink);
            Sse.read(trickle(bytes, n), sink[0]);
            assertEquals("pieces of " + n, EXPECTED, got);
        }
    }

    @Test
    public void aLargeEventInManyPieces() throws IOException {
        String big = "A".repeat(300_000);
        String stream = "event: done\ndata: {\"data\":\"" + big + "\"}\n\n";
        Sse.Sink[] sink = new Sse.Sink[1];
        List<String> got = collect(sink);
        Sse.read(trickle(stream.getBytes(StandardCharsets.UTF_8), 1000), sink[0]);
        assertEquals(List.of("done {\"data\":\"" + big + "\"}"), got);
    }
}
