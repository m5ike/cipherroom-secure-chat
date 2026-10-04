// The TSA editor's palette (6.9): every tool a call flow can use — its group,
// look, ports and parameters. One table the console's editor draws from
// (GET /admin/telephony/tsa/catalog), the validator checks against and the
// runtime executes; see types.ts for how ports work. Pure data.
//
// Parameter kinds
//   text       one line            textarea   several lines (a template: {IN1}, {$name}, {call.from})
//   number     min / max / step    bool       a switch
//   select     options             digits     dial-pad characters 0-9 * # A-D (and "w" = 0.5 s pause)
//   formula    formula.ts syntax   key        one of "#", "*", "none", "any"
//   voice      a voice of the chosen speech provider (the editor asks the AI & speech console)
//   tsa        another TSA's id    trunk      a SIP trunk's id      model   a Functions model's id
//   list       a list of strings (one per line)

import type { TsaNodeType } from "./types";

export type TsaParamKind = "text" | "textarea" | "number" | "bool" | "select" | "digits" | "formula" | "key" | "voice" | "tsa" | "trunk" | "model" | "list";

export type TsaParamDef = {
  key: string;
  label: string;
  kind: TsaParamKind;
  default?: unknown;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
  /** Shown under the field. */
  help?: string;
  required?: boolean;
  /** Only shown when another parameter has this value ({ key: value | values[] }). */
  when?: Record<string, unknown>;
  placeholder?: string;
};

export type TsaPortDef = { port: string; label: string; help?: string };

export type TsaToolDef = {
  type: TsaNodeType;
  group: "call" | "audio" | "input" | "logic" | "integration";
  label: string;
  /** One line in the palette. */
  summary: string;
  /** Longer help (the editor's side panel). */
  help: string;
  /** Lucide icon name (the console's icon set). */
  icon: string;
  /** Canvas shape: "box" (default), "wide" (a long rectangle — condition), "pill" (start / end). */
  shape?: "box" | "wide" | "pill";
  /** Accent token of the console's theme. */
  accent: "primary" | "success" | "warning" | "danger" | "info" | "muted";
  /** Has the control input "in" (every tool but start). */
  flowIn: boolean;
  /** Control outputs, in order (left to right on the bottom edge). */
  flowOut: TsaPortDef[];
  /** Dynamic data inputs IN1 … IN<n> on the top edge: how many a new node gets, and the bounds. */
  dynamicInputs?: { initial: number; min: number; max: number };
  /** Fixed data inputs on the top edge (after the dynamic ones). */
  dataIn?: TsaPortDef[];
  /** Data outputs (right edge). */
  dataOut?: TsaPortDef[];
  params: TsaParamDef[];
  /** Switch: the flow outputs come from a parameter (one "case_<n>" per line of `cases`, then "default"). */
  dynamicFlowOut?: { param: string; prefix: string; plus: TsaPortDef[] };
};

const opt = (...values: string[]) => values.map((v) => ({ value: v, label: v }));
const TEMPLATE_HELP = "{IN1} … {IN100} are the inputs, {$name} a variable, {call.from} / {call.to} / {call.did} the call.";
const NEXT: TsaPortDef = { port: "next", label: "next" };
const FAILED: TsaPortDef = { port: "on_failed", label: "on_failed", help: "The step could not be done (provider error, nothing to play, a refused request)." };
const DYN = (initial = 1, min = 0, max = 100) => ({ initial, min, max });

