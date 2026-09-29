// /help — the guide to the chat's commands: how to call them, every command
// you may use with its parameters and examples, webhooks and the API.
//
//   /help                 overview and the list of commands
//   /help <command>       one command in detail (parameters, examples)
//   /help syntax | webhooks | api | tags | all
//   /help endpoints | results | buttons | forms | browser | model   (5.3)
//   /help android | rooms                                            (6.0)
//   /help ?               pick a command from a list
//
// Entry points (1.1): execute; button — the topic buttons under an answer;
// response — reply to an answer with a command or a topic; error.

const TYPE = { object: "JSON object", array: "JSON list", string: "text", text: "longer text", integer: "whole number", number: "number", boolean: "yes/no", enum: "one of the choices", date: "date (2026-09-29)", time: "time (14:30)", duration: "duration (90s, 5m, 2h)", url: "web address", hostname: "host name", email: "e-mail address", ip: "IP address", json: "JSON", user: "a user", file: "a file" };
const SAMPLE = { string: "hello", text: "\"a few words\"", integer: "5", number: "2.5", boolean: "yes", date: "2026-10-01", time: "14:30", duration: "5m", url: "https://example.com", hostname: "example.com", email: "anna@example.com", ip: "1.1.1.1", json: "'{\"a\":1}'", user: "anna", file: "" };

