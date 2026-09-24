// A developer's tool (4.13): turns a React component's JSX into a first
// draft of a Layout builder tree — elements of the palette, classes,
// attributes, translations ({_'key'}), lucide icons, conditions (&&, ? :),
// repeats (.map), events → actions, live parts (other components) — and
// lists what the component must then hand the layout: the values ($…), the
// actions and the parts, plus every expression it could not translate
// (marked TODO). The draft is a starting point: a person finishes it, and a
// parity test (old JSX against the layout, element for element) checks it.
//
//   node script/jsx-to-layout.mjs <file.tsx> <Component> [--json]
//
// Parses with the TSX parser rolldown ships (oxc).

import { readFileSync } from "node:fs";
import { parseAst } from "rolldown/parseAst";

const [file, component, ...flags] = process.argv.slice(2);
if (!file || !component) {
  console.error("usage: node script/jsx-to-layout.mjs <file.tsx> <Component> [--json]");
  process.exit(2);
}
const src = readFileSync(file, "utf8");
const ast = parseAst(src, { lang: "tsx" });

/* ------------------------------------------------------------- find it */

const lucide = new Set();
const lucideImported = new Map();
for (const s of ast.body) {
  if (s.type === "ImportDeclaration" && s.source.value === "lucide-react") for (const sp of s.specifiers) { lucide.add(sp.local.name); lucideImported.set(sp.local.name, sp.imported?.name ?? sp.local.name); }
}
function findFunction(name) {
  for (const s of ast.body) {
    const d = s.type === "ExportNamedDeclaration" ? s.declaration : s;
    if (!d) continue;
    if (d.type === "FunctionDeclaration" && d.id?.name === name) return d;
    if (d.type === "VariableDeclaration") {
      for (const v of d.declarations) {
        if (v.id.name !== name) continue;
        let init = v.init;
        if (init?.type === "CallExpression") init = init.arguments[0]; // memo(function …)
        if (init && (init.type === "FunctionExpression" || init.type === "ArrowFunctionExpression")) return init;
      }
    }
  }
  return null;
}
const fn = findFunction(component);
if (!fn) { console.error(`${component} not found in ${file}`); process.exit(1); }
/** The last JSX a function returns (its main view). */
function returnedJsx(f) {
  if (f.body.type !== "BlockStatement") return f.body;
  let found = null;
  const visit = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression" || n.type === "FunctionDeclaration") return;
    if (n.type === "ReturnStatement" && n.argument && /JSX/.test(n.argument.type)) found = n.argument;
    // createPortal(<…/>, document.body): the element itself.
    if (n.type === "ReturnStatement" && n.argument?.type === "CallExpression" && n.argument.callee.name === "createPortal") found = n.argument.arguments[0];
    for (const k of Object.keys(n)) if (k !== "parent") { const v = n[k]; if (Array.isArray(v)) v.forEach(visit); else if (v && typeof v === "object" && v.type) visit(v); }
  };
  for (const st of f.body.body) visit(st);
  return found;
}
/**
 * What a function returns, as branches: `if (a) return <A/>; if (b) return
 * <B/>; return <C/>` → [[a, A], [!a && b, B], [!a && !b, C]] (conditions as
 * source nodes, combined later).
 */
function branchesOf(f) {
  if (f.body.type !== "BlockStatement") return [{ conds: [], jsx: f.body }];
  const out = [];
  const before = [];
  for (const st of f.body.body) {
    if (st.type === "IfStatement" && !st.alternate) {
      const ret = st.consequent.type === "ReturnStatement" ? st.consequent : st.consequent.type === "BlockStatement" && st.consequent.body.length === 1 && st.consequent.body[0].type === "ReturnStatement" ? st.consequent.body[0] : null;
      if (ret && ret.argument && (/JSX/.test(ret.argument.type) || (ret.argument.type === "Literal" && ret.argument.value === null) || ret.argument.type === "ParenthesizedExpression")) {
        out.push({ conds: [...before.map((c) => ({ not: true, n: c })), { not: false, n: st.test }], jsx: ret.argument });
        before.push(st.test);
      }
    }
  }
  const last = returnedJsx(f);
  if (last) out.push({ conds: before.map((c) => ({ not: true, n: c })), jsx: last });
  return out;
}
const branches = branchesOf(fn);
if (!branches.length) { console.error(`${component} returns no JSX`); process.exit(1); }

