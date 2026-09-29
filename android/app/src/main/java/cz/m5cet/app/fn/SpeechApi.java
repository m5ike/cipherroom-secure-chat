package cz.m5cet.app.fn;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.Executor;
import java.util.function.Consumer;

/**
 * The server's speech (the server-side part of client/src/lib/speech.ts;
 * server/ai/routes.ts): which voices and transcription models this user may
 * use, text to speech, speech to text. The web sends these without the
 * account; here they carry it, so the account's groups decide (the server
 * reads it on every one of them).
 */
public final class SpeechApi {
    /** A voice or a transcription model: its id (the connector) and label. */
    public static final class Connector {
        public final String id;
        public final String label;
        Connector(String id, String label) { this.id = id; this.label = label; }
    }

    public static final class Status {
        public final boolean tts;
        public final List<Connector> voices;
        public final boolean stt;
        public final List<Connector> transcribers;

        Status(boolean tts, List<Connector> voices, boolean stt, List<Connector> transcribers) {
            this.tts = tts;
            this.voices = Collections.unmodifiableList(voices);
            this.stt = stt;
            this.transcribers = Collections.unmodifiableList(transcribers);
        }
    }

    public static final Status NONE = new Status(false, Collections.emptyList(), false, Collections.emptyList());

    /** Synthesised speech: the bytes and their type (audio/mpeg unless the server says otherwise). */
    public static final class Audio {
        public final byte[] bytes;
        public final String mime;
        Audio(byte[] bytes, String mime) { this.bytes = bytes; this.mime = mime; }
    }

    private final String base;

    public SpeechApi(String base) { this.base = base; }

    /** GET /api/speech/status; a failure is "nothing". */
    public Api.Call status(String bearer, Executor ex, Consumer<Status> done) {
        return Api.json(base, "/api/speech/status", bearer, null, ex, new Api.Callback<JSONObject>() {
            @Override public void ok(JSONObject j) {
                JSONObject t = j.optJSONObject("tts");
                JSONObject s = j.optJSONObject("stt");
                done.accept(new Status(t != null && Boolean.TRUE.equals(t.opt("enabled")), connectors(t), s != null && Boolean.TRUE.equals(s.opt("enabled")), connectors(s)));
            }

            @Override public void fail(Api.Failure f) { done.accept(NONE); }
        });
    }

    private static List<Connector> connectors(JSONObject o) {
        List<Connector> out = new ArrayList<>();
        JSONArray a = o == null ? null : o.optJSONArray("connectors");
        for (int i = 0; a != null && i < a.length(); i++) {
            JSONObject c = a.optJSONObject(i);
            if (c != null && c.opt("id") instanceof String) out.add(new Connector(c.optString("id"), c.opt("label") instanceof String ? c.optString("label") : c.optString("id")));
        }
        return out;
    }

    /** POST /api/speech/tts { text, connector?, voice? } (null: the server's choice). */
    public Api.Call tts(String bearer, String text, String connector, String voice, Executor ex, Api.Callback<Audio> cb) {
        JSONObject body;
        try {
            body = new JSONObject().put("text", text);
            if (connector != null) body.put("connector", connector);
            if (voice != null) body.put("voice", voice);
        } catch (JSONException e) { throw new IllegalStateException(e); }
        return Api.json(base, "/api/speech/tts", bearer, body, ex, new Api.Callback<JSONObject>() {
            @Override public void ok(JSONObject j) {
                String b64 = j.opt("audioBase64") instanceof String ? j.optString("audioBase64") : "";
                if (b64.isEmpty()) { cb.fail(new Api.Failure(200, "", "HTTP 200")); return; }
                byte[] bytes;
                try { bytes = Base64.getDecoder().decode(b64); }
                catch (IllegalArgumentException e) { cb.fail(new Api.Failure(200, "bad-answer", "not base64 audio")); return; }
                String mime = j.opt("mime") instanceof String && !j.optString("mime").isEmpty() ? j.optString("mime") : "audio/mpeg";
                cb.ok(new Audio(bytes, mime));
            }

            @Override public void fail(Api.Failure f) { cb.fail(f); }
        });
    }

    /** POST /api/speech/stt: 16 kHz mono 16-bit WAV in (as the web sends it), the transcript out. */
    public Api.Call stt(String bearer, byte[] wav, String connector, Executor ex, Api.Callback<String> cb) {
        String path = "/api/speech/stt";
        try { if (connector != null && !connector.isEmpty()) path += "?connector=" + URLEncoder.encode(connector, "UTF-8").replace("+", "%20"); }
        catch (UnsupportedEncodingException e) { throw new IllegalStateException(e); }
        // Transcription takes its time: two minutes before giving up.
        return Api.request(base, path, bearer, wav, "audio/wav", 120_000, ex, new Api.Callback<JSONObject>() {
            @Override public void ok(JSONObject j) { cb.ok(j.opt("text") instanceof String ? j.optString("text") : ""); }
            @Override public void fail(Api.Failure f) { cb.fail(f); }
        });
    }
}
