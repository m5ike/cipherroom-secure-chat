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
  // 5.3: results as lists, entry points, m5.model, browser code.
  {
    id: "results", title: "10 · Several results at once", lang: "js",
    body: "An entry function may return **one output or a list of them**. Every item of the list is shown, played or run — each on its own: text, a table, a notice, a sound, a button… If one item is broken, the others still show; the broken one is logged and handed to the model's **error** entry point.\n\nA plain object with a known `type` and its key is an output too (`{ type: \"flash\", text: \"…\" }`); a list of plain data is one JSON value.",
    sample: "export async function execute() {\n  return [\n    m5.out.markdown(\"# Three things\"),\n    m5.out.table([\"n\", \"square\"], [1, 2, 3].map((n) => [n, n * n])),\n    { type: \"flash\", text: \"All done\", level: \"success\" },\n  ];\n}\n",
    expect: "Three things",
  },
  {
    id: "buttons", title: "11 · Buttons and the button entry point", lang: "js",
    body: "`m5.out.button({ name, title, data })` draws a button. A click runs the model's **button** entry point — here the `button` function of the same file — with `{ name, data, event }`, in the same **processing session** (`m5.model`).\n\nRun it, then click **Count** in the result: each click adds to a value kept in `m5.model.session`, which lives as long as this conversation with the model.",
    sample: "export async function execute() {\n  return [m5.out.markdown(\"Click to count\"), m5.out.button({ name: \"count\", title: \"Count\", data: { by: 1 }, css: \"primary\", icon: \"➕\" })];\n}\n\nexport async function button({ name, data }) {\n  const n = ((await m5.model.session.get(\"n\")) || 0) + data.by;\n  await m5.model.session.set(\"n\", n);\n  return [m5.out.markdown(`Clicked **${n}×** — this is call ${m5.model.call} (the first was ${m5.model.first.type})`), m5.out.button({ name, title: \"Again\", data })];\n}\n",
    expect: "Click to count",
  },
  {
    id: "forms", title: "12 · Forms", lang: "js",
    body: "`m5.out.form({ name, title, fields | panels })` draws a form — text, numbers, dates, e-mail, masked values, selects with icons, switches…, grouped in **panels** laid out in rows or columns. Sending it runs the **form** entry point with `{ name, values }`.\n\n**Tools › Form builder** in the editor draws a form with the mouse and writes the code.",
    sample: "export async function execute() {\n  return m5.out.form({\n    name: \"order\", title: \"Order\", submit: \"Send\",\n    panels: [{ title: \"You\", layout: \"columns\", columns: 2, fields: [\n      { name: \"email\", type: \"email\", label: \"E-mail\", required: true },\n      { name: \"size\", type: \"select\", label: \"Size\", default: \"m\", options: [{ value: \"s\", label: \"Small\", icon: \"🥤\" }, { value: \"m\", label: \"Medium\", icon: \"🧋\" }] },\n    ] }],\n  });\n}\n\nexport async function form({ name, values }) {\n  return m5.out.table([\"field\", \"value\"], Object.entries(values), { title: `Form ${name}` });\n}\n",
  },
  {
    id: "model", title: "13 · m5.model — the conversation", lang: "js",
    body: "Every call that follows from one start is one **processing session**: `m5.model.calls` lists them — `{ type, parms, result, status, err_msg, http }` — with `calls[0]` always the first (**execute** or a **webhook**). `m5.model.current` is this call, `m5.model.last` the one before.\n\nIn the chat, a **reply** to the model's message runs its **response** entry point (the reply's text is `text`).",
    sample: "export async function execute({ topic = \"DNS\" }) {\n  return m5.out.markdown(`Tell me more about **${topic}** — reply to this message.`);\n}\n\nexport async function response({ text }) {\n  const first = m5.model.first;\n  return m5.out.json({ youSaid: text, firstTopic: first.parms.topic, calls: m5.model.calls.map((c) => c.type) });\n}\n",
    inputs: { topic: "DNS" },
    expect: "DNS",
  },
  {
    id: "browser", title: "14 · Code in the browser", lang: "js",
    body: "`m5.out.js(code, args)` runs JavaScript in the **viewer's browser**, in a sandbox that cannot reach the app. Inside: `m5.args`, `m5.root`, `m5.flash()`, `m5.send(name, data)` (→ the button entry point), `m5.submit(name, values)` (→ the form one), `m5.play()`. `hidden: true` makes it an effect that runs once.\n\nIn the console the result shows the code with **Run in a sandbox**.",
    sample: "export async function execute() {\n  const code = `\n    const b = document.createElement(\"button\");\n    b.textContent = \"Pick \" + m5.args.item;\n    b.onclick = () => m5.send(\"pick\", { item: m5.args.item });\n    m5.root.append(b);\n  `;\n  return [m5.out.markdown(\"A widget:\"), m5.out.js(code, { item: \"🍎\" })];\n}\n\nexport async function button({ name, data }) {\n  return m5.out.flash(`You picked ${data.item}`, \"success\");\n}\n",
    expect: "A widget",
  },
  {
    id: "errors", title: "15 · The error entry point", lang: "js",
    body: "When an entry point fails — it throws, runs out of time, returns something that is not an output — or the browser cannot show a result, the model's **error** entry point runs with `{ error, failed, source }` and its answer is shown instead of a bare failure. Its own failures are only logged (nothing loops).",
    sample: "export async function execute() {\n  throw new Error(\"the database is asleep\");\n}\n\nexport async function error({ error, failed, source }) {\n  m5.log.warn(\"handled\", { failed: failed.type, source });\n  return m5.out.flash(`Sorry — ${error.message}. Try again later.`, \"warning\");\n}\n",
  },
  {
    id: "results-py", title: "16 · Several results in Python", lang: "py",
    body: "The same in **Python**: return a list; every entry point is a function of its type (`button`, `form`, `response`, `error`) taking keyword arguments — add `**inputs` to accept the rest.",
    sample: "async def execute(**inputs):\n    return [\n        m5.out.markdown(\"# From Python\"),\n        m5.out.button({\"name\": \"hi\", \"title\": \"Say hi\"}),\n    ]\n\nasync def button(name, data=None, event=None, **inputs):\n    return m5.out.flash(\"Hi from \" + m5.model.type, \"success\")\n",
    expect: "From Python",
  },
];

/** The lessons as the console needs them (the sample entry is always `execute`). */
export function tutorialLessons(): Array<Omit<Lesson, never>> {
  return LESSONS;
}