/* ------------------------------------------------------- the translation */

const vars = new Set();
const actions = new Map();
const slots = new Map();
const todos = [];
let counter = 0;
const code = (n) => src.slice(n.start, n.end);
const usedIds = new Set();
/** A readable id: from data-testid, else the first class, else the kind — unique. */
function idFor(kind, attrs = {}) {
  const testid = typeof attrs["data-testid"] === "string" && !attrs["data-testid"].startsWith("=") ? attrs["data-testid"].replace(/\{[^}]*\}/g, "").replace(/-+$/, "") : "";
  const cls = typeof attrs.class === "string" && !attrs.class.startsWith("=") ? attrs.class.replace(/\{[^}]*\}/g, " ").trim().split(/\s+/)[0] ?? "" : "";
  let stem = (testid || cls || kind).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").replace(/--+/g, "-").slice(0, 32) || kind;
  if (!/^[a-z0-9]/.test(stem)) stem = kind;
  if (!usedIds.has(stem)) { usedIds.add(stem); return stem; }
  for (let i = 2; ; i++) if (!usedIds.has(`${stem}-${i}`)) { usedIds.add(`${stem}-${i}`); return `${stem}-${i}`; }
}
const todo = (what, n) => { todos.push(`${what}: ${code(n).replace(/\s+/g, " ").slice(0, 160)}`); return `TODO${todos.length}`; };

const REACT_PROPS = { className: "class", htmlFor: "for", tabIndex: "tabindex", readOnly: "readonly", maxLength: "maxlength", minLength: "minlength", autoComplete: "autocomplete", autoFocus: "autofocus", autoPlay: "autoplay", playsInline: "playsinline", spellCheck: "spellcheck", inputMode: "inputmode", enterKeyHint: "enterkeyhint", accessKey: "accesskey", noValidate: "novalidate", dateTime: "datetime", hrefLang: "hreflang" };
const EVENTS = { onClick: "click", onDoubleClick: "dblclick", onContextMenu: "contextmenu", onChange: "change", onInput: "input", onKeyDown: "keydown", onKeyUp: "keyup", onSubmit: "submit", onFocus: "focus", onBlur: "blur", onMouseEnter: "mouseenter", onMouseLeave: "mouseleave", onPointerDown: "pointerdown", onPointerUp: "pointerup", onPointerLeave: "pointerleave", onPointerCancel: "pointercancel", onDragOver: "dragover", onDrop: "drop", onPaste: "paste", onMouseDown: "mousedown", onMouseUp: "mouseup", onDragStart: "dragstart", onDragEnd: "dragend", onDragEnter: "dragenter", onDragLeave: "dragleave", onWheel: "wheel", onScroll: "scroll", onTouchStart: "touchstart", onTouchEnd: "touchend", onLoad: "load", onError: "error" };
const BLOCK = ["div", "section", "article", "header", "footer", "main", "nav", "aside", "figure", "figcaption", "details", "summary", "fieldset", "legend", "blockquote", "address"];
const INLINE = ["span", "strong", "em", "b", "i", "u", "s", "small", "code", "kbd", "mark", "abbr", "time", "sup", "sub", "q", "cite", "bdi", "output", "data", "var", "samp", "del", "ins"];
const UNITLESS = new Set(["opacity", "zIndex", "flex", "flexGrow", "flexShrink", "fontWeight", "lineHeight", "order", "zoom", "scale"]);
const kebab = (s) => s.replace(/^--/, "--").replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/^([a-z])/, "$1");
// lucide's own name of an imported icon (Loader2 → loader-circle, Trash2 → trash), as the icon catalog has it.
const lucideLib = await import("lucide-react");
const iconName = (pascal) => (lucideLib[pascal]?.displayName ?? pascal).replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/([a-zA-Z])([0-9])/g, "$1-$2").toLowerCase();

