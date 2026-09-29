// /help — the guide to the chat's commands: how to call them, every command
// you may use with its parameters and examples, webhooks and the API.
//
//   /help                 overview and the list of commands
//   /help <command>       one command in detail (parameters, examples)
//   /help syntax | webhooks | api | tags | all
//   /help ?               pick a command from a list

const TYPE = { string: "text", text: "longer text", integer: "whole number", number: "number", boolean: "yes/no", enum: "one of the choices", date: "date (2026-09-29)", time: "time (14:30)", duration: "duration (90s, 5m, 2h)", url: "web address", hostname: "host name", email: "e-mail address", ip: "IP address", json: "JSON", user: "a user", file: "a file" };
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
].join("\n");

const WEBHOOKS = [
  "## 🔗 Webhooks and the API",
  "Some commands can also be called from outside the chat — by another system, a script or a form:",
  "- **Webhook** — an HTTP POST to a secret URL the operator gives you; the body (JSON — flat or as `{\"inputs\": {…}}` — or a form) becomes the command's parameters, the answer is its output as JSON. Long runs answer at once with a run id and a status URL (and can call you back).",
  "- **API** — `POST /api/functions/call/<id>` with `Authorization: Bearer <token>` (the operator issues the token).",
  "- Every webhook call is logged for the operator (headers, body, answer) and can be replayed.",
  "Ask the operator for the URL or the token — they are secrets and never shown here.",
].join("\n");

export async function execute({ topic } = {}) {
  let t = String(topic || "").trim().replace(/^[/!]/, "").toLowerCase();
  const commands = await m5.functions.list();

  if (t === "?" && commands.length) {
    const kind = m5.caller.kind;
    if (kind === "user" || kind === "guest" || kind === "console") t = String(await m5.prompt({ text: "Which command?", choices: commands.slice(0, 20).map((c) => c.keyword) }) || "").toLowerCase();
  }
  if (t === "syntax") return m5.out.markdown(SYNTAX);
  if (t === "webhooks" || t === "webhook" || t === "api") return m5.out.markdown(WEBHOOKS);
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
    return m5.out.markdown(md.filter(Boolean).join("\n\n"));
  }

  const md = [`# 🆘 Help — ${commands.length} command${commands.length === 1 ? "" : "s"} for ${m5.caller.name || "you"}`];
  md.push(commands.length ? table(["Command", "What it does", "Parameters"], commands.map((c) => [`\`/${c.keyword}\``, c.summary || c.name, c.inputs.map((i) => (i.required ? `<${i.name}>` : `[${i.name}]`)).join(" ")])) : "_No command is available to you on this server._");
  md.push("**More:** `/help <command>` for one command · `/help syntax` · `/help webhooks` · `/help tags` · `/help ?` to pick from a list.");
  if (t === "all") {
    md.push(SYNTAX, WEBHOOKS);
    for (const c of commands) md.push(`### /${c.keyword} — ${c.name}\n${c.summary || ""}\n\n\`${sig(c)}\` — e.g. \`${example(c)[0]}\``);
  } else md.push(SYNTAX);
  return m5.out.markdown(md.join("\n\n"));
}