export const TSA_CATALOG: TsaToolDef[] = [
  /* ================================================================ call */
  {
    type: "start", group: "call", label: "Start", icon: "phone-incoming", shape: "pill", accent: "success", flowIn: false,
    summary: "Where the call enters the TSA.",
    help: "Every TSA has exactly one Start. Its data outputs describe the call: who calls (from), the number called (to), the DID the inbound rule matched, the direction and the provider.",
    flowOut: [NEXT],
    dataOut: [
      { port: "from", label: "from" }, { port: "to", label: "to" }, { port: "did", label: "did" },
      { port: "direction", label: "direction" }, { port: "provider", label: "provider" }, { port: "call_id", label: "call_id" },
    ],
    params: [
      { key: "answer", label: "Answer the call", kind: "bool", default: true, help: "Off: the next tools run before the call is answered (early media where the provider supports it)." },
      { key: "language", label: "Default language", kind: "select", default: "cs-CZ", options: opt("cs-CZ", "sk-SK", "en-US", "en-GB", "de-DE", "pl-PL", "fr-FR", "es-ES", "it-IT"), help: "Text to speech, speech to text and number reading use it unless a tool says otherwise." },
      { key: "maxMinutes", label: "Longest call (minutes)", kind: "number", default: 60, min: 1, max: 240 },
    ],
  },
  {
    type: "hangup", group: "call", label: "Hang up / state", icon: "phone-off", shape: "pill", accent: "danger", flowIn: true, flowOut: [],
    summary: "Ends the call — or refuses it with a state.",
    help: "hangup ends an answered call. busy, congestion and rejected refuse an inbound call that has not been answered yet (the caller hears the busy tone, the network's congestion tone, or the call is declined); after an answer they hang up.",
    params: [
      { key: "as", label: "End as", kind: "select", default: "hangup", options: [
        { value: "hangup", label: "hangup" }, { value: "busy", label: "busy" }, { value: "congestion", label: "congestion" }, { value: "rejected", label: "rejected" },
      ] },
    ],
  },
  {
    type: "dial", group: "call", label: "Dial / transfer", icon: "phone-forwarded", accent: "primary", flowIn: true,
    summary: "Connects the caller to a number or a SIP address.",
    help: "Dials a phone number (E.164) or a SIP URI and bridges the caller to it — through the provider's application or through a SIP trunk, with your caller ID. When the other side hangs up, the flow continues by how the dial ended. Every dial goes through the module's outbound checks (countries — none set: only your own —, blocked numbers, the outbound rules, the hourly budget) and lasts at most Permissions › Longest call (6.10). " + TEMPLATE_HELP,
    flowOut: [
      { port: "on_answered", label: "on_answered", help: "Answered; continues after that call ends." },
      { port: "on_busy", label: "on_busy" }, { port: "on_no_answer", label: "on_no_answer" }, FAILED,
    ],
    dynamicInputs: DYN(0),
    dataOut: [{ port: "status", label: "status" }, { port: "duration", label: "duration" }],
    params: [
      { key: "kind", label: "Destination", kind: "select", default: "number", options: [{ value: "number", label: "phone number" }, { value: "sip", label: "SIP URI" }] },
      { key: "to", label: "To", kind: "text", required: true, placeholder: "+420… or {IN1}", help: TEMPLATE_HELP },
      { key: "via", label: "Route through", kind: "select", default: "rules", options: [
        { value: "rules", label: "the outbound rules" }, { value: "app", label: "the provider's application" }, { value: "trunk", label: "a SIP trunk" },
      ] },
      { key: "trunk", label: "SIP trunk", kind: "trunk", when: { via: "trunk" } },
      { key: "callerIdNumber", label: "Caller ID number", kind: "text", placeholder: "+420… (empty: the called DID)", help: "Shown to the person dialled. The provider may require a number you own or verified." },
      { key: "callerIdName", label: "Caller ID name", kind: "text", help: "Where the network carries a name (SIP trunks, some carriers)." },
      { key: "timeout", label: "Ring for (s)", kind: "number", default: 30, min: 5, max: 120 },
      { key: "record", label: "Record the bridged call", kind: "bool", default: false },
    ],
  },
  {
    type: "pause", group: "call", label: "Pause", icon: "pause", accent: "muted", flowIn: true, flowOut: [NEXT],
    summary: "Silence for a while.", help: "The caller hears silence (or the provider's comfort noise).",
    params: [{ key: "seconds", label: "Seconds", kind: "number", default: 1, min: 0.5, max: 60, step: 0.5 }],
  },
  {
    type: "send_dtmf", group: "call", label: "Send DTMF", icon: "grid-3x3", accent: "primary", flowIn: true, flowOut: [NEXT, FAILED],
    summary: "Plays dial-pad tones into the call.",
    help: "Sends digits to the other side — an extension behind a switchboard, a PIN. w = half a second's pause. " + TEMPLATE_HELP,
    dynamicInputs: DYN(0),
    params: [
      { key: "digits", label: "Digits", kind: "digits", required: true, placeholder: "1w2#  or {IN1}" },
      { key: "type", label: "Type", kind: "select", default: "rfc2833", options: [
        { value: "rfc2833", label: "RFC 2833 / 4733 (out of band)" }, { value: "inband", label: "in-band tones" }, { value: "sip-info", label: "SIP INFO" },
      ], help: "What the provider supports: Twilio and Vonage send RFC 2833; in-band and SIP INFO only over a SIP trunk that does." },
      { key: "toneMs", label: "Tone length (ms)", kind: "number", default: 250, min: 100, max: 500 },
    ],
  },

  /* =============================================================== audio */
  {
    type: "tts", group: "audio", label: "Text to speech", icon: "volume-2", accent: "primary", flowIn: true, flowOut: [NEXT, FAILED],
    summary: "Speaks a text to the caller.",
    help: "Every {IN1} … {IN100} in the text is replaced by that input's value. The provider's own voice is the cheapest and fastest; an AI & speech provider (ElevenLabs, OpenAI, Piper…) is played as audio. " + TEMPLATE_HELP,
    dynamicInputs: DYN(1),
    params: [
      { key: "text", label: "Text to speak", kind: "textarea", required: true, placeholder: "Your code is {IN1}." },
      { key: "language", label: "Language", kind: "select", default: "", options: [{ value: "", label: "(the Start's)" }, ...opt("cs-CZ", "sk-SK", "en-US", "en-GB", "de-DE", "pl-PL", "fr-FR", "es-ES", "it-IT")] },
      { key: "provider", label: "Speech provider", kind: "select", default: "telephony", options: [
        { value: "telephony", label: "the call's provider (built-in voices)" }, { value: "ai", label: "AI & speech (the console's TTS)" },
      ] },
      { key: "voice", label: "Voice", kind: "voice", help: "Empty: the provider's default for the language." },
      { key: "rate", label: "Speed", kind: "number", default: 1, min: 0.5, max: 2, step: 0.05 },
      { key: "pitch", label: "Pitch", kind: "number", default: 0, min: -10, max: 10, step: 1, when: { provider: "ai" } },
      { key: "volume", label: "Volume (dB)", kind: "number", default: 0, min: -12, max: 12, step: 1 },
      { key: "loop", label: "Repeat", kind: "number", default: 1, min: 1, max: 10 },
      { key: "bargeIn", label: "A key press stops it", kind: "bool", default: true, help: "With a Read DTMF right after, the caller may type while it speaks." },
    ],
  },
  {
    type: "play", group: "audio", label: "Play audio", icon: "play", accent: "primary", flowIn: true, flowOut: [NEXT, FAILED],
    summary: "Plays a recording, a file or a stream.",
    help: "url: an https address the provider fetches (MP3 / WAV). file: an audio file uploaded in the console (served to the provider from this server). stream: a live https stream (radio, hold music) for a number of seconds. " + TEMPLATE_HELP,
    dynamicInputs: DYN(0),
    params: [
      { key: "source", label: "Source", kind: "select", default: "url", options: [{ value: "url", label: "URL" }, { value: "file", label: "file" }, { value: "stream", label: "stream" }] },
      { key: "url", label: "URL", kind: "text", placeholder: "https://… or {IN1}", when: { source: ["url", "stream"] } },
      { key: "file", label: "File", kind: "text", help: "An uploaded file's id (Telephony › Files).", when: { source: "file" } },
      { key: "seconds", label: "Play for (s)", kind: "number", default: 30, min: 1, max: 3600, when: { source: "stream" } },
      { key: "loop", label: "Repeat", kind: "number", default: 1, min: 1, max: 100 },
      { key: "bargeIn", label: "A key press stops it", kind: "bool", default: false },
    ],
  },
  {
    type: "record", group: "audio", label: "Record", icon: "mic", accent: "warning", flowIn: true,
    summary: "Records what the caller says.",
    help: "Records until the time is up, the caller presses the end key or stays silent. The recording is kept with the call (Telephony › Log) for the retention period; optionally transcribed.",
    flowOut: [NEXT, { port: "on_timeout", label: "on_timeout", help: "Nothing was said." }, FAILED],
    dataOut: [{ port: "url", label: "url" }, { port: "recording_id", label: "recording_id" }, { port: "duration", label: "duration" }, { port: "digit", label: "digit" }, { port: "transcript", label: "transcript" }],
    params: [
      { key: "maxSeconds", label: "Longest (s)", kind: "number", default: 60, min: 1, max: 3600 },
      { key: "finishOnKey", label: "End key", kind: "key", default: "#" },
      { key: "silenceSeconds", label: "Stop after silence (s)", kind: "number", default: 5, min: 0, max: 60, help: "0: do not stop on silence." },
      { key: "beep", label: "Beep before", kind: "bool", default: true },
      { key: "trim", label: "Trim silence", kind: "bool", default: true },
      { key: "transcribe", label: "Transcribe", kind: "bool", default: false },
      { key: "language", label: "Transcription language", kind: "select", default: "", options: [{ value: "", label: "(the Start's)" }, ...opt("cs-CZ", "sk-SK", "en-US", "en-GB", "de-DE", "pl-PL")], when: { transcribe: true } },
    ],
  },
  {
    type: "stt", group: "audio", label: "Speech to text", icon: "audio-lines", accent: "warning", flowIn: true,
    summary: "Listens and turns the caller's words into text.",
    help: "Listens to one utterance (until silence) and transcribes it — with the provider's own recognition or AI & speech. The text goes to the data output; use it in a Condition (contains(IN1, \"yes\")) or a Switch.",
    flowOut: [NEXT, { port: "on_timeout", label: "on_timeout", help: "Nothing was said." }, FAILED],
    dataOut: [{ port: "text", label: "text" }, { port: "confidence", label: "confidence" }],
    params: [
      { key: "language", label: "Language", kind: "select", default: "", options: [{ value: "", label: "(the Start's)" }, ...opt("cs-CZ", "sk-SK", "en-US", "en-GB", "de-DE", "pl-PL", "fr-FR", "es-ES", "it-IT")] },
      { key: "provider", label: "Recognition", kind: "select", default: "telephony", options: [
        { value: "telephony", label: "the call's provider" }, { value: "ai", label: "AI & speech (the console's STT)" },
      ] },
      { key: "maxSeconds", label: "Longest (s)", kind: "number", default: 15, min: 1, max: 120 },
      { key: "silenceSeconds", label: "End of speech after (s)", kind: "number", default: 1.5, min: 0.5, max: 10, step: 0.5 },
      { key: "timeout", label: "Wait for speech (s)", kind: "number", default: 5, min: 1, max: 60 },
      { key: "hints", label: "Expected words", kind: "list", help: "One per line — helps the recognizer (yes, no, sales, support…)." },
    ],
  },
  {
    type: "route_audio", group: "audio", label: "Route audio", icon: "radio-tower", accent: "success", flowIn: true,
    summary: "Connects the call's audio to a room or a member by a route code.",
    help: "KEY is a 4–6 digit code (usually from a Read DTMF). The code is looked up in the inroute table (m5.telephony.inroute.add); when it exists and has not expired, the call's audio is routed both ways — to the whole room or only to the member it names. on_success follows when the call ends after it was routed.",
    flowOut: [
      { port: "on_success", label: "on_success", help: "The right code; the audio was routed (continues when the routed audio ends)." },
      { port: "on_code_error", label: "on_code_error", help: "No such code, expired, or not 4–6 digits." },
      { port: "on_failed", label: "on_failed", help: "The code is right but the audio cannot be routed (nobody connected, the provider cannot stream)." },
    ],
    dataIn: [{ port: "KEY", label: "KEY", help: "The route code, 4–6 digits." }],
    dataOut: [{ port: "type", label: "type" }, { port: "target", label: "target" }],
    params: [
      { key: "consume", label: "One use only", kind: "bool", default: false, help: "On: the code is removed once routed (a one-time code)." },
      { key: "announce", label: "Say when connected", kind: "text", default: "", placeholder: "Connecting you." },
      { key: "mode", label: "When nobody can take audio", kind: "select", default: "fail", options: [
        { value: "fail", label: "on_failed" }, { value: "text", label: "text mode (speech ↔ chat messages)" },
      ] },
    ],
  },

  /* =============================================================== input */
  {
    type: "read_dtmf", group: "input", label: "Read DTMF", icon: "keyboard", accent: "primary", flowIn: true,
    summary: "Waits for digits on the dial pad.",
    help: "Collects up to the given number of digits; the termination key ends early (and is not part of the result). A TTS or Play right before, with 'a key press stops it', lets the caller type while it speaks.",
    flowOut: [NEXT, { port: "on_timeout", label: "on_timeout", help: "No digit within the timeout." }],
    dataOut: [{ port: "digits", label: "digits" }],
    params: [
      { key: "maxDigits", label: "Max digits", kind: "number", default: 1, min: 1, max: 32 },
      { key: "finishOnKey", label: "Termination key", kind: "key", default: "#" },
      { key: "timeout", label: "Timeout (s)", kind: "number", default: 5, min: 1, max: 60, help: "For the first digit, and between digits." },
      { key: "prompt", label: "Prompt (spoken)", kind: "textarea", default: "", help: "Optional: spoken while waiting (the Start's language, the provider's voice). " + TEMPLATE_HELP },
      { key: "retries", label: "Ask again on timeout", kind: "number", default: 0, min: 0, max: 5 },
    ],
  },

  /* =============================================================== logic */
  {
    type: "condition", group: "logic", label: "Condition", icon: "git-branch", shape: "wide", accent: "info", flowIn: true,
    summary: "Branches on a formula over its inputs.",
    help: "Add as many inputs as you need (IN1, IN2, …) on the top edge. The formula decides: (IN1 == IN2), (IN1 == 0 and IN2 > 2), contains(IN1, \"yes\"), len(IN1) >= 4. True goes to on_true, false to on_false.",
    flowOut: [{ port: "on_true", label: "on_true" }, { port: "on_false", label: "on_false" }],
    dynamicInputs: DYN(2, 0, 100),
    params: [{ key: "formula", label: "Formula", kind: "formula", required: true, placeholder: "IN1 == IN2" }],
  },
  {
    type: "switch", group: "logic", label: "Switch", icon: "split", accent: "info", flowIn: true,
    summary: "One output per value (an IVR menu).",
    help: "Compares IN1 with each case (one per line: 1, 2, 3 — or words for speech) and follows the matching case_<n>; nothing matched → default.",
    flowOut: [],
    dynamicFlowOut: { param: "cases", prefix: "case_", plus: [{ port: "default", label: "default" }] },
    dataIn: [{ port: "IN1", label: "IN1", help: "The value to compare." }],
    params: [
      { key: "cases", label: "Cases", kind: "list", default: ["1", "2", "3"], required: true },
      { key: "match", label: "Match", kind: "select", default: "equals", options: [
        { value: "equals", label: "equals" }, { value: "contains", label: "contains (speech)" }, { value: "prefix", label: "starts with" },
      ] },
      { key: "ignoreCase", label: "Ignore case and accents", kind: "bool", default: true },
    ],
  },
  {
    type: "for", group: "logic", label: "For", icon: "repeat", accent: "info", flowIn: true,
    summary: "Repeats its body from … to … by a step.",
    help: "body runs once for every value of index (from, to inclusive, by step — each may be a formula over the inputs); then done. A body path that ends returns here; Break leaves early.",
    flowOut: [{ port: "body", label: "body" }, { port: "done", label: "done" }],
    dynamicInputs: DYN(0),
    dataOut: [{ port: "index", label: "index" }],
    params: [
      { key: "from", label: "From", kind: "formula", default: "1" },
      { key: "to", label: "To", kind: "formula", default: "3" },
      { key: "step", label: "Step", kind: "formula", default: "1" },
    ],
  },
  {
    type: "while", group: "logic", label: "While", icon: "refresh-cw", accent: "info", flowIn: true,
    summary: "Repeats its body while a formula holds.",
    help: "The formula is checked before each round; body runs while it is true, then done. Max rounds stops a loop that never ends.",
    flowOut: [{ port: "body", label: "body" }, { port: "done", label: "done" }],
    dynamicInputs: DYN(1),
    dataOut: [{ port: "index", label: "index" }],
    params: [
      { key: "formula", label: "While", kind: "formula", required: true, placeholder: "IN1 != \"1234\"" },
      { key: "maxRounds", label: "Max rounds", kind: "number", default: 3, min: 1, max: 1000 },
    ],
  },
  {
    type: "break", group: "logic", label: "Break", icon: "corner-down-right", shape: "pill", accent: "muted", flowIn: true, flowOut: [],
    summary: "Leaves the innermost loop (through its done).", help: "Outside a loop it ends the TSA's flow like a dead end.", params: [],
  },
  {
    type: "set", group: "logic", label: "Set variable", icon: "variable", accent: "muted", flowIn: true, flowOut: [NEXT],
    summary: "Stores a value as $name.",
    help: "The formula's value (over the inputs and other variables) is kept as $name for the rest of the call: formulas see $name, texts {$name}.",
    dynamicInputs: DYN(1),
    dataOut: [{ port: "value", label: "value" }],
    params: [
      { key: "name", label: "Variable", kind: "text", required: true, placeholder: "attempts" },
      { key: "value", label: "Value (formula)", kind: "formula", required: true, placeholder: "$attempts + 1" },
    ],
  },
  {
    type: "formula", group: "logic", label: "Formula", icon: "sigma", accent: "muted", flowIn: true, flowOut: [NEXT],
    summary: "Computes a value from its inputs.",
    help: "Numbers, text, comparisons, and / or / not, + - * / %, and the functions len, int, num, str, lower, upper, trim, contains, startswith, endswith, digits, substr, replace, min, max, abs, round, now, hour, weekday, random.",
    dynamicInputs: DYN(2),
    dataOut: [{ port: "value", label: "value" }],
    params: [{ key: "formula", label: "Formula", kind: "formula", required: true, placeholder: "IN1 * 2 + IN2" }],
  },
  {
    type: "text", group: "logic", label: "Text", icon: "type", accent: "muted", flowIn: true, flowOut: [NEXT],
    summary: "Builds a text from a template.", help: TEMPLATE_HELP,
    dynamicInputs: DYN(1),
    dataOut: [{ port: "text", label: "text" }],
    params: [
      { key: "template", label: "Template", kind: "textarea", required: true, placeholder: "Call from {IN1}" },
      { key: "spellDigits", label: "Read numbers digit by digit", kind: "bool", default: false, help: "1234 → 1 2 3 4 (for TTS)." },
    ],
  },
  {
    type: "time_condition", group: "logic", label: "Opening hours", icon: "clock", accent: "info", flowIn: true,
    summary: "Open or closed by day and time.",
    help: "True (on_true) inside the hours in the time zone, false (on_false) outside and on the listed dates.",
    flowOut: [{ port: "on_true", label: "open" }, { port: "on_false", label: "closed" }],
    params: [
      { key: "timezone", label: "Time zone", kind: "text", default: "Europe/Prague" },
      { key: "days", label: "Days", kind: "text", default: "mon-fri", help: "mon-fri, sat, sun — or a list: mon,wed,fri." },
      { key: "from", label: "From", kind: "text", default: "08:00" },
      { key: "to", label: "To", kind: "text", default: "17:00" },
      { key: "closedOn", label: "Closed on (dates)", kind: "list", help: "One per line: 2026-12-24, 12-25 (every year)." },
    ],
  },

  /* ========================================================= integration */
  {
    type: "sms", group: "integration", label: "Send SMS", icon: "message-square-text", accent: "primary", flowIn: true, flowOut: [NEXT, FAILED],
    summary: "Sends an SMS (to the caller by default).", help: "Through the module's outbound checks, as the TSA: the countries (none set: only your own — the caller's number can be faked), the blocked numbers, the hourly SMS budget. " + TEMPLATE_HELP,
    dynamicInputs: DYN(1),
    params: [
      { key: "to", label: "To", kind: "text", default: "{call.from}" },
      { key: "text", label: "Text", kind: "textarea", required: true },
      { key: "from", label: "From", kind: "text", placeholder: "(the outbound rule / provider default)" },
    ],
  },
  {
    type: "room_message", group: "integration", label: "Message to a room", icon: "message-circle", accent: "primary", flowIn: true, flowOut: [NEXT, FAILED],
    summary: "Posts a notice into a room (or to one member).",
    help: "A server notice in the room — e.g. 'missed call from {call.from}', a voicemail's transcript. The room is a blind room id (r3.…) or the room of an inroute code. " + TEMPLATE_HELP,
    dynamicInputs: DYN(1),
    params: [
      { key: "target", label: "Where", kind: "select", default: "room", options: [{ value: "room", label: "a room" }, { value: "inroute", label: "the room of an inroute code (IN1)" }] },
      { key: "room", label: "Room (blind id)", kind: "text", placeholder: "r3.…", when: { target: "room" } },
      { key: "member", label: "Only to member", kind: "text", help: "Empty: everyone in the room." },
      { key: "text", label: "Text", kind: "textarea", required: true },
    ],
  },
  {
    type: "http", group: "integration", label: "HTTP request", icon: "globe", accent: "primary", flowIn: true,
    summary: "Calls a web service (a CRM, a ticket system).",
    help: "Only https, only to hosts the permissions allow (Telephony › Permissions › TSA). The answer's status, body and parsed JSON become outputs (json.path in a formula: get(IN1, \"customer.name\")). " + TEMPLATE_HELP,
    flowOut: [{ port: "on_success", label: "on_success", help: "2xx answer." }, FAILED],
    dynamicInputs: DYN(1),
    dataOut: [{ port: "status", label: "status" }, { port: "body", label: "body" }, { port: "json", label: "json" }],
    params: [
      { key: "method", label: "Method", kind: "select", default: "GET", options: opt("GET", "POST", "PUT", "PATCH", "DELETE") },
      { key: "url", label: "URL", kind: "text", required: true, placeholder: "https://crm.example.com/api/caller?n={call.from}" },
      { key: "headers", label: "Headers", kind: "list", help: "One per line: Name: value. A token or password goes in as {secret:NAME} — the server's TSA_SECRET_NAME; written out it is readable in the console and in exports, and the TSA cannot be published (6.10)." },
      { key: "body", label: "Body", kind: "textarea", when: { method: ["POST", "PUT", "PATCH"] } },
      { key: "timeout", label: "Timeout (s)", kind: "number", default: 5, min: 1, max: 15 },
    ],
  },
  {
    type: "function", group: "integration", label: "Run function", icon: "square-function", accent: "primary", flowIn: true,
    summary: "Runs a Functions model with the inputs.",
    help: "Runs the model's execute entry with inputs { in1, in2, … , call } and waits (up to the timeout) for its result, which becomes the output. The model sees m5.caller.kind = \"telephony\".",
    flowOut: [NEXT, FAILED],
    dynamicInputs: DYN(1),
    dataOut: [{ port: "result", label: "result" }],
    params: [
      { key: "model", label: "Model", kind: "model", required: true },
      { key: "timeout", label: "Timeout (s)", kind: "number", default: 10, min: 1, max: 60 },
    ],
  },
  {
    type: "lookup", group: "integration", label: "Number info", icon: "search", accent: "muted", flowIn: true, flowOut: [NEXT],
    summary: "What the server knows about a number (offline).",
    help: "Country, line type (mobile, landline, toll-free, premium…), formats — from the built-in numbering plans; no paid lookup.",
    dataIn: [{ port: "IN1", label: "IN1", help: "The number (default: the caller)." }],
    dataOut: [{ port: "country", label: "country" }, { port: "type", label: "type" }, { port: "national", label: "national" }, { port: "e164", label: "e164" }, { port: "valid", label: "valid" }],
    params: [],
  },
  {
    type: "inroute_add", group: "integration", label: "Add route code", icon: "key-round", accent: "success", flowIn: true, flowOut: [NEXT, FAILED],
    summary: "Creates an inroute code (like m5.telephony.inroute.add).",
    help: "Adds a 4–6 digit code to the inroute table: a later call that types it (Route audio) gets connected to the room or the member. Code empty = a random free one.",
    dynamicInputs: DYN(0),
    dataOut: [{ port: "code", label: "code" }, { port: "expires", label: "expires" }],
    params: [
      { key: "code", label: "Code", kind: "text", placeholder: "(random) or {IN1}" },
      { key: "digits", label: "Digits of a random code", kind: "number", default: 6, min: 4, max: 6 },
      { key: "type", label: "Route to", kind: "select", default: "room", options: [{ value: "room", label: "the whole room" }, { value: "user", label: "one member" }] },
      { key: "room", label: "Room (blind id)", kind: "text", required: true, placeholder: "r3.…" },
      { key: "user", label: "Member", kind: "text", when: { type: "user" } },
      { key: "ttl", label: "Valid for (s)", kind: "number", default: 600, min: 30, max: 86400 },
    ],
  },
  {
    type: "log", group: "integration", label: "Log", icon: "scroll-text", accent: "muted", flowIn: true, flowOut: [NEXT],
    summary: "Writes a line to the call's log.", help: TEMPLATE_HELP,
    dynamicInputs: DYN(1),
    params: [
      { key: "level", label: "Level", kind: "select", default: "info", options: opt("info", "notice", "warn", "error") },
      { key: "text", label: "Text", kind: "textarea", required: true },
    ],
  },
];

