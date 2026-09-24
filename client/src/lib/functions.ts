// Chat commands — the client side of Functions (4.15). A user types
// "/keyword args" in the composer; this recognises it, turns the arguments
// into the model's inputs, asks the server to run the model (in a sandbox
// process, off the E2EE path — only what is typed here leaves the device),
// and gives back the outputs to show and, when the model posts to the room,
// to send as an ordinary end-to-end-encrypted message.

export type CommandInput = { name: string; type: string; label?: string; help?: string; required: boolean; default?: unknown; values?: string[] };
export type Command = { keyword: string; name: string; summary: string; runtime: string; visibility: "room" | "caller"; mine: boolean; inputs: CommandInput[] };

export type FnOutput =
  | { type: "text"; text: string }
  | { type: "markdown"; text: string }
  | { type: "code"; text: string; lang?: string }
  | { type: "table"; columns: string[]; rows: unknown[][]; title?: string }
  | { type: "json"; value: unknown; title?: string }
  | { type: "image"; mime: string; data: string; alt?: string }
  | { type: "file"; name: string; mime: string; data: string }
  | { type: "flash"; text: string; level: string }
  | { type: "window"; id: string; args: unknown };

export type RunOutcome =
  | { ok: true; outputs: FnOutput[]; visibility: "room" | "caller"; status: string; ms: number }
  | { ok: false; code: string; message: string };

const authHeaders = (token: string | null): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {});

/** The commands this user may run ("/keyword"); empty when the module is off. */
export async function fetchCommands(token: string | null): Promise<Command[]> {
  try {
    const res = await fetch("/api/functions/commands", { headers: authHeaders(token), cache: "no-store" });
    if (!res.ok) return [];
    const data = await res.json();
    return data.enabled && Array.isArray(data.commands) ? data.commands as Command[] : [];
  } catch { return []; }
}

/** "/word rest" → { keyword, argText }; null when the text is not a command. */
export function parseCommandLine(text: string): { keyword: string; argText: string } | null {
  const m = /^\/([a-z0-9_-]{1,40})(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return m ? { keyword: m[1].toLowerCase(), argText: (m[2] ?? "").trim() } : null;
}

/** Splits an argument line into tokens, honouring "quoted values". */
function tokenize(argText: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(argText))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * Maps the argument line to the model's inputs: `key=value` pairs set that
 * input; bare tokens fill the required inputs in order (the last text input
 * takes the rest). Mirrors "/check example.org depth=full".
 */
export function buildInputs(command: Command, argText: string): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  const byName = new Map(command.inputs.map((i) => [i.name, i]));
  // Bare tokens fill the inputs in order (chat-typeable ones); a value picked
  // in the chat comes as text, so "user", "file" and "secret" are not filled here.
  const positional = command.inputs.filter((i) => i.type !== "user" && i.type !== "file" && i.type !== "secret");
  const tokens = tokenize(argText);
  const bare: string[] = [];
  for (const tok of tokens) {
    const eq = tok.indexOf("=");
    if (eq > 0 && byName.has(tok.slice(0, eq))) inputs[tok.slice(0, eq)] = tok.slice(eq + 1);
    else bare.push(tok);
  }
  let pi = 0;
  for (const spec of positional) {
    if (spec.name in inputs) continue;
    if (pi >= bare.length) break;
    // A free-text field at the end takes everything that is left.
    if ((spec.type === "text" || spec.type === "string") && spec === positional[positional.length - 1]) {
      inputs[spec.name] = bare.slice(pi).join(" ");
      pi = bare.length;
    } else {
      inputs[spec.name] = bare[pi++];
    }
  }
  return inputs;
}

/** Runs a command on the server; returns its outputs (or why it could not). */
export async function runCommand(opts: { keyword: string; inputs: Record<string, unknown>; room: string | null; client: string | null; lang: string; tz?: string; token: string | null; signal?: AbortSignal }): Promise<RunOutcome> {
  let res: Response;
  try {
    res = await fetch("/api/functions/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(opts.token) },
      body: JSON.stringify({ keyword: opts.keyword, inputs: opts.inputs, room: opts.room, client: opts.client, lang: opts.lang, tz: opts.tz }),
      signal: opts.signal,
    });
  } catch (err) {
    return { ok: false, code: "network", message: (err as Error).message };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) return { ok: false, code: data.code || "error", message: data.message || `HTTP ${res.status}` };
  if (data.error) return { ok: false, code: data.error.type || "failed", message: data.error.message || "The function failed." };
  return { ok: true, outputs: (data.outputs ?? []) as FnOutput[], visibility: data.visibility === "caller" ? "caller" : "room", status: data.status, ms: data.ms };
}

/** Renders outputs to Markdown for an ordinary chat message (what peers see). */
export function outputsToMarkdown(outputs: FnOutput[]): string {
  const parts: string[] = [];
  for (const o of outputs) {
    switch (o.type) {
      case "text": parts.push(o.text); break;
      case "markdown": parts.push(o.text); break;
      case "code": parts.push("```" + (o.lang || "") + "\n" + o.text + "\n```"); break;
      case "json": parts.push((o.title ? `**${o.title}**\n` : "") + "```json\n" + JSON.stringify(o.value, null, 2) + "\n```"); break;
      case "table": parts.push(tableToMarkdown(o)); break;
      case "flash": parts.push(`> ${o.text}`); break;
      case "image": parts.push(`_(image: ${o.alt || o.mime})_`); break;
      case "file": parts.push(`_(file: ${o.name})_`); break;
      case "window": break;
    }
  }
  return parts.join("\n\n").trim();
}

function tableToMarkdown(o: { columns: string[]; rows: unknown[][]; title?: string }): string {
  const cell = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const head = `| ${o.columns.map(cell).join(" | ")} |`;
  const sep = `| ${o.columns.map(() => "---").join(" | ")} |`;
  const body = o.rows.map((r) => `| ${r.map(cell).join(" | ")} |`).join("\n");
  return (o.title ? `**${o.title}**\n\n` : "") + [head, sep, body].join("\n");
}
