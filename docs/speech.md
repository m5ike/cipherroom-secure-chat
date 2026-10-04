# Speech (TTS / STT / revoice)

Browser-native Web Speech API wrappers. No audio leaves the device.

## Modes

1. **Text → speech (TTS)**: type or paste text and let the browser
   speak it back. Voice/language pickers come from
   `speechSynthesis.getVoices()`.
2. **Speech → text (STT)**: dictate via `SpeechRecognition`. Partial
   results appear live; finalised results append to the text field
   (and optionally to the chat).
3. **Speech → text → speech ("revoice")**: a tick-box on the panel.
   Each finalised STT segment is immediately spoken back through the
   currently selected TTS voice. Useful for quick voice-over edits or
   accessibility experiments.

## Presets

Voices are picked heuristically from the OS-installed list when the
user chooses **male / female / child / neutral**. We bias by name and
adjust pitch/rate where the browser exposes voices that don't match
the preset. This is **not** voice cloning — see below.

## Why we do NOT do voice cloning

True cloning (taking a recorded sample of a specific person and
synthesising new speech in their voice) requires:

- a server-side neural model (e.g. Coqui XTTS, Bark, ElevenLabs API),
- explicit consent from the person whose voice is being cloned,
- bandwidth and storage that don't fit the "no-message-persistence"
  guarantees of M5cet.

If you want to bolt this on for an internal use case, expose a
plug-in over the admin API (`/admin/plugins/...`) that accepts a
sample + consent token, runs the model in your own infrastructure,
and returns synthesized audio bytes. The Speech panel can be extended
to call that plug-in. Do not enable this without a clear consent flow.

## Browser support

- Chrome / Edge (desktop + Android): TTS + STT.
- Safari (desktop + iOS): TTS yes, STT no.
- Firefox: TTS yes, STT no by default.

The panel hides STT controls when the API is missing; TTS controls
remain available.

## API

```ts
import { detectSpeechCaps, listVoices, speak, stopSpeaking, startRecognition } from "@/lib/speech";

const caps = detectSpeechCaps();          // { ttsAvailable, sttAvailable }
const voices = listVoices();              // SpeechSynthesisVoice[]
speak({ text: "Ahoj", lang: "cs-CZ", preset: "female", rate: 1.0 });
const handle = startRecognition("cs-CZ", { onFinal: (t) => console.log(t) });
handle?.stop();
```

## Server voices and transcription (optional, 4.14)

Besides the browser's own speech, the operator can offer server speech:
synthesis (OpenAI `tts-1`…, ElevenLabs voices, any OpenAI-compatible
server) and transcription (OpenAI `whisper-1`…, Hugging Face
`openai/whisper-large-v3`, compatible servers). It is set up in the console
(AI & speech: a provider with a speech model, the Speech switch, the default
model and voice) and tried there (Speech tab). **This audio and text leave
the device**: they go to the server and the operator's provider; the Speech
panel offers them only when the operator turned them on.

