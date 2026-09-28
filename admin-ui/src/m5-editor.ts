// The console's code editor (5.1): CodeMirror 6 with the m5 SDK built in —
// colour for keywords, functions, variables, properties and SDK calls;
// completion of m5.* with signatures, snippets and templates; help on hover
// and while typing a call; syntax checks; search, folding, multiple cursors.
//
// Bundled by esbuild into admin-ui/public/vendor/m5-editor.js (the console's
// CSP allows scripts from 'self' only) and exposed as window.M5Editor. The
// visual builder's compiler rides along as window.M5Flow, so the canvas
// previews exactly the code the server saves.

import { EditorState, Compartment, type Extension } from "@codemirror/state";
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor,
  rectangularSelection, crosshairCursor, highlightSpecialChars, hoverTooltip, showTooltip, type Tooltip,
  ViewPlugin, Decoration, MatchDecorator, type DecorationSet, type ViewUpdate, placeholder as cmPlaceholder,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment, indentSelection, undo, redo, selectAll } from "@codemirror/commands";
import { syntaxHighlighting, HighlightStyle, bracketMatching, foldGutter, indentOnInput, foldKeymap, syntaxTree, ensureSyntaxTree, indentUnit } from "@codemirror/language";
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, snippetCompletion, snippet, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { lintGutter, linter, lintKeymap, type Diagnostic } from "@codemirror/lint";
import { searchKeymap, highlightSelectionMatches, openSearchPanel } from "@codemirror/search";
import { javascript, javascriptLanguage } from "@codemirror/lang-javascript";
import { python, pythonLanguage } from "@codemirror/lang-python";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { StateField, type EditorState as State } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";
import * as Flow from "../../server/functions/flow";

export type Lang = "js" | "py" | "json" | "text";
type SdkMethod = { name: string; js: string; py: string; doc: string; async?: boolean };
type SdkObject = { name: string; doc: string; methods: SdkMethod[] };

export type EditorOptions = {
  doc?: string;
  lang?: Lang;
  readOnly?: boolean;
  sdk?: SdkObject[];
  /** Names the code can read from `inputs` (a model's or a flow's). */
  inputs?: () => string[];
  onChange?: (doc: string) => void;
  onSave?: () => void;
  onRun?: () => void;
  onCursor?: (info: { line: number; col: number; selected: number }) => void;
  minHeight?: string;
  maxHeight?: string;
  placeholder?: string;
  lineNumbers?: boolean;
};

/* ================================================================ theme */

const theme = EditorView.theme({
  "&": { color: "var(--text)", backgroundColor: "var(--bg)", fontSize: "12.5px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" },
  "&.cm-focused": { outline: "none", borderColor: "var(--accent)" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.55" },
  ".cm-content": { caretColor: "var(--accent-2)", padding: "8px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent-2)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "var(--cm-sel)" },
  ".cm-gutters": { backgroundColor: "var(--surface-2)", color: "var(--muted)", borderRight: "1px solid var(--border)", borderRadius: "var(--radius-sm) 0 0 var(--radius-sm)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--surface-3)", color: "var(--text)" },
  ".cm-activeLine": { backgroundColor: "var(--cm-line)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--surface-3)", border: "1px solid var(--border)", color: "var(--muted)" },
  ".cm-matchingBracket": { backgroundColor: "var(--cm-bracket)", outline: "1px solid var(--accent)" },
  ".cm-selectionMatch": { backgroundColor: "var(--cm-match)" },
  ".cm-searchMatch": { backgroundColor: "var(--warn-soft)", outline: "1px solid var(--warn)" },
  ".cm-tooltip": { backgroundColor: "var(--surface)", color: "var(--text)", border: "1px solid var(--border-strong)", borderRadius: "var(--radius-sm)", boxShadow: "var(--shadow)" },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--mono)", fontSize: "12px", maxHeight: "18em" },
  ".cm-tooltip-autocomplete > ul > li": { padding: "2px 8px" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent-soft)", color: "var(--text)" },
  ".cm-completionDetail": { color: "var(--muted)", fontStyle: "normal", marginLeft: "10px" },
  ".cm-completionMatchedText": { color: "var(--accent-2)", textDecoration: "none", fontWeight: "700" },
  ".cm-completionInfo": { padding: "8px 10px", maxWidth: "420px" },
  ".cm-panels": { backgroundColor: "var(--surface-2)", color: "var(--text)", borderColor: "var(--border)" },
  ".cm-panel input, .cm-panel button": { fontSize: "12px" },
  ".cm-textfield": { backgroundColor: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "4px" },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--surface-3)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "4px" },
  ".cm-diagnostic-error": { borderLeftColor: "var(--err)" },
  ".cm-diagnostic-warning": { borderLeftColor: "var(--warn)" },
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--err)" },
  ".cm-lintRange-warning": { backgroundImage: "none", textDecoration: "underline wavy var(--warn)" },
  ".cm-m5": { color: "var(--cm-m5)", fontWeight: "600" },
  ".cm-placeholder": { color: "var(--muted)" },
});

