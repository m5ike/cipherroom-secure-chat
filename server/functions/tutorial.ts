// The interactive tutorial for the Functions console (4.15/5.0). Each lesson is
// a short Markdown explanation with a runnable sample; the console shows the
// text beside the editor, "Insert sample" loads the code, "Run" executes it in
// a sandbox (an inline test run), and — when the lesson gives `expect` — checks
// that the output contains it. The lessons double as a smoke test of the SDK.

export type Lesson = {
  id: string;
  title: string;
  /** Markdown explanation. */
  body: string;
  lang: "js" | "py";
  /** The sample the "Insert sample" button loads (a single index file). */
  sample: string;
  /** Inputs the "Run" button uses. */
  inputs?: Record<string, unknown>;
  /** A substring the run's output should contain, for the "check". */
  expect?: string;
};

export const LESSONS: Lesson[] = [
  {
    id: "hello", title: "1 · Hello, output", lang: "js",
    body: "Every model exports an `async` function — usually `execute` — that returns an **output**. `m5.out` builds them: `text`, `markdown`, `code`, `table`, `json`, `image`, `file`.\n\nRun the sample; you should see rendered Markdown.",
    sample: "export async function execute() {\n  return m5.out.markdown(\"# Hello!\\nThis is **Markdown** from a function.\");\n}\n",
    expect: "Hello!",
  },
  {
    id: "inputs", title: "2 · Inputs", lang: "js",
    body: "A function receives its **inputs** as one object (in Python, as keyword arguments). The model declares them with types; here we just read one.\n\nThe Run form sends `{ name: \"Mike\" }`.",
    sample: "export async function execute({ name }) {\n  return m5.out.text(`Hi, ${name || \"stranger\"}!`);\n}\n",
    inputs: { name: "Mike" },
    expect: "Hi, Mike",
  },
  {
    id: "log", title: "3 · Logs and progress", lang: "js",
    body: "`m5.log.info/debug/warn/error` write structured log lines you see live under the run. `m5.run.progress(fraction, text)` reports progress. Open the logs after running.",
    sample: "export async function execute() {\n  m5.log.info(\"starting\", { step: 1 });\n  m5.run.progress(0.5, \"halfway\");\n  m5.log.warn(\"careful\");\n  return m5.out.text(\"done — see the logs\");\n}\n",
    expect: "done",
  },
  {
    id: "session-cache", title: "4 · Session and cache", lang: "js",
    body: "`m5.session` keeps values for this model × caller × room (with an optional TTL). `m5.cache` is shared with scopes `run`, `session`, `model`, `global`. Run twice — the counter climbs.",
    sample: "export async function execute() {\n  const n = await m5.cache.incr(\"runs\");\n  await m5.session.set(\"last\", m5.sys.now());\n  return m5.out.json({ runs: n, last: await m5.session.get(\"last\") });\n}\n",
    expect: "runs",
  },
  {
    id: "http", title: "5 · HTTP", lang: "js",
    body: "`m5.http` calls the web from the server (no CORS), with an **SSRF guard** — it refuses private and metadata addresses. It returns `{ status, headers, text, json }`.\n\n_(In the tutorial the call may be blocked if the host has no outbound network.)_",
    sample: "export async function execute() {\n  const r = await m5.http.get(\"https://example.org/\");\n  return m5.out.text(`HTTP ${r.status}, ${r.bytes} bytes`);\n}\n",
    expect: "HTTP",
  },
  {
    id: "codes", title: "6 · Codes", lang: "js",
    body: "`m5.codes` renders QR and many bar codes to SVG or PNG. Pass the SVG to `m5.out.image`.",
    sample: "export async function execute() {\n  const qr = await m5.codes.qr(\"https://chat.fir.ma\", { scale: 5 });\n  return m5.out.image(m5.codec.base64.decode(qr.image.$b), \"image/svg+xml\", { alt: \"QR\" });\n}\n",
    expect: "",
  },
  {
    id: "prompt", title: "7 · Ask the caller", lang: "js",
    body: "`m5.prompt` asks a live question and **waits** for the answer; `m5.form` collects several fields. In the console the question appears as a run interaction. (This works fully from chat.)",
    sample: "export async function execute() {\n  const ok = await m5.prompt({ text: \"Continue?\", choices: [\"yes\", \"no\"] });\n  return m5.out.text(`You chose: ${ok}`);\n}\n",
    expect: "You chose",
  },
  {
    id: "ai", title: "8 · AI", lang: "js",
    body: "`m5.ai.chat` asks the instance's model (counted against its budget). `m5.ai.agent(goal, { tools })` runs a tool-using loop. Needs the AI module on with a model.",
    sample: "export async function execute({ q }) {\n  const r = await m5.ai.chat({ messages: [{ role: \"user\", content: q }] });\n  return m5.out.markdown(r.text);\n}\n",
    inputs: { q: "Say hello in one word." },
    expect: "",
  },
  {
    id: "python", title: "9 · Python", lang: "py",
    body: "The same SDK is available in **Python** (Pyodide), in `snake_case`. The entry function takes the inputs as keyword arguments.",
    sample: "async def execute(name=\"world\"):\n    m5.log.info(\"hello\", name=name)\n    total = sum(range(101))\n    return m5.out.json({\"greeting\": f\"Hi, {name}\", \"sum_0_100\": total})\n",
    inputs: { name: "Mike" },
    expect: "greeting",
  },
];

/** The lessons as the console needs them (the sample entry is always `execute`). */
export function tutorialLessons(): Array<Omit<Lesson, never>> {
  return LESSONS;
}