const table = (cols, rows) => rows.length ? [`| ${cols.join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map((c) => String(c ?? "").replace(/\|/g, "\\|") || "—").join(" | ")} |`)].join("\n") : "_none_";
const sig = (c) => `/${c.keyword}${c.inputs.map((i) => (i.required ? ` <${i.name}>` : ` [${i.name}]`)).join("")}`;
// A value to show: the first example in the parameter's help ("example.com, 1.1.1.1"), a choice, or one of its type.
const sample = (i) => {
  const fromHelp = (/^[^\s,;]+/.exec(String(i.help || "").replace(/^(e\.g\.|např\.)\s*/i, "")) || [])[0];
  if (fromHelp && !/^(a|an|the|or)$/i.test(fromHelp) && /[.:/@\d]/.test(fromHelp)) return fromHelp;
  if (i.type === "enum" && i.values.length) return i.values[Math.min(1, i.values.length - 1)];
  return SAMPLE[i.type] || "value";
};
const quoteIfNeeded = (v) => (/\s/.test(v) && !/^["']/.test(v) ? `"${v}"` : v);

function example(c) {
  const usable = c.inputs.filter((i) => i.type !== "file");
  const req = usable.filter((i) => i.required);
  // Positional: the required ones — or, when none is, the first one.
  const pos = req.length ? req : usable.slice(0, 1);
  const out = [];
  if (!req.length && usable.length) out.push(`/${c.keyword}`);
  out.push(`/${c.keyword}${pos.map((i) => ` ${quoteIfNeeded(sample(i))}`).join("")}`);
  if (usable.length > pos.length || usable.length) out.push(`/${c.keyword} ${usable.slice(0, 3).map((i) => `${i.name}=${quoteIfNeeded(sample(i))}`).join(" ")}`);
  return [...new Set(out)];
}

const SYNTAX = [
  "## ⌨️ How to call a command",
  "- Type **/** at the start of a message: a list of the commands you may use appears; arrows and Enter pick one.",
  "- Arguments follow the command: **positional** in the order of the parameters — `/dns example.com` — or **named** — `/dns name=example.com type=MX`.",
  "- A value with spaces goes in quotes: `/ask question=\"what is DNSSEC?\"`.",
  "- A missing required value is asked for in a small form; a command may also ask you questions while it runs (buttons or a form).",
  "- The output goes **to the room** (everyone sees it) or **only to you**, as the command is set up; in the room it is end-to-end encrypted like any message.",
  "- **@name** mentions someone in the room, **#tag** tags a message — click a tag to see only the messages with it.",
  "- A command's answer can have **buttons** and **forms** — they go back to the same command; **reply** to its message to answer it (if it listens to replies).",
].join("\n");

// 5.3: how a command works inside — for the people who write them (and the curious).
const ENDPOINTS = [
  "## 🚪 Entry points",
  "A command (a *model*) has entry points — functions in its package that answer different calls:",
  "",
  "| Entry point | Runs when | Gets |",
  "| --- | --- | --- |",
  "| **execute** | you type `/command` (also the console, the API, a schedule) | its parameters |",
  "| **response** | someone **replies** to the command's message | `text` (the reply), `message` — and the parameters read from the reply |",
  "| **button** | someone **clicks** a button in its message | `name`, `data`, `event` |",
  "| **form** | someone **sends** a form in its message | `name`, `values`, `event` |",
  "| **error** | another entry point **failed**, or a result could not be shown | `error`, `failed`, `source` |",
  "| **webhook** | an HTTP call to one of its URLs (a command may have several) | the JSON body's fields, `_webhook` |",
  "",
  "execute, response, button, form and error are one each; webhooks as many as needed. Each has its own **inputs** (checked and typed).",
].join("\n");

const MODEL = [
  "## 🧠 m5.model — the conversation with a command",
  "Every call that follows from one start — the replies, clicks, forms, errors — is one **processing session**:",
  "- `m5.model.calls` — every call: `{ type, parms, result, status, err_msg, http }`; `calls[0]` is always the first one (**execute** or a **webhook**), then 1, 2…",
  "- `m5.model.current` — this call (`calls[m5.model.call]`), `m5.model.last` — the one before it, `m5.model.first` — the first",
  "- `m5.model.session` / `m5.model.cache` — values kept for this session only (get, set, delete, keys / incr)",
  "- `http` (a webhook call): its URL, method, `get` (the query) and `post` (the body)",
].join("\n");

const RESULTS = [
  "## 📦 Results",
  "An entry point returns **one output or a list of them** — every item is shown, played or run, each on its own (one that fails does not stop the others; it goes to the **error** entry point and to the log):",
  "- text, Markdown, code, tables, JSON, images, files",
  "- **sound** and **video** (`m5.out.audio`, `m5.out.video`), a **notice** (`m5.out.flash`), an app **panel** (`m5.out.window`)",
  "- **buttons** (`m5.out.button`) and **forms** (`m5.out.form`) — they call the command's button / form entry point",
  "- **browser code** (`m5.out.js`) — JavaScript for your browser, in a sandbox",
  "",
  "```js",
  "return [",
  "  m5.out.markdown(\"# Found 3 records\"),",
  "  m5.out.flash(\"Done\", \"success\"),",
  "  m5.out.button({ name: \"more\", title: \"More\", data: { page: 2 } }),",
  "];",
  "```",
].join("\n");

const BUTTONS = [
  "## 🔘 Buttons",
  "`m5.out.button({ name, title, data, css, icon, confirm, once, style })` — a click runs the command's **button** entry point with `{ name, data, event }` in the same session.",
  "- `css`: primary, secondary, success, danger, warning, info, ghost, outline, link, small, large, block, round",
  "- `icon`: an emoji; `confirm`: asks first; `once`: clickable once; `style`: `{ color, background, border }`",
  "- Buttons next to each other form a row; `m5.out.buttons([...])` makes several at once.",
].join("\n");

const FORMS = [
  "## 📝 Forms",
  "`m5.out.form({ name, title, text, submit, labels, columns, fields | panels, once })` — sending runs the **form** entry point with `{ name, values }`.",
  "- Fields: text, textarea, number, range, tel, email, url, password, date, time, datetime, month, color, **masked** (`mask: \"+{420} 000 000 000\"`), **select** and **multiselect** (options with icons), radio, checkbox, switch, hidden, static, separator",
  "- Each: `label`, `placeholder`, `default`, `required`, `help`, `min`/`max`/`step`, `pattern`, `span` (columns it takes), `labels` (\"top\" or \"left\")",
  "- **panels**: `{ title, layout: \"rows\" | \"columns\", columns, labels, collapsed, fields }` — groups in rows or side by side",
  "The console's **Form builder** (Functions › Tools) draws one and writes the code.",
].join("\n");

const BROWSER = [
  "## 🌐 Code in your browser",
  "`m5.out.js(code, args)` / `await m5.browser.run(code, args)` — JavaScript that runs in the viewer's browser, **in a sandbox** (it cannot reach the app, its storage or its keys). Inside:",
  "- `m5.args`, `m5.root` (an element to draw in), `m5.flash(text, level)`, `m5.play(bytes | url)`",
  "- `m5.send(name, data)` → the command's **button** entry point; `m5.submit(name, values)` → its **form** entry point",
  "- `m5.log(…)` → the run's log; errors go to the **error** entry point",
  "`hidden: true` makes it an effect (runs once, when the message is new); otherwise it is a small widget in the message.",
].join("\n");

const ANDROID = [
  "## 📱 The Android app (6.0)",
  "The same rooms, the same end-to-end encryption as here — a native app. Ask the operator for the server's address or its **QR code** (the camera opens the app directly).",
  "- **Opening it**: a PIN, and your fingerprint or face if the phone has them. Every wrong PIN or rejected finger counts; after the last attempt the operator allows, the app **erases all its data**.",
  "- **Several rooms at once**: tick them in the room list and *Connect selected*; each shows its people and unread messages. Swipe left/right above the chat to move between them.",
  "- **People panel**: floating, or docked left, right or at the bottom; docked, pin it or let it hide behind a small tab.",
  "- Replies straight from notifications, pictures, calls (optionally in the phone's call log), updates of its look without a new install.",
  "Everything it keeps is encrypted with keys in the phone's secure hardware.",
].join("\n");

const ROOMS = [
  "## 🗂️ Several rooms at once (6.0)",
  "- In the **Room** window tick the saved connections you want and choose **Connect selected** — the first comes on screen, the others stay connected in the background.",
  "- The **room bar** shows every connected room with its number of people and **unread** messages; a click brings that room on screen (its messages come with it).",
  "- Messages in a room you are not looking at raise its badge (and notify you when the page is hidden); leaving the room on screen moves you to the most recently active one.",
  "- The **people list** can stick to the left, right or bottom edge, and hide behind a small tab (the pin icon in its header).",
].join("\n");

const TOPICS = { android: ANDROID, phone: ANDROID, app: ANDROID, rooms: ROOMS, multi: ROOMS, syntax: SYNTAX, endpoints: ENDPOINTS, entry: ENDPOINTS, model: MODEL, session: MODEL, results: RESULTS, result: RESULTS, buttons: BUTTONS, button: BUTTONS, forms: FORMS, form: FORMS, browser: BROWSER, js: BROWSER };
const TOPIC_BUTTONS = [["syntax", "How to call"], ["results", "Results"], ["endpoints", "Entry points"], ["buttons", "Buttons"], ["forms", "Forms"], ["browser", "Browser code"], ["model", "m5.model"], ["webhooks", "Webhooks"], ["rooms", "Several rooms"], ["android", "Android app"]];
const topicButtons = (skip) => m5.out.buttons(TOPIC_BUTTONS.filter(([t]) => t !== skip).map(([t, title]) => ({ name: "topic", title, data: { topic: t }, css: "small ghost" })));

const WEBHOOKS = [
  "## 🔗 Webhooks and the API",
  "Some commands can also be called from outside the chat — by another system, a script or a form:",
  "- **Webhook** — an HTTP POST to a secret URL the operator gives you; the body (JSON — flat or as `{\"inputs\": {…}}` — or a form) becomes the command's parameters, the answer is its output as JSON. Long runs answer at once with a run id and a status URL (and can call you back).",
  "- **API** — `POST /api/functions/call/<id>` with `Authorization: Bearer <token>` (the operator issues the token).",
  "- Every webhook call is logged for the operator (headers, body, answer) and can be replayed.",
  "Ask the operator for the URL or the token — they are secrets and never shown here.",
].join("\n");

export async function execute({ topic } = {}) {
  const t = String(topic || "").trim().replace(/^[/!]/, "").toLowerCase();
  const commands = await m5.functions.list();

  // "?": the commands as buttons (a click answers with that command's help).
  if (t === "?") return [m5.out.markdown(`**Which command?** (${commands.length})`), m5.out.buttons(commands.slice(0, 24).map((c) => ({ name: "topic", title: `/${c.keyword}`, data: { topic: c.keyword }, css: "small" })))];
  if (TOPICS[t]) return [m5.out.markdown(TOPICS[t]), topicButtons(t)];
  if (t === "webhooks" || t === "webhook" || t === "api") return [m5.out.markdown(WEBHOOKS), topicButtons("webhooks")];
  if (t === "tags" || t === "tag") return m5.out.markdown("## 🏷️ Mentions and tags\n\n- **@name** — suggested as you type **@**; the person is highlighted in the message.\n- **#tag** — suggested as you type **#** (tags used in the room and the operator's list); click a tag in a message to see only the messages with it, click it again (or ×) to see all.");

  if (t && t !== "all") {
    const c = commands.find((x) => x.keyword === t) || commands.find((x) => x.keyword.startsWith(t));
    if (!c) {
      const near = commands.filter((x) => x.keyword.includes(t) || (x.name || "").toLowerCase().includes(t)).slice(0, 5);
      return m5.out.markdown(`No command **/${t}**${near.length ? ` — did you mean ${near.map((x) => `**/${x.keyword}**`).join(", ")}?` : "."} Type **/help** for the list.`);
    }
    const md = [`## /${c.keyword} — ${c.name}`, c.summary || "", `\`${sig(c)}\``];
    md.push(c.inputs.length ? table(["Parameter", "Type", "Required", "Default", "Choices / help"], c.inputs.map((i) => [`\`${i.name}\`${i.label ? ` (${i.label})` : ""}`, TYPE[i.type] || i.type, i.required ? "yes" : "no", i.default === null || i.default === undefined ? "" : String(i.default), [i.values.join(", "), i.help].filter(Boolean).join(" — ")])) : "_No parameters._");
    md.push(`**Examples**\n${example(c).map((e) => `- \`${e}\``).join("\n")}`);
    md.push(`**Output:** ${c.visibility === "room" ? "posted to the room" : "only for you"}${c.webhook ? " · also callable by **webhook**" : ""}${c.api ? " · also by **API**" : ""} · package \`${c.package}@${c.version}\``);
    const ev = (c.events || []).filter((e) => e !== "error");
    if (ev.length) md.push(`**Its answers can take:** ${ev.map((e) => (e === "response" ? "a **reply** to its message" : e === "button" ? "**buttons**" : "**forms**")).join(", ")}.`);
    return [m5.out.markdown(md.filter(Boolean).join("\n\n")), m5.out.buttons([{ name: "topic", title: "All commands", data: { topic: "" }, css: "small" }, { name: "topic", title: "How to call", data: { topic: "syntax" }, css: "small ghost" }])];
  }

  const md = [`# 🆘 Help — ${commands.length} command${commands.length === 1 ? "" : "s"} for ${m5.caller.name || "you"}`];
  md.push(commands.length ? table(["Command", "What it does", "Parameters"], commands.map((c) => [`\`/${c.keyword}\``, c.summary || c.name, c.inputs.map((i) => (i.required ? `<${i.name}>` : `[${i.name}]`)).join(" ")])) : "_No command is available to you on this server._");
  md.push("**More:** `/help <command>` for one command · `/help syntax` · `/help results` · `/help endpoints` · `/help buttons` · `/help forms` · `/help browser` · `/help model` · `/help webhooks` · `/help tags` · `/help rooms` · `/help android` · `/help ?` — or reply to this message with a command's name.");
  if (t === "all") {
    md.push(SYNTAX, RESULTS, ENDPOINTS, BUTTONS, FORMS, BROWSER, MODEL, WEBHOOKS);
    for (const c of commands) md.push(`### /${c.keyword} — ${c.name}\n${c.summary || ""}\n\n\`${sig(c)}\` — e.g. \`${example(c)[0]}\``);
  } else md.push(SYNTAX);
  // A list: the text, then buttons — a command's help, a topic.
  return [
    m5.out.markdown(md.join("\n\n")),
    m5.out.buttons(commands.filter((c) => c.keyword !== "help").slice(0, 12).map((c) => ({ name: "topic", title: `/${c.keyword}`, data: { topic: c.keyword }, css: "small" }))),
    topicButtons(""),
  ];
}

export async function button({ name, data } = {}) {
  return execute({ topic: name === "topic" && data ? data.topic : "" });
}

export async function response({ text } = {}) {
  return execute({ topic: String(text || "").trim().split(/\s+/)[0] });
}

export async function error({ error } = {}) {
  return m5.out.markdown(`**Help could not answer** — ${(error && error.message) || "something went wrong"}. Try \`/help\` again.`);
}