- `GET /api/speech/status` — `{ tts: { enabled, connectors: [{ id, label }] }, stt: … }` for this user (their account's groups)
- `POST /api/speech/tts` — `{ text, connector?, voice? }` → `{ audioBase64, mime, connector }`
- `POST /api/speech/stt` — raw audio (or `{ audioBase64, mime, language }`) → `{ text, connector }`

Every call is in the console's journal (who, which model, how long) — never
the audio, and the text only while the owner has content logging on.

## Free, offline server speech (5.1)

The server can also speak and transcribe **without any provider**: a
built-in engine (sherpa-onnx, native, Apache-2.0) runs **Whisper** (speech →
text, 99 languages including Czech) and **Piper** voices (text → speech:
Czech, Slovak, English US/UK, German, Polish, French, Spanish, Italian,
Ukrainian) on the server itself. No account, no key, nothing leaves the
server.

- Console › AI & speech › Speech › *Offline speech*: download a model (one
  click, with progress), try it (▶), remove it. A downloaded model joins the
  “Built-in speech” provider and becomes the default when none is set;
  switch **Speech** on for the app.
- Sizes: Whisper tiny 116 MB, base 208 MB, small 640 MB (good Czech), large-v3
  turbo 564 MB (best, wants a strong CPU); a Piper voice ~21 MB (≈ 60 MB RAM).
- Files: `$DATA_DIR/ai/speech-models/<id>`; unpacking needs `bzip2` (the
  installer and the Docker image add it). Threads: `SPEECH_THREADS` (default 2).
- Audio in: WAV — the app (and the console) convert a recording to 16 kHz mono
  WAV in the browser before uploading; other formats need `ffmpeg` on the
  server. Audio out: WAV.
- Functions use it like any speech model: `m5.ai.tts({ text })`,
  `m5.ai.stt({ audio, mime })`; in the visual builder the *Text → speech* and
  *Speech → text* nodes.

Other free options (console › *More free speech*): **Groq** (free tier,
Whisper large-v3 turbo in the cloud — audio leaves the server), self-hosted
**Speaches** (faster-whisper + Piper/Kokoro), **Kokoro-FastAPI** (natural
voices, no Czech) and a **whisper.cpp** server.

## Dictation that stops, speak and send, the voice changer (6.7)

### Dictation

One state machine on both platforms — `client/src/lib/dictation.ts` (web) and
`android/.../voice/DictationMachine.java` (Android), the same transitions:

    idle ─start→ starting ─(ready)→ listening
    listening ─(the recogniser ended by itself: a pause)→ restarting → starting …
    any ─stop→ stopping ─(last words, end — or the finish time)→ idle
    any ─abort, or a fatal error (no permission, no microphone)→ idle
    (Android) any ─the app speaks→ paused ─resume→ starting

The finish time is 1.5 s on Android (`DictationMachine.java`) and 2 s for the
browser's recogniser (`dictation.ts`); the web's server engine waits up to
120 s for the transcription and does not restart. After too many silent
restarts in a row (6 on the web, 8 on Android) dictation ends with
`dict.err.ended` ("I heard nothing").

A stop always ends it: the recogniser is asked to stop (`rec.stop()` /
`stopListening()`), so the last words still land in the field; a restart that
was pending is cancelled; a recogniser that has not ended within the finish
time is aborted (Android: cancelled and destroyed — each session has its own
`SpeechRecognizer`, so a stopped one cannot keep the microphone); events of an
old session are ignored (a session generation). What stops it: the same
button again, leaving the room (the composer goes away), a voice recording
starting and (Android) the app going to the background. *Send* differs: on
Android it stops, waits for the last words and then sends; on the web sending
(or clearing) the field **aborts** dictation — words still in progress are
dropped (`ComposerVoice.tsx`). Errors are said in words (`dict.err.*`).

Before 6.7: on Android a stop called `cancel()` + `destroy()` on one shared,
reused recogniser (the last words were lost), the composer's icon did not
follow the dictation's real state (a recogniser error left a "stop" icon whose
tap started dictation again), and leaving the screen or sending the app to the
background kept dictating and recording. The web had no dictation in the
composer; the Speech panel's recognition (`speech.ts`) never restarted after
the browser ended it on a pause.

Engines: the browser's Web Speech recogniser; where the browser has none and
the operator offers server transcription (Server-enhanced), the microphone is
recorded (through `mic.ts`) and sent to `/api/speech/stt` when dictation stops.
Android: the phone's recogniser (on the device when it can).

### Speak and send

