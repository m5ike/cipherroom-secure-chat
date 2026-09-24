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