// Colours are CSS variables (console.css), so the light and dark console themes both work.
const colours = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier], color: "var(--cm-kw)", fontWeight: "600" },
  { tag: [t.self, t.atom, t.bool, t.null], color: "var(--cm-const)" },
  { tag: [t.number, t.integer, t.float], color: "var(--cm-num)" },
  { tag: [t.string, t.special(t.string), t.docString], color: "var(--cm-str)" },
  { tag: [t.regexp, t.escape], color: "var(--cm-re)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--cm-com)", fontStyle: "italic" },
  { tag: t.function(t.definition(t.variableName)), color: "var(--cm-fn-def)", fontWeight: "700" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--cm-fn)" },
  { tag: t.definition(t.variableName), color: "var(--cm-var-def)" },
  { tag: t.variableName, color: "var(--cm-var)" },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: "var(--cm-prop)" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.variableName)], color: "var(--cm-type)" },
  { tag: [t.operator, t.derefOperator, t.arithmeticOperator, t.logicOperator, t.compareOperator, t.updateOperator], color: "var(--cm-op)" },
  { tag: [t.punctuation, t.bracket, t.separator], color: "var(--cm-punct)" },
  { tag: t.invalid, color: "var(--err)" },
  { tag: t.heading, fontWeight: "700", color: "var(--cm-kw)" },
]);

// m5.xxx.yyy stands out: it is where a function reaches the instance.
const m5Marks = new MatchDecorator({ regexp: /\bm5(?:\.[A-Za-z_$][\w$]*)+/g, decoration: Decoration.mark({ class: "cm-m5" }) });
const m5Highlight = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = m5Marks.createDeco(view); }
  update(u: ViewUpdate) { this.decorations = m5Marks.updateDeco(u, this.decorations); }
}, { decorations: (v) => v.decorations });

/* ================================================================ the SDK */