- **Send the text as voice** — the field's text spoken and sent as an
  end-to-end encrypted voice message exactly like a recorded one (no text goes
  along; before 6.7 the Android clip carried the field's text as a caption).
  Android (`voice/SpeakSend.java`, `ui/parts/ComposerVoice.java`; a long press
  on *Send* or the microphone opens the send options): with an empty field,
  what is dictated now; the phone's TextToSpeech into AAC, or — with *Settings ›
  Voice › On the server* — the operator's speech module (a WAV from Piper is
  re-encoded to AAC). Web (`lib/speak-send.ts`; the send options behind the
  arrow by *Send* or a long press on *Send*, and the Speech panel): only with
  text in the field; the server's voice only — `speechSynthesis` plays straight
  to the speakers and cannot be recorded; without server text-to-speech the
  app says so instead of doing nothing. The server sees the text it speaks
  (the button's hint says so).
- **Speak it, send text** (Android only) — live dictation into the field;
  stopping (■ or *Send*) sends the text as an ordinary message. Without a
  recogniser and with the server's speech chosen: recorded and transcribed by
  the server (before 6.7 this path ran the phone's recogniser on the recording,
  which works only on Android 13+).

### The voice changer

A module of *Modules & groups* — `voiceChanger`, **off until the operator turns
it on** (`offByDefault` in `client/src/lib/modules.ts`: no rule means off; a rule
lets users in by the usual default / group access and grants). Each user then
switches it on for their own client and picks a preset or custom values; the
setting stays on the device (web: `localStorage` `m5cet.voiceFx`; Android:
`voiceFx.*` settings).

Presets (the same names and numbers on both platforms —
`test/fixtures/voice-fx.json` is checked by `test/voice-fx.test.ts` and the JVM
`VoiceFxTest`): off, higher (+4 st / formant +3), lower (−4/−3), deep (−7/−5),
robot (ring modulator 70 Hz), echo (280 ms, feedback 0.45), whisper,
anonymous (−3/−6 + 35 % whisper), custom (pitch, formant, robot Hz, echo mix
and delay, whisper, gain).

The chain (`client/src/lib/voice-fx.ts`, `android/.../voice/VoiceFx.java`):
an STFT phase vocoder (1024-sample frames above 32 kHz — 44.1 and 48 kHz —,
512 below, e.g. 16 kHz; 75 % overlap) divides the spectrum by its smoothed
envelope, shifts the excitation by the pitch ratio and lays it under the
envelope stretched by the formant ratio — pitch and formant move separately;
whisper replaces the excitation with noise; then a ring modulator, a feedback
delay, gain and a soft limiter. The delay is one frame (≈ 21 ms at 48 kHz,
≈ 32 ms for Android's 16 kHz voice messages) and stays the same whatever the
preset, so presets change live without a gap. Cost: not measured on devices;
the unit test only checks that 10 s of 48 kHz audio are processed in under
5 s.

Where it runs — every microphone of the app, on the device, before encoding and
encryption; nothing is sent anywhere for it:

- **Web** — `client/src/lib/mic.ts` is the one place that hands out the
  microphone (calls, voice messages, the phone bridge, server dictation, the
  test). With the module allowed and the switch on, the capture goes through an
  AudioWorklet (`voice-fx.worklet.ts`, served from the app's origin) into a
  `MediaStreamDestination`; the processed track replaces the raw one (switched
  on while a call is running, the call switches over with
  `RTCRtpSender.replaceTrack`; switched off mid-call, the chain becomes
  transparent — same delay, no gap — rather than swapping the track back).
  Stopping the processed track stops the microphone and closes the graph.
  Without AudioWorklet, or when the graph cannot start, the raw microphone is
  used and the panel says why.
- **Android** — `voice/MicFx.java`: voice messages, "speak it, send text"
  recordings and the test pass it in `Audio.Recorder` (PCM before AAC);
  **calls** pass it in the audio buffer callback of WebRTC's
  `JavaAudioDeviceModule` (`Rtc.java` → `CallAudio.onCapture` →
  `MicFx.onCapture`), in place, on the recording thread — so calls are covered
  too. Whether the module is allowed the app learns from the client
  configuration (`FxGate.java`, asked again every 10 minutes).
- **Not covered** — dictation by the browser's or the phone's recogniser: the
  platform listens to the microphone itself and returns only text. On Android
  the hardware echo canceller and noise suppressor (`Rtc.java`) work on the raw
  capture before the callback; how a browser's own echo cancellation combines
  with the changed voice was not measured. Without headphones the other side
  may hear the echo of their own voice changed.

Settings: web *Menu › Tools › Voice changer* (`panel.voiceChanger` layout;
the item shows only when the module is allowed); Android
*Settings › Voice › Voice changer* (`settings.voiceFx`, design area
`server/android/design-67-voice.ts`). *Try it* records 4 s through the same path
and plays them back; nothing is kept.
