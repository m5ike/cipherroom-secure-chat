// Canonical form of a DOM subtree for parity checks: attributes as a sorted
// set, adjacent text merged, comments dropped.
export function canon(n: Node): string {
  if (n.nodeType === 3) return JSON.stringify(n.textContent);
  if (n.nodeType !== 1) return "";
  const el = n as Element;
  const attrs = Array.from(el.attributes).map((a) => `${a.name}=${JSON.stringify(a.value)}`).sort().join(" ");
  return `<${el.tagName.toLowerCase()}${attrs ? " " + attrs : ""}>${Array.from(el.childNodes).map(canon).join("")}</${el.tagName.toLowerCase()}>`;
}
export function canonOf(container: Element): string {
  container.normalize();
  return Array.from(container.childNodes).map(canon).join("");
}
/** First difference, with context. */
export function diff(a: string, b: string): string {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `at ${i}:\n  old: …${a.slice(Math.max(0, i - 120), i + 120)}\n  new: …${b.slice(Math.max(0, i - 120), i + 120)}`;
}
