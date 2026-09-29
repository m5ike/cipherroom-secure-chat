package cz.m5cet.app.fn;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

/** A run's stream told to the listener, and the message its outputs become (showFnResult() in App.tsx). */
public class RunTest {
    private static final class Heard implements Run.Listener {
        final List<String> events = new ArrayList<>();
        Run.Done done;
        Run.Interaction asked;

        @Override public void start(String runId) { events.add("start " + runId); }
        @Override public void progress(double p, String text) { events.add("progress " + p + " " + text); }
        @Override public void output(JSONObject o) { events.add("output " + o.optString("type")); }
        @Override public void interaction(Run.Interaction i) { asked = i; events.add("interaction " + i.kind + " " + i.id); }
        @Override public void done(Run.Done d) { done = d; events.add("done " + d.status); }
        @Override public void error(String code, String message) { events.add("error " + code + " " + message); }
    }

    @Test
    public void theStreamInOrderThenOneEnd() throws Exception {
        Heard h = new Heard();
        Api.Stream s = Run.stream(h);
        s.event("start", new JSONObject("{\"runId\":\"run_1\"}"));
        s.event("progress", new JSONObject("{\"runId\":\"run_1\",\"type\":\"progress\",\"p\":0.5,\"text\":\"half\"}"));
        s.event("log", new JSONObject("{\"msg\":\"x\"}"));
        s.event("interaction", new JSONObject("{\"runId\":\"run_1\",\"id\":\"int_1\",\"kind\":\"form\",\"spec\":{\"title\":\"T\",\"fields\":[{\"name\":\"a\",\"required\":true,\"values\":[\"x\",\"y\"]},{\"label\":\"no name\"}]}}"));
        s.event("output", new JSONObject("{\"type\":\"text\",\"text\":\"hi\"}"));
        s.event("done", new JSONObject("{\"ok\":true,\"runId\":\"run_1\",\"status\":\"done\",\"outputs\":[{\"type\":\"text\",\"text\":\"hi\"}],\"error\":null,\"visibility\":\"room\",\"chain\":\"chn_1\",\"call\":0}"));
        s.event("error", new JSONObject("{\"code\":\"late\",\"message\":\"ignored\"}"));
        s.end();
        assertEquals(List.of("start run_1", "progress 0.5 half", "interaction form int_1", "output text", "done done"), h.events);
        assertEquals("T", h.asked.title());
        assertEquals(1, h.asked.fields().size());
        assertTrue(h.asked.fields().get(0).required);
        assertEquals(List.of("x", "y"), h.asked.fields().get(0).values);
        assertEquals("run_1", h.asked.runId);
        assertFalse(h.done.failedUnanswered());
        assertEquals(Integer.valueOf(0), h.done.call);
    }

    @Test
    public void failuresAndAStreamThatStops() throws Exception {
        Heard a = new Heard();
        Run.stream(a).fail(new Api.Failure(404, "no-command", "No such command, or it is not available to you."));
        assertEquals(List.of("error no-command No such command, or it is not available to you."), a.events);
        Heard b = new Heard();
        Run.stream(b).fail(new Api.Failure(502, "", "HTTP 502"));
        assertEquals(List.of("error error HTTP 502"), b.events);
        Heard c = new Heard();
        Api.Stream s = Run.stream(c);
        s.event("error", new JSONObject("{\"code\":\"expired\",\"message\":\"over\"}"));
        s.end();
        assertEquals(List.of("error expired over"), c.events);
        Heard d = new Heard();
        Run.stream(d).end();
        assertEquals("error incomplete The answer stopped before it was complete.", d.events.get(0));
    }

    @Test
    public void theMessageOfARun() throws Exception {
        Run.Done d = new Run.Done(new JSONObject("{\"runId\":\"r\",\"status\":\"done\",\"outputs\":[{\"type\":\"markdown\",\"text\":\"**hi**\"},"
            + "{\"type\":\"image\",\"mime\":\"image/png\",\"data\":\"" + "A".repeat(800_000) + "\"}],\"error\":null,\"visibility\":\"room\","
            + "\"chain\":\"chn_1\",\"call\":2,\"model\":\"m1\",\"keyword\":\"demo\",\"name\":\"Demo\",\"events\":[\"button\",\"form\"]}"));
        Run.Message m = d.message("fallback", "Fallback", "caller");
        assertTrue(m.room);
        assertEquals("**hi**\n\n_(image: image/png)_", m.text);
        OutputsTest.same("{\"keyword\":\"demo\",\"name\":\"Demo\",\"model\":\"m1\",\"chain\":\"chn_1\",\"call\":2,\"events\":[\"button\",\"form\"],"
            + "\"outputs\":[{\"type\":\"markdown\",\"text\":\"**hi**\"},{\"type\":\"text\",\"text\":\"(image — too large to share in the room)\"}]}", m.fn);
        assertEquals(2, m.local.getJSONArray("outputs").length());
        assertEquals("image", m.local.getJSONArray("outputs").getJSONObject(1).getString("type"));

        // Only browser code: the command's name is the text; nothing at all: "" (the app says functions.empty).
        Run.Message js = new Run.Done(new JSONObject("{\"outputs\":[{\"type\":\"js\",\"code\":\"x\"}],\"handled\":true,\"error\":null}")).message("demo", "Demo", "caller");
        assertEquals("/demo", js.text);
        assertFalse(js.room);
        OutputsTest.same("{\"keyword\":\"demo\",\"name\":\"Demo\",\"origin\":\"error\",\"outputs\":[{\"type\":\"js\",\"code\":\"x\"}]}", js.fn);
        assertEquals("", new Run.Done(new JSONObject("{\"outputs\":[]}")).message("demo", "Demo", "room").text);
        assertTrue(new Run.Done(new JSONObject("{\"outputs\":[],\"error\":{\"type\":\"Error\",\"message\":\"boom\"}}")).failedUnanswered());
    }

    @Test
    public void aPeersMetadataIsCheckedAgain() throws Exception {
        // The case of test/fn-outputs.test.tsx (validatePayload).
        OutputsTest.same("{\"keyword\":\"demo\",\"name\":\"Demo\",\"chain\":\"chn_abc123def\",\"call\":3,\"events\":[\"button\"],\"outputs\":[{\"type\":\"button\",\"name\":\"go\",\"title\":\"Go\"}]}",
            Run.meta(new JSONObject("{\"keyword\":\"demo\",\"name\":\"Demo\",\"chain\":\"chn_abc123def\",\"call\":3,\"events\":[\"button\",\"hack\",\"button\"],\"outputs\":[{\"type\":\"button\",\"name\":\"go\",\"title\":\"Go\"}]}")));
        OutputsTest.same("{\"keyword\":\"k\",\"name\":\"k\",\"origin\":\"error\"}",
            Run.meta(new JSONObject("{\"keyword\":\"k\",\"model\":\"Bad Model\",\"chain\":\"chn_x\",\"call\":2.5,\"events\":[],\"outputs\":[{\"type\":\"nope\"}],\"origin\":\"error\"}")));
        assertEquals(null, Run.meta(new JSONObject("{\"name\":\"no keyword\"}")));
        assertEquals(null, Run.meta("fn"));
    }
}
