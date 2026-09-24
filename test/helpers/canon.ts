// Canonical form of a DOM subtree for parity checks: attributes as a sorted
// set, adjacent text merged, comments dropped.
export function canon(n: Node): string {
  if (n.nodeType === 3) return JSON.stringify(n.textContent);
  if (n.nodeType !== 1) return "";
  const el = n as Element;
  const attrs = Array.from(el.attributes).map((a) => `${a.name}=${JSON.stringify(a.value)}`).sort().join(" ");
  return `<${el.tagName.toLowerCase()}${attrs ? " " + attrs : ""}>${children(el)}</${el.tagName.toLowerCase()}>`;
}
/** Child nodes, adjacent (and empty) texts merged as normalize() would — without changing the DOM React still writes to. */
function children(parent: Node): string {
  let out = "";
  let text: string | null = null;
  for (const c of Array.from(parent.childNodes)) {
    if (c.nodeType === 3) { text = (text ?? "") + (c.textContent ?? ""); continue; }
    if (c.nodeType !== 1) continue;
    if (text) out += JSON.stringify(text);
    text = null;
    out += canon(c);
  }
  if (text) out += JSON.stringify(text);
  return out;
}
export function canonOf(container: Element): string {
  return children(container);
}
/** First difference, with context. */
export function diff(a: string, b: string): string {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `at ${i}:\n  old: …${a.slice(Math.max(0, i - 120), i + 120)}\n  new: …${b.slice(Math.max(0, i - 120), i + 120)}`;
}