export const TSA_GROUPS: Array<{ id: TsaToolDef["group"]; label: string }> = [
  { id: "call", label: "Call" }, { id: "audio", label: "Audio" }, { id: "input", label: "Input" },
  { id: "logic", label: "Logic" }, { id: "integration", label: "Integration" },
];

const BY_TYPE = new Map(TSA_CATALOG.map((t) => [t.type, t]));
export function toolOf(type: string): TsaToolDef | undefined { return BY_TYPE.get(type as TsaNodeType); }

/** The flow outputs a node has (a Switch's come from its cases). */
export function flowOutputs(type: string, params: Record<string, unknown>): TsaPortDef[] {
  const t = toolOf(type);
  if (!t) return [];
  if (!t.dynamicFlowOut) return t.flowOut;
  const raw = params[t.dynamicFlowOut.param];
  const cases = Array.isArray(raw) ? raw.map(String).filter((s) => s.trim() !== "") : [];
  return [...cases.map((c, i) => ({ port: `${t.dynamicFlowOut!.prefix}${i + 1}`, label: c })), ...t.dynamicFlowOut.plus];
}

/** The data inputs a node has: IN1 … IN<inputs> (dynamic) then the fixed ones. */
export function dataInputs(type: string, inputs: number | undefined): TsaPortDef[] {
  const t = toolOf(type);
  if (!t) return [];
  const n = t.dynamicInputs ? Math.max(t.dynamicInputs.min, Math.min(t.dynamicInputs.max, inputs ?? t.dynamicInputs.initial)) : 0;
  const dyn = Array.from({ length: n }, (_, i) => ({ port: `IN${i + 1}`, label: `IN${i + 1}` }));
  return [...dyn, ...(t.dataIn ?? [])];
}

/** A new node's parameters: every default. */
export function defaultParams(type: string): Record<string, unknown> {
  const t = toolOf(type);
  const out: Record<string, unknown> = {};
  for (const p of t?.params ?? []) if (p.default !== undefined) out[p.key] = Array.isArray(p.default) ? [...p.default] : p.default;
  return out;
}