/** "m5.ai.tts({ text, voice? })" → "tts({ text: ${text} })" — a snippet with fields for the required arguments. */
export function toSnippet(sig: string, lang: "js" | "py"): string {
  const s = sig.replace(/^await\s+/, "");
  const dot = s.lastIndexOf(".", s.indexOf("(") < 0 ? s.length : s.indexOf("("));
  const tail = s.slice(dot + 1);
  const open = tail.indexOf("(");
  if (open < 0) return tail;
  const name = tail.slice(0, open);
  const args = tail.slice(open + 1, tail.lastIndexOf(")")).trim();
  if (!args) return `${name}()`;
  const field = (x: string) => `\${${x.replace(/[^\w]/g, "") || "value"}}`;
  if (args.startsWith("{")) {
    if (args.includes("...")) return `${name}({ \${} })`;
    const keys = args.replace(/^\{|\}$/g, "").split(",").map((k) => k.trim()).filter((k) => k && !k.endsWith("?"));
    return lang === "py" ? `${name}({${keys.map((k) => `"${k}": ${field(k)}`).join(", ")}})` : `${name}({ ${keys.map((k) => `${k}: ${field(k)}`).join(", ")} })`;
  }
  const parts = splitTop(args).filter((a) => !a.endsWith("?") && !a.startsWith("{") && !a.startsWith("**") && !/=\s*(None|False|True|\d+|'[^']*'|"[^"]*")$/.test(a));
  const filled = parts.map((a) => (a.includes("=") ? `${a.split("=")[0].trim()}=${field(a.split("=")[0])}` : a === "..." ? "${}" : field(a)));
  return `${name}(${filled.join(", ")})`;
}
function splitTop(s: string): string[] {
  const out: string[] = []; let depth = 0; let cur = "";
  for (const ch of s) {
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function infoNode(title: string, sig: string, doc: string, example?: string): () => Node {
  return () => {
    const box = document.createElement("div");
    box.className = "m5cm-info";
    const h = document.createElement("div"); h.className = "m5cm-info__sig"; h.textContent = sig || title; box.append(h);
    if (doc) { const d = document.createElement("div"); d.className = "m5cm-info__doc"; d.textContent = doc; box.append(d); }
    if (example) { const pre = document.createElement("pre"); pre.className = "m5cm-info__ex"; pre.textContent = example; box.append(pre); }
    return box;
  };
}

const EXTRA_M5: Array<{ name: string; js: string; py: string; doc: string; async: boolean }> = [
  { name: "sleep", js: "await m5.sleep(ms)", py: "await m5.sleep(ms)", doc: "Waits (counts against the time limit).", async: true },
  { name: "prompt", js: "await m5.prompt({ text, choices? })", py: "await m5.prompt({\"text\": ..., \"choices\": [...]})", doc: "Asks the caller and waits for the answer (a choice or text).", async: true },
  { name: "form", js: "await m5.form({ title, fields })", py: "await m5.form({\"title\": ..., \"fields\": [...]})", doc: "Shows the caller a form and waits for its values.", async: true },
  { name: "Error", js: "new m5.Error(code, message)", py: "m5.Error(code, message)", doc: "An error with a code the caller sees.", async: false },
];

function sdkIndex(sdk: SdkObject[]) {
  const objects = new Map(sdk.map((o) => [o.name, o]));
  const find = (path: string): { sig: SdkMethod | null; obj: SdkObject | null } => {
    const parts = path.split(".");
    if (parts[0] !== "m5") return { sig: null, obj: null };
    const obj = objects.get(parts[1] ?? "") ?? null;
    if (!obj) { const x = EXTRA_M5.find((e) => e.name === parts[1]); return { sig: x ? { ...x } : null, obj: null }; }
    if (parts.length < 3) return { sig: null, obj };
    return { sig: obj.methods.find((m) => m.name === parts[2]) ?? null, obj };
  };
  return { objects, find };
}

function m5Completion(sdk: SdkObject[], lang: "js" | "py") {
  const { objects } = sdkIndex(sdk);
  return (ctx: CompletionContext): CompletionResult | null => {
    const m = ctx.matchBefore(/\bm5(?:\.[\w$]*)*$/);
    if (!m) return null;
    const path = m.text.split(".");
    if (path.length < 2) {
      // "m5" typed: offer the whole namespace
      return { from: m.from, options: [{ label: "m5", type: "namespace", detail: "the SDK", info: "The M5cet SDK: out, log, http, ai, crypto, codes, session, cache…", boost: 99 }] };
    }
    const from = m.to - path[path.length - 1].length;
    if (path.length === 2) {
      const options: Completion[] = [
        ...[...objects.values()].map((o) => ({ label: o.name, type: "namespace", detail: `m5.${o.name}`, info: infoNode(`m5.${o.name}`, `m5.${o.name}`, o.doc, o.methods.slice(0, 4).map((x) => (lang === "py" ? x.py : x.js)).join("\n")), boost: 10 })),
        ...EXTRA_M5.map((x) => asyncApply(x.name, lang === "py" ? x.py : x.js, x.doc, x.async, lang)),
      ];
      return { from, options, validFor: /^[\w$]*$/ };
    }
    if (path.length === 3) {
      const obj = objects.get(path[1]);
      if (!obj) return null;
      return { from, options: obj.methods.map((x) => asyncApply(x.name, lang === "py" ? x.py : x.js, x.doc, Boolean(x.async), lang)), validFor: /^[\w$]*$/ };
    }
    return null;
  };
}

/** A method completion that inserts a snippet — and `await ` before m5 when the call is async and it is missing. */
function asyncApply(name: string, sig: string, doc: string, isAsync: boolean, lang: "js" | "py"): Completion {
  const isCall = sig.includes("(");
  const tpl = isCall ? toSnippet(sig, lang) : name;
  return {
    label: name,
    type: isCall ? "method" : "property",
    detail: sig.replace(/^await\s+/, "").replace(/^m5\.[\w.]*?\.?(?=[\w$]+\()/, "").slice(0, 60),
    info: infoNode(name, sig, doc + (isAsync ? (lang === "py" ? "  (async — use await)" : "  (async — use await)") : "")),
    boost: isAsync ? 1 : 2,
    apply: (view, completion, from, to) => {
      snippet(tpl)(view, completion, from, to);
      if (!isAsync) return;
      const line = view.state.doc.lineAt(from);
      const before = line.text.slice(0, from - line.from);
      const m5At = before.search(/\bm5(?:\.[\w$]+)*\.$/);
      if (m5At < 0) return;
      if (/\bawait\s+$/.test(before.slice(0, m5At))) return;
      view.dispatch({ changes: { from: line.from + m5At, insert: "await " } });
    },
  };
}

/* ================================================================ snippets */

type Snip = { label: string; detail: string; template: string; info: string };

export const SNIPPETS: Record<"js" | "py", Snip[]> = {
  js: [
    { label: "execute", detail: "entry function", template: "export async function execute({ ${name} = \"${world}\" }) {\n  ${}\n  return m5.out.markdown(`# Hello, ${name}!`);\n}", info: "The function a model runs: inputs arrive as one object." },
    { label: "if", detail: "if / else", template: "if (${condition}) {\n  ${}\n} else {\n  \n}", info: "A branch." },
    { label: "forof", detail: "for … of", template: "for (const ${item} of ${list}) {\n  ${}\n}", info: "Loop over a list." },
    { label: "trycatch", detail: "try / catch", template: "try {\n  ${}\n} catch (err) {\n  m5.log.error(\"failed\", { error: String(err) });\n  return m5.out.text(\"Something went wrong.\");\n}", info: "Handle an error and tell the caller." },
    { label: "httpjson", detail: "GET JSON", template: "const r = await m5.http.get(${url});\nif (!r.ok) return m5.out.text(`HTTP ${r.status}`);\nconst data = r.json;\n${}", info: "Fetch JSON from an API (public addresses only)." },
    { label: "table", detail: "table output", template: "return m5.out.table([\"${name}\", \"${value}\"], ${rows}.map((r) => [r.${name}, r.${value}]), { title: \"${Title}\" });", info: "Show a list as a table." },
    { label: "ask", detail: "prompt the caller", template: "const answer = await m5.prompt({ text: \"${Continue?}\", choices: [\"yes\", \"no\"] });\nif (answer !== \"yes\") return m5.out.text(\"Cancelled.\");\n${}", info: "Ask and wait for a choice." },
    { label: "aichat", detail: "ask the AI", template: "const r = await m5.ai.chat({ messages: [{ role: \"user\", content: ${question} }] });\nreturn m5.out.markdown(r.text);", info: "Ask the instance's model." },
    { label: "speak", detail: "text → speech", template: "const speech = await m5.ai.tts({ text: ${text} });\nreturn m5.out.file(\"speech.wav\", speech.audio, speech.mime);", info: "Synthesize speech (offline voices work too)." },
    { label: "counter", detail: "session counter", template: "const n = ((await m5.session.get(\"${count}\")) ?? 0) + 1;\nawait m5.session.set(\"${count}\", n);\n${}", info: "Remember something between runs." },
    { label: "log", detail: "log a value", template: "m5.log.info(\"${message}\", { ${value} });", info: "A structured log line." },
    { label: "qr", detail: "QR code image", template: "const qr = await m5.codes.qr(${text}, { scale: 5 });\nreturn m5.out.image(qr.image, qr.mime, { alt: \"QR\" });", info: "Text → QR code." },
    { label: "arrow", detail: "async arrow", template: "const ${name} = async (${args}) => {\n  ${}\n};", info: "A small helper function." },
  ],
  py: [
    { label: "execute", detail: "entry function", template: "async def execute(${name}: str = \"${world}\"):\n    ${}\n    return m5.out.markdown(f\"# Hello, {${name}}!\")", info: "The function a model runs: inputs arrive as keyword arguments." },
    { label: "if", detail: "if / else", template: "if ${condition}:\n    ${}\nelse:\n    pass", info: "A branch." },
    { label: "for", detail: "for … in", template: "for ${item} in ${items}:\n    ${}", info: "Loop over a list." },
    { label: "try", detail: "try / except", template: "try:\n    ${}\nexcept Exception as err:\n    m5.log.error(\"failed\", error=str(err))\n    return m5.out.text(\"Something went wrong.\")", info: "Handle an error and tell the caller." },
    { label: "httpjson", detail: "GET JSON", template: "r = await m5.http.get(${url})\nif not r[\"ok\"]:\n    return m5.out.text(f\"HTTP {r['status']}\")\ndata = r[\"json\"]\n${}", info: "Fetch JSON from an API." },
    { label: "table", detail: "table output", template: "return m5.out.table([\"${name}\", \"${value}\"], [[r[\"${name}\"], r[\"${value}\"]] for r in ${rows}], title=\"${Title}\")", info: "Show a list as a table." },
    { label: "ask", detail: "prompt the caller", template: "answer = await m5.prompt({\"text\": \"${Continue?}\", \"choices\": [\"yes\", \"no\"]})\nif answer != \"yes\":\n    return m5.out.text(\"Cancelled.\")\n${}", info: "Ask and wait for a choice." },
    { label: "aichat", detail: "ask the AI", template: "r = await m5.ai.chat({\"messages\": [{\"role\": \"user\", \"content\": ${question}}]})\nreturn m5.out.markdown(r[\"text\"])", info: "Ask the instance's model." },
    { label: "speak", detail: "text → speech", template: "speech = await m5.ai.tts(text=${text})\nreturn m5.out.file(\"speech.wav\", speech[\"audio\"], speech[\"mime\"])", info: "Synthesize speech." },
    { label: "counter", detail: "session counter", template: "n = (await m5.session.get(\"${count}\") or 0) + 1\nawait m5.session.set(\"${count}\", n)\n${}", info: "Remember something between runs." },
    { label: "log", detail: "log a value", template: "m5.log.info(\"${message}\", ${value}=${value})", info: "A structured log line." },
    { label: "listcomp", detail: "list comprehension", template: "[${x} for ${x} in ${items} if ${condition}]", info: "Build a list." },
    { label: "fstring", detail: "f-string", template: "f\"${text} {${value}}\"", info: "Text with values." },
  ],
};

function snippetSource(lang: "js" | "py") {
  const options = SNIPPETS[lang].map((s) => snippetCompletion(s.template, { label: s.label, detail: s.detail, type: "text", info: infoNode(s.label, s.detail, s.info, s.template.replace(/\$\{([^}]*)\}/g, "$1")), boost: -1 }));
  return (ctx: CompletionContext): CompletionResult | null => {
    const w = ctx.matchBefore(/[\w]+$/);
    if (!w || (w.from === w.to && !ctx.explicit)) return null;
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, w.from - line.from);
    if (/[.\w]$/.test(before)) return null; // after a dot: members, not snippets
    return { from: w.from, options, validFor: /^\w*$/ };
  };
}

/** `inputs.` (JS) / `inputs["` (Python) → the input names. */
function inputsSource(names: () => string[], lang: "js" | "py") {
  return (ctx: CompletionContext): CompletionResult | null => {
    const m = lang === "py" ? ctx.matchBefore(/\binputs\[["'][\w]*$/) ?? ctx.matchBefore(/\binputs\.get\(["'][\w]*$/) : ctx.matchBefore(/\binputs\.[\w$]*$/);
    if (!m) return null;
    const list = names();
    if (!list.length) return null;
    const from = m.from + m.text.search(/[\w$]*$/);
    return { from, options: list.map((n) => ({ label: n, type: "variable", detail: "input" })), validFor: /^[\w$]*$/ };
  };
}

/* ================================================================ help while typing */

/** The SDK call the cursor is inside: its signature, shown above the line. */
function signatureHelp(sdk: SdkObject[], lang: "js" | "py") {
  const { find } = sdkIndex(sdk);
  const compute = (state: State): Tooltip | null => {
    const sel = state.selection.main;
    if (!sel.empty) return null;
    const line = state.doc.lineAt(sel.head);
    const before = line.text.slice(0, sel.head - line.from);
    let depth = 0;
    for (let i = before.length - 1; i >= 0; i--) {
      const ch = before[i];
      if (ch === ")" || ch === "]" || ch === "}") depth++;
      else if (ch === "(" || ch === "[" || ch === "{") {
        if (depth > 0) { depth--; continue; }
        if (ch !== "(") continue;
        const m = /\bm5(?:\.[\w$]+)+$/.exec(before.slice(0, i));
        if (!m) return null;
        const { sig } = find(m[0]);
        if (!sig) return null;
        const text = lang === "py" ? sig.py : sig.js;
        return { pos: line.from + m.index, above: true, strictSide: true, arrow: false, create: () => { const dom = document.createElement("div"); dom.className = "m5cm-sig"; const a = document.createElement("span"); a.className = "m5cm-sig__call"; a.textContent = text; const b = document.createElement("span"); b.className = "m5cm-sig__doc"; b.textContent = sig.doc; dom.append(a, b); return { dom }; } };
      }
    }
    return null;
  };
  return StateField.define<Tooltip | null>({
    create: compute,
    update: (value, tr) => (tr.docChanged || tr.selection ? compute(tr.state) : value),
    provide: (f) => showTooltip.from(f),
  });
}

function sdkHover(sdk: SdkObject[], lang: "js" | "py") {
  const { find } = sdkIndex(sdk);
  return hoverTooltip((view, pos) => {
    const line = view.state.doc.lineAt(pos);
    const re = /\bm5(?:\.[\w$]+)+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line.text))) {
      const from = line.from + m.index, to = from + m[0].length;
      if (pos < from || pos > to) continue;
      // The segment under the pointer: m5.ai.tts → hovering "ai" explains the object.
      const offset = pos - from;
      const parts = m[0].split(".");
      let acc = 0; let upto = parts.length;
      for (let i = 0; i < parts.length; i++) { acc += parts[i].length + 1; if (offset < acc) { upto = i + 1; break; } }
      const path = parts.slice(0, Math.max(2, upto)).join(".");
      const { sig, obj } = find(path);
      if (!sig && !obj) return null;
      return { pos: from, end: to, above: true, create: () => ({ dom: infoNode(path, sig ? (lang === "py" ? sig.py : sig.js) : `m5.${obj!.name}`, sig ? sig.doc + (sig.async ? " (async — use await)" : "") : obj!.doc, !sig && obj ? obj.methods.map((x) => (lang === "py" ? x.py : x.js)).join("\n") : undefined)() as HTMLElement }) };
    }
    return null;
  });
}

/* ================================================================ checks */

function syntaxLint(lang: "js" | "py", sdk: SdkObject[]) {
  const { find } = sdkIndex(sdk);
  return linter((view) => {
    const out: Diagnostic[] = [];
    const tree = ensureSyntaxTree(view.state, view.state.doc.length, 400) ?? syntaxTree(view.state);
    let errors = 0;
    tree.iterate({ enter: (n) => {
      if (!n.type.isError || errors > 20) return;
      errors++;
      const from = Math.min(n.from, view.state.doc.length);
      const to = Math.min(Math.max(n.to, from + 1), view.state.doc.length);
      out.push({ from, to, severity: "error", message: "Syntax error — something is missing or extra here." });
    } });
    // An async SDK call without await gives a Promise, not the value.
    const text = view.state.doc.toString();
    const re = /\bm5(?:\.[\w$]+)+(?=\s*\()/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const { sig } = find(m[0]);
      if (!sig || !sig.async) continue;
      const lineStart = text.lastIndexOf("\n", m.index) + 1;
      const before = text.slice(lineStart, m.index);
      if (/\bawait\s*(\(\s*)?$/.test(before) || /\breturn\s*$/.test(before) || /=>\s*$/.test(before) || /\bPromise\.all\(\s*\[?[^;]*$/.test(before) || /\bgather\([^)]*$/.test(before)) continue;
      out.push({ from: m.index, to: m.index + m[0].length, severity: "warning", message: `${m[0]} is async — add await${lang === "py" ? "" : ""}, or you get a ${lang === "py" ? "coroutine" : "Promise"} instead of the value.`, actions: [{ name: "Add await", apply: (v, from) => v.dispatch({ changes: { from, insert: "await " } }) }] });
    }
    return out;
  }, { delay: 500 });
}

/* ================================================================ the editor */

function languageFor(lang: Lang, opts: EditorOptions): Extension {
  const sdk = opts.sdk ?? [];
  if (lang === "json") return [json(), linter(jsonParseLinter(), { delay: 400 })];
  if (lang === "text") return [];
  const l = lang === "py" ? "py" : "js";
  const data = (l === "py" ? pythonLanguage : javascriptLanguage).data;
  const sources = [m5Completion(sdk, l), snippetSource(l)];
  if (opts.inputs) sources.push(inputsSource(opts.inputs, l));
  return [
    l === "py" ? python() : javascript(),
    ...sources.map((s) => data.of({ autocomplete: s })),
    sdkHover(sdk, l),
    signatureHelp(sdk, l),
    syntaxLint(l, sdk),
  ];
}

export type EditorHandle = {
  view: EditorView;
  getValue(): string;
  setValue(text: string): void;
  insertText(text: string): void;
  insertSnippet(template: string): void;
  focus(): void;
  setReadOnly(on: boolean): void;
  setLang(lang: Lang): void;
  format(): void;
  search(): void;
  undo(): void;
  redo(): void;
  destroy(): void;
};

export function create(parent: HTMLElement, opts: EditorOptions = {}): EditorHandle {
  const langConf = new Compartment();
  const roConf = new Compartment();
  let lang: Lang = opts.lang ?? "js";
  const keys = keymap.of([
    { key: "Mod-s", preventDefault: true, run: () => { opts.onSave?.(); return true; } },
    { key: "Mod-Enter", preventDefault: true, run: () => { opts.onRun?.(); return true; } },
    { key: "Shift-Alt-f", run: (v) => { formatAll(v); return true; } },
    { key: "Mod-/", run: toggleComment },
    indentWithTab,
    ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, ...lintKeymap,
  ]);
  const size = EditorView.theme({ "&": { minHeight: opts.minHeight ?? "320px", ...(opts.maxHeight ? { maxHeight: opts.maxHeight } : {}) }, ".cm-scroller": { minHeight: opts.minHeight ?? "320px" } });
  const state = EditorState.create({
    doc: opts.doc ?? "",
    extensions: [
      opts.lineNumbers === false ? [] : [lineNumbers(), foldGutter(), highlightActiveLineGutter()],
      highlightSpecialChars(), history(), drawSelection(), dropCursor(), EditorState.allowMultipleSelections.of(true),
      indentOnInput(), bracketMatching(), closeBrackets(), rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(),
      autocompletion({ activateOnTyping: true, icons: true, closeOnBlur: true, maxRenderedOptions: 80 }),
      lintGutter(),
      indentUnit.of(lang === "py" ? "    " : "  "),
      syntaxHighlighting(colours), m5Highlight, theme, size, keys,
      opts.placeholder ? cmPlaceholder(opts.placeholder) : [],
      langConf.of(languageFor(lang, opts)),
      roConf.of([EditorState.readOnly.of(Boolean(opts.readOnly)), EditorView.editable.of(!opts.readOnly)]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) opts.onChange?.(u.state.doc.toString());
        if ((u.selectionSet || u.docChanged) && opts.onCursor) {
          const s = u.state.selection.main; const line = u.state.doc.lineAt(s.head);
          opts.onCursor({ line: line.number, col: s.head - line.from + 1, selected: Math.abs(s.to - s.from) });
        }
      }),
    ],
  });
  const view = new EditorView({ state, parent });
  const formatAll = (v: EditorView) => { const sel = v.state.selection; selectAll(v); indentSelection(v); v.dispatch({ selection: sel.main.head <= v.state.doc.length ? { anchor: Math.min(sel.main.anchor, v.state.doc.length), head: Math.min(sel.main.head, v.state.doc.length) } : undefined }); };
  return {
    view,
    getValue: () => view.state.doc.toString(),
    setValue: (text) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }),
    insertText: (text) => { const r = view.state.selection.main; view.dispatch({ changes: { from: r.from, to: r.to, insert: text }, selection: { anchor: r.from + text.length } }); view.focus(); },
    insertSnippet: (template) => { const r = view.state.selection.main; snippet(template)(view, { label: "" }, r.from, r.to); view.focus(); },
    focus: () => view.focus(),
    setReadOnly: (on) => view.dispatch({ effects: roConf.reconfigure([EditorState.readOnly.of(on), EditorView.editable.of(!on)]) }),
    setLang: (l) => { lang = l; view.dispatch({ effects: langConf.reconfigure(languageFor(l, opts)) }); },
    format: () => formatAll(view),
    search: () => { openSearchPanel(view); },
    undo: () => { undo(view); },
    redo: () => { redo(view); },
    destroy: () => view.destroy(),
  };
}

/** Read-only, highlighted code (for previews). */
export function show(parent: HTMLElement, code: string, lang: Lang, opts: Partial<EditorOptions> = {}): EditorHandle {
  return create(parent, { ...opts, doc: code, lang, readOnly: true, minHeight: opts.minHeight ?? "120px" });
}

/** The language of a file name. */
export function langOf(file: string): Lang {
  return /\.py$/.test(file) ? "py" : /\.(m?js|cjs|ts)$/.test(file) ? "js" : /\.json$/.test(file) ? "json" : "text";
}

const api = { create, show, langOf, toSnippet, SNIPPETS, version: "5.1" };
const flowApi = { ...Flow };
declare global { interface Window { M5Editor?: typeof api; M5Flow?: typeof flowApi } }
window.M5Editor = api;
window.M5Flow = flowApi;