function elOf(tag) {
  if (BLOCK.includes(tag)) return ["panel", tag];
  if (INLINE.includes(tag)) return ["area", tag];
  if (/^h[1-6]$/.test(tag)) return ["heading", tag];
  const m = { p: "paragraph", pre: "paragraph", a: "link", img: "image", audio: "audio", video: "video", button: "button", input: "input", textarea: "textarea", select: "select", option: "option", label: "label", form: "form", ul: "list", ol: "list", li: "item", hr: "separator", table: "table", thead: "tableSection", tbody: "tableSection", tfoot: "tableSection", tr: "tableRow", td: "tableCell", th: "tableCell" }[tag];
  return m ? [m, tag] : [null, tag];
}

/*
 * A component of this file drawn in place takes the values it was given
 * where it is used: its parameters are substituted (title={…}, icon={<…/>},
 * the children). One map per level; a substituted value is translated where
 * it came from.
 */
const substStack = [];
const substOf = (name) => { const top = substStack[substStack.length - 1]; return top && top.has(name) ? top.get(name) : undefined; };
function inCaller(fn) { const top = substStack.pop(); try { return fn(); } finally { substStack.push(top); } }

/** A JS expression → the template language's (null when it cannot be said there). */
function expr(n, scope) {
  if ((n.type === "Identifier" && !scope.has(n.name)) || (n.type === "MemberExpression" && !n.computed && n.object.type === "Identifier" && n.object.name === "props")) {
    const sub = substOf(n.type === "Identifier" ? n.name : n.property.name);
    if (sub) {
      if (sub.kind === "lit") return sub.value === undefined ? "null" : typeof sub.value === "string" ? `'${String(sub.value).replace(/'/g, "\\'")}'` : String(sub.value);
      if (sub.kind === "expr") return inCaller(() => expr(sub.node, sub.scope));
      return "true"; // an element given (icon={<X/>}, children): there

    }
  }
  switch (n.type) {
    case "ParenthesizedExpression": return expr(n.expression, scope);
    case "TSAsExpression": case "TSNonNullExpression": case "TSSatisfiesExpression": return expr(n.expression, scope);
    case "Literal":
      if (n.value === null) return "null";
      if (typeof n.value === "string") return `'${n.value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
      return String(n.value);
    case "Identifier":
      if (n.name === "undefined") return "null";
      if (!scope.has(n.name)) vars.add(n.name);
      return `$${n.name}`;
    case "MemberExpression": {
      const obj = n.object;
      // props.x → $x
      if (obj.type === "Identifier" && obj.name === "props" && !n.computed) { vars.add(n.property.name); return `$${n.property.name}`; }
      const o = expr(obj, scope);
      if (o === null) return null;
      if (n.computed) { const p = expr(n.property, scope); return p === null ? null : `${o}[${p}]`; }
      if (n.property.name === "length") return `${o}|length`.includes("|") ? `${o}.length` : `${o}.length`;
      return `${o}.${n.property.name}`;
    }
    case "UnaryExpression":
      if (n.operator === "!") { const x = expr(n.argument, scope); return x === null ? null : `!${wrap(x)}`; }
      if (n.operator === "-") { const x = expr(n.argument, scope); return x === null ? null : `-${wrap(x)}`; }
      return null;
    case "CallExpression": {
      const c = n.callee;
      // t(lang, "key") → ('key'|t); tf(lang, "key", { a: x }) → ('key'|t|replace:'{a}':$x)
      if (c.type === "Identifier" && (c.name === "t" || c.name === "tf") && n.arguments.length >= 2) {
        const key = expr(n.arguments[1], scope);
        if (key === null) return null;
        let out = `${wrap(key)}|t`;
        if (c.name === "tf") {
          const vars = n.arguments[2];
          if (!vars || vars.type !== "ObjectExpression") return null;
          for (const p of vars.properties) {
            if (p.type !== "Property" || p.computed) return null;
            const v = expr(p.value, scope);
            if (v === null) return null;
            out += `|replace:'{${p.key.name ?? p.key.value}}':${wrap(v)}`;
          }
        }
        return `(${out})`;
      }
      // x.replace("a", y) → (x|replace:'a':y)
      if (c.type === "MemberExpression" && !c.computed && c.property.name === "replace" && n.arguments.length === 2 && n.arguments[0].type === "Literal") {
        const x = expr(c.object, scope); const b = expr(n.arguments[1], scope);
        return x === null || b === null ? null : `(${x.startsWith("(") && x.endsWith(")") ? x.slice(1, -1) : wrap(x)}|replace:'${n.arguments[0].value}':${wrap(b)})`;
      }
      // String(x) → x (printed as text anyway)
      if (c.type === "Identifier" && c.name === "String" && n.arguments.length === 1) return expr(n.arguments[0], scope);
      return null;
    }
    case "LogicalExpression": case "BinaryExpression": {
      if (n.operator === "??") {
        const a = expr(n.left, scope); const b = expr(n.right, scope);
        return a === null || b === null ? null : `${wrap(a)} == null ? ${wrap(b)} : ${wrap(a)}`;
      }
      if (n.operator === "in" || n.operator === "instanceof") return null;
      const a = expr(n.left, scope); const b = expr(n.right, scope);
      return a === null || b === null ? null : `${wrap(a)} ${n.operator} ${wrap(b)}`;
    }
    case "ConditionalExpression": {
      const c = expr(n.test, scope); const a = expr(n.consequent, scope); const b = expr(n.alternate, scope);
      return c === null || a === null || b === null ? null : `${wrap(c)} ? ${wrap(a)} : ${wrap(b)}`;
    }
    case "TemplateLiteral": return null;
    default: return null;
  }
}
const wrap = (x) => (/^[$!\w.'-]+$/.test(x) ? x : `(${x})`);

/** t(lang, "key") → the key; t(lang, cond ? "a" : "b") → an expression to translate. */
function translation(n, scope) {
  if (n.type !== "CallExpression" || n.callee.type !== "Identifier" || n.callee.name !== "t" || n.arguments.length !== 2) return null;
  const k = n.arguments[1];
  if (k.type === "Literal" && typeof k.value === "string") return { key: k.value };
  const e = expr(k, scope);
  return e === null ? null : { expr: e };
}

/** A JS value as template TEXT ("…{$x}…"), or null. */
function textOf(n, scope) {
  while (n.type === "ParenthesizedExpression") n = n.expression;
  if (n.type === "Literal") return typeof n.value === "string" ? n.value.replace(/\{/g, "{l}") : String(n.value);
  const tr = translation(n, scope);
  if (tr) return tr.key ? `{_'${tr.key}'}` : `{=${tr.expr}|t}`;
  if (n.type === "TemplateLiteral") {
    let out = "";
    for (let i = 0; i < n.quasis.length; i++) {
      out += n.quasis[i].value.cooked.replace(/\{/g, "{l}");
      if (i < n.expressions.length) {
        const part = textOf(n.expressions[i], scope);
        if (part === null) return null;
        out += part;
      }
    }
    return out;
  }
  if (n.type === "ConditionalExpression") {
    const c = expr(n.test, scope); const a = textOf(n.consequent, scope); const b = textOf(n.alternate, scope);
    if (c === null || a === null || b === null) return null;
    return b === "" ? `{if ${c}}${a}{/if}` : `{if ${c}}${a}{else}${b}{/if}`;
  }
  const e = expr(n, scope);
  if (e === null) return null;
  const key = /^\('([^'{}]*)'\|t\)$/.exec(e);
  if (key) return `{_'${key[1]}'}`;
  return /^\$[\w.]+$/.test(e) ? `{${e}}` : `{=${e}}`;
}

/** An attribute value: literal text, a template, or "=expression". */
function attrValue(v, scope, what) {
  if (!v) return "";
  if (v.type === "Literal") return String(v.value);
  const e = v.expression;
  if (e.type === "Literal" || e.type === "TemplateLiteral") return textOf(e, scope) ?? todo(what, e);
  const tr = translation(e, scope);
  if (tr) return tr.key ? `{_'${tr.key}'}` : `{=${tr.expr}|t}`;
  const x = expr(e, scope);
  if (x !== null) return `=${x}`;
  return todo(what, e);
}

function handler(e, scope, event) {
  // props.onX / onX / something.onX
  let name = null;
  let arg;
  const fromName = (s) => s.replace(/^on([A-Z])/, (_m, c) => c.toLowerCase());
  if (e.type === "Identifier") name = fromName(e.name);
  else if (e.type === "MemberExpression" && !e.computed) name = fromName(e.property.name);
  else if ((e.type === "ArrowFunctionExpression" || e.type === "FunctionExpression") && e.body.type === "CallExpression" && (e.body.callee.type === "Identifier" || e.body.callee.type === "MemberExpression")) {
    const callee = e.body.callee;
    name = fromName(callee.type === "Identifier" ? callee.name : callee.property.name);
    if (e.body.arguments.length === 1) {
      const a = expr(e.body.arguments[0], new Set([...scope, ...e.params.map((p) => p.name).filter(Boolean)]));
      arg = a ?? todo(`argument of ${event}`, e.body.arguments[0]);
    } else if (e.body.arguments.length > 1) arg = todo(`arguments of ${event}`, e.body);
  }
  if (!name) name = todo(`handler of ${event}`, e);
  if (!actions.has(name)) actions.set(name, code(e).replace(/\s+/g, " ").slice(0, 140));
  return arg ? { action: name, arg } : { action: name };
}

function styleOf(obj, scope, node) {
  if (obj.type !== "ObjectExpression") return todo("style", obj);
  const css = {};
  for (const p of obj.properties) {
    if (p.type !== "Property") return todo("style", obj);
    const key = p.computed ? (p.key.type === "Literal" ? p.key.value : null) : p.key.name ?? p.key.value;
    if (typeof key !== "string") return todo("style key", p);
    const prop = key.startsWith("--") ? key : kebab(key);
    const v = p.value;
    if (v.type === "Literal" && typeof v.value === "number") css[prop] = UNITLESS.has(key) ? String(v.value) : `${v.value}px`;
    else css[prop] = textOf(v, scope) ?? todo(`style ${key}`, v);
  }
  node.css = css;
  return null;
}

/** JSX → nodes (a list: conditions and repeats may make several, or none). */
function convert(n, scope, extra = {}) {
  while (n.type === "ParenthesizedExpression") n = n.expression;
  if (n.type === "JSXFragment") return [{ id: idFor("group"), el: "group", ...extra, children: children(n.children, scope) }];
  if (n.type === "LogicalExpression" && n.operator === "&&") {
    const c = expr(n.left, scope) ?? todo("condition", n.left);
    return convert(n.right, scope, { ...extra, if: extra.if ? `(${extra.if}) && (${c})` : c });
  }
  if (n.type === "ConditionalExpression") {
    const c = expr(n.test, scope) ?? todo("condition", n.test);
    const isNull = (x) => x.type === "Literal" && x.value === null;
    const a = isNull(n.consequent) ? [] : convertOrText(n.consequent, scope, { ...extra, if: extra.if ? `(${extra.if}) && (${c})` : c });
    const b = isNull(n.alternate) ? [] : convertOrText(n.alternate, scope, { ...extra, if: extra.if ? `(${extra.if}) && !(${c})` : `!${wrap(c)}` });
    return [...a, ...b];
  }
  if (n.type === "CallExpression" && n.callee.type === "MemberExpression" && n.callee.property.name === "map") {
    const list = expr(n.callee.object, scope) ?? todo("list", n.callee.object);
    const f = n.arguments[0];
    const as = f?.params?.[0]?.name ?? "item";
    const inner = new Set([...scope, as]);
    let body = f?.body;
    if (body?.type === "BlockStatement") { const ret = body.body.find((s) => s.type === "ReturnStatement"); body = ret?.argument; }
    if (!body) return [{ id: idFor("text"), el: "text", text: todo("map", n) }];
    const nodes = convert(body, inner, {});
    for (const x of nodes) { x.each = list; x.as = as; }
    return nodes.map((x) => ({ ...x, ...extra }));
  }
  if (n.type === "JSXElement") return [element(n, scope, extra)];
  return convertOrText(n, scope, extra);
}
function convertOrText(n, scope, extra) {
  while (n.type === "ParenthesizedExpression") n = n.expression;
  if ((n.type === "Identifier" && !scope.has(n.name)) || (n.type === "MemberExpression" && !n.computed && n.object.type === "Identifier" && n.object.name === "props")) {
    const sub = substOf(n.type === "Identifier" ? n.name : n.property.name);
    if (sub && (sub.kind === "jsx" || sub.kind === "children")) {
      const nodes = inCaller(() => (sub.kind === "jsx" ? convert(sub.node, sub.scope, {}) : children(sub.nodes, sub.scope)));
      if (!extra.if && !extra.each) return nodes;
      return [{ id: idFor("group"), el: "group", ...extra, children: nodes }];
    }
    if (sub && sub.kind === "lit" && sub.value === undefined) return [];
  }
  if (/^JSX/.test(n.type) || n.type === "ConditionalExpression" || (n.type === "LogicalExpression" && n.operator === "&&") || (n.type === "CallExpression" && n.callee.type === "MemberExpression" && n.callee.property?.name === "map")) return convert(n, scope, extra);
  if (n.type === "Literal" && n.value === null) return [];
  // props.share and the like: a live part.
  if (n.type === "MemberExpression" && n.object.type === "Identifier" && n.object.name === "props") {
    const name = n.property.name;
    slots.set(name, code(n));
    return [{ id: idFor(`part-${kebab(name)}`), el: "slot", slot: name, ...extra }];
  }
  const t = textOf(n, scope);
  return [{ id: idFor("text"), el: "text", text: t ?? todo("text", n), ...extra }];
}

function children(list, scope) {
  const out = [];
  for (const c of list) {
    if (c.type === "JSXText") {
      // React's whitespace: lines trimmed, lines joined by a space, blank lines dropped.
      const lines = c.value.split(/\r?\n/);
      const kept = lines.map((l, i) => (i === 0 ? l.replace(/\s+$/, "") : i === lines.length - 1 ? l.replace(/^\s+/, "") : l.trim())).filter((l, i, all) => l !== "" || (all.length === 1));
      const text = lines.length === 1 ? c.value : kept.filter(Boolean).join(" ");
      if (text) out.push({ id: idFor("text"), el: "text", text: text.replace(/\{/g, "{l}") });
      continue;
    }
    if (c.type === "JSXExpressionContainer") {
      if (c.expression.type === "JSXEmptyExpression") continue;
      out.push(...convertOrText(c.expression, scope, {}));
      continue;
    }
    out.push(...convert(c, scope, {}));
  }
  return out;
}

function element(n, scope, extra) {
  const nameNode = n.openingElement.name;
  const tag = nameNode.type === "JSXIdentifier" ? nameNode.name : code(nameNode);
  const attrs = n.openingElement.attributes;
  const get = (k) => attrs.find((a) => a.type === "JSXAttribute" && a.name.name === k);
  // A lucide icon.
  if (/^[A-Z]/.test(tag) && lucide.has(tag)) {
    const node = { id: "", el: "icon", props: { icon: iconName(lucideImported.get(tag) ?? tag) }, ...extra };
    const a = {};
    for (const at of attrs) {
      if (at.type !== "JSXAttribute") continue;
      const k = REACT_PROPS[at.name.name] ?? at.name.name;
      if (k === "key") continue;
      if (k === "strokeWidth") { node.props.strokeWidth = attrValue(at.value, scope, "strokeWidth"); continue; }
      if (k === "size" || k === "width" || k === "height") { node.props.size = attrValue(at.value, scope, "size").replace(/^=/, ""); continue; }
      a[k] = attrValue(at.value, scope, k);
    }
    if (Object.keys(a).length) node.attrs = a;
    node.id = idFor(`icon-${node.props.icon}`);
    return node;
  }
  // A component of this file: drawn in place (its props are the layout's values).
  const local = /^[A-Z]/.test(tag) ? findFunction(tag) : null;
  if (local && !inlining.has(tag)) {
    // What it is given here: attributes, and the children.
    const given = new Map();
    let spread = false;
    for (const at of attrs) {
      if (at.type === "JSXSpreadAttribute") { spread = true; continue; }
      const v = at.value;
      if (!v) given.set(at.name.name, { kind: "lit", value: true });
      else if (v.type === "Literal") given.set(at.name.name, { kind: "lit", value: v.value });
      else if (/JSX/.test(v.expression.type)) given.set(at.name.name, { kind: "jsx", node: v.expression, scope });
      else given.set(at.name.name, { kind: "expr", node: v.expression, scope });
    }
    if (n.children.some((c) => c.type !== "JSXText" || c.value.trim())) given.set("children", { kind: "children", nodes: n.children, scope });
    // Its parameters: ({ a, b = 1, c: local }) or (props).
    const map = new Map();
    const param = local.params[0];
    if (param?.type === "ObjectPattern") {
      for (const p of param.properties) {
        if (p.type !== "Property") continue;
        const key = p.key.name ?? p.key.value;
        let localName = p.value.type === "Identifier" ? p.value.name : p.value.type === "AssignmentPattern" ? p.value.left.name : key;
        const fallback = p.value.type === "AssignmentPattern" && p.value.right.type === "Literal" ? { kind: "lit", value: p.value.right.value } : null;
        if (given.has(key)) map.set(localName, given.get(key));
        else if (fallback) map.set(localName, fallback);
        else if (!spread) map.set(localName, { kind: "lit", value: undefined });
      }
    } else if (param?.type === "Identifier") {
      for (const [k, v] of given) map.set(k, v);
    }
    inlining.add(tag);
    substStack.push(map);
    let nodes;
    try { nodes = branchesToNodes(branchesOf(local), new Set(), extra); } finally { substStack.pop(); inlining.delete(tag); }
    return nodes.length === 1 ? nodes[0] : { id: idFor(tag.toLowerCase()), el: "group", name: tag, children: nodes };
  }
  // Another component: a live part of the layout.
  if (/^[A-Z]/.test(tag)) {
    const name = tag[0].toLowerCase() + tag.slice(1);
    slots.set(name, code(n.openingElement).replace(/\s+/g, " ").slice(0, 200));
    return { id: idFor(`part-${kebab(name)}`), el: "slot", slot: name, ...extra };
  }
  const [el, realTag] = elOf(tag);
  if (!el) {
    slots.set(tag, `<${tag}> is not in the palette`);
    return { id: idFor(`part-${tag}`), el: "slot", slot: tag, ...extra };
  }
  const node = { id: "", el, tag: realTag, ...extra };
  const a = {};
  const on = {};
  for (const at of attrs) {
    if (at.type === "JSXSpreadAttribute") { todo("spread", at); continue; }
    const k0 = at.name.name;
    if (k0 === "key") { if (node.each) node.key = attrValue(at.value, scope, "key").replace(/^=/, ""); continue; }
    if (k0 === "ref") { const v = at.value?.expression; node.ref = v?.type === "Identifier" ? v.name.replace(/Ref$/, "") : todo("ref", at); continue; }
    if (k0 === "style") { const v = at.value?.expression; if (v) { const r = styleOf(v, scope, node); if (r) node.styleBind = r; } continue; }
    if (EVENTS[k0]) { on[EVENTS[k0]] = handler(at.value.expression, scope, k0); continue; }
    if (k0 === "dangerouslySetInnerHTML") { todo("innerHTML", at); continue; }
    const k = REACT_PROPS[k0] ?? k0;
    if (!at.value) { a[k] = "=true"; continue; }
    a[k] = attrValue(at.value, scope, k);
  }
  if (Object.keys(a).length) node.attrs = a;
  if (Object.keys(on).length) node.on = on;
  node.id = idFor(el, a);
  const kids = children(n.children, scope);
  // One text alone: the element's text (when the element takes one).
  if (kids.length === 1 && kids[0].el === "text" && !kids[0].if && !kids[0].each && ["heading", "paragraph", "label", "link", "button", "option", "area", "panel", "item", "tableCell"].includes(el)) node.text = kids[0].text;
  else if (kids.length) node.children = kids;
  else if (!["image", "input", "textarea", "separator", "audio"].includes(el)) node.children = [];
  return node;
}

const inlining = new Set([component]);
let windowNote = "";
/** Branches → nodes, each with its condition. */
function branchesToNodes(list, scope, extra) {
  const out = [];
  for (const b of list) {
    let jsx = b.jsx;
    while (jsx.type === "ParenthesizedExpression") jsx = jsx.expression;
    if (jsx.type === "Literal" && jsx.value === null) continue;
    // A panel drawn inside a window: the layout is what is inside (the window has its own).
    if (jsx.type === "JSXElement" && ["Modal", "SimpleModal"].includes(jsx.openingElement.name.name) && list === branches) {
      windowNote = code(jsx.openingElement).replace(/\s+/g, " ").slice(0, 200);
      jsx = { type: "JSXFragment", children: jsx.children };
    }
    const parts = b.conds.map((c) => { const e = expr(c.n, scope) ?? todo("condition", c.n); return c.not ? `!${wrap(e)}` : e; });
    const cond = [extra.if, ...parts].filter(Boolean).map((x) => (parts.length + (extra.if ? 1 : 0) > 1 ? wrap(x) : x)).join(" && ");
    out.push(...convert(jsx, scope, cond ? { ...extra, if: cond } : { ...extra }));
  }
  return out;
}
/** Conditions that are known: never (null, false) drops the element, always (true) drops the condition. */
function tidy(list) {
  const out = [];
  for (const n of list) {
    if (n.if !== undefined) {
      const c = n.if.replace(/\s+/g, "");
      if (/^(null|false|!true|!\(true\))$/.test(c) || /(^|&&)(null|false|!true)(&&|$)/.test(c)) continue;
      if (/^(true|!null|!false)$/.test(c)) delete n.if;
      else n.if = n.if.replace(/(^|\s&&\s)\(?true\)?(?=\s&&\s|$)/g, "$1").replace(/^\s*&&\s*|\s*&&\s*$/g, "") || undefined;
      if (n.if === undefined) delete n.if;
    }
    if (n.children) n.children = tidy(n.children);
    out.push(n);
  }
  return out;
}
const out = tidy(branchesToNodes(branches, new Set(), {}));
const tree = out.length === 1 ? out[0] : { id: "root", el: "group", children: out };

/* ---------------------------------------------------------------- print */

if (flags.includes("--json")) {
  console.log(JSON.stringify({ tree, vars: [...vars], actions: Object.fromEntries(actions), slots: Object.fromEntries(slots), todos }, null, 2));
} else {
  const q = (s) => JSON.stringify(s);
  const print = (n, ind) => {
    const pad = "  ".repeat(ind);
    const { children: kids, el, ...rest } = n;
    if (el === "text" && Object.keys(rest).length === 2) return `${pad}text(${q(n.text)}, { id: ${q(n.id)} })`;
    const spec = JSON.stringify(rest).replace(/"([a-zA-Z_][\w]*)":/g, "$1:");
    if (!kids) return `${pad}n(${q(el)}, ${spec})`;
    if (!kids.length) return `${pad}n(${q(el)}, ${spec}, [])`;
    return `${pad}n(${q(el)}, ${spec}, [\n${kids.map((k) => print(k, ind + 1)).join(",\n")},\n${pad}])`;
  };
  console.log(`// ${component} (${file}) — a draft from script/jsx-to-layout.mjs\n`);
  console.log(print(tree, 1));
  if (windowNote) console.log(`\n// drawn inside the window: ${windowNote}`);
  console.log(`\n// values: ${[...vars].join(", ")}`);
  console.log(`// actions:\n${[...actions].map(([k, v]) => `//   ${k}  ←  ${v}`).join("\n")}`);
  console.log(`// parts:\n${[...slots].map(([k, v]) => `//   ${k}  ←  ${v}`).join("\n")}`);
  console.log(`// TODO:\n${todos.map((t, i) => `//   TODO${i + 1} ${t}`).join("\n")}`);
}
