// /dns — DNS records of a host: everything at once (full) or one type
// (A, AAAA, CNAME, MX, NS, TXT, SOA, CAA, SRV, PTR); an IP address gets its
// reverse name (PTR).
//
// Entry points (1.1): execute — the lookup; button — another record type of
// the same host (the buttons under a result); form — the host asked for when
// it is missing; response — a reply to the result looks up the host in it
// ("example.org" or "example.org MX"); error — what went wrong, kindly.
import { cleanHost, isIp, dnsAll, lookup, lines, mdTable, DNS_TYPES, ask, buttons, sorry } from "pkg:netkit";

const CHOICES = ["full", "A", "AAAA", "MX", "NS", "TXT", "CNAME", "SOA", "CAA"];

export async function execute({ name, type = "full" } = {}) {
  const host = cleanHost(name || "");
  if (!host) return ask("DNS lookup", [
    { name: "name", label: "Host name or IP address", placeholder: "example.com" },
    { name: "type", type: "select", label: "Record type", default: "full", options: CHOICES.map((c) => ({ value: c, label: c === "full" ? "everything" : c })) },
  ], "Look up");
  const t = String(type || "full").toUpperCase();
  if (isIp(host)) {
    const r = await lookup(host, "PTR");
    return m5.out.markdown(`## 🧭 ${host}\n\n${mdTable(["Type", "Value"], r.ok ? lines("PTR", r).map((v) => ["PTR", v]) : [["PTR", r.error || "no reverse name"]])}`);
  }
  const types = t === "FULL" ? DNS_TYPES : [t];
  m5.run.progress(0.3, `resolving ${types.join(", ")}…`);
  const all = await dnsAll(host, types);
  const rows = [];
  const missing = [];
  for (const ty of types) {
    const r = all[ty];
    const values = lines(ty, r);
    if (values.length) for (const v of values) rows.push([ty, v]);
    else missing.push(`${ty}${r.error && !/ENODATA|ENOTFOUND|no data/i.test(r.error) ? ` (${r.error})` : ""}`);
  }
  // www and the mail servers' addresses help most in a full lookup.
  if (t === "FULL" && !host.startsWith("www.")) {
    const www = await lookup(`www.${host}`, "CNAME");
    const wwwA = www.ok && www.records.length ? null : await lookup(`www.${host}`, "A");
    if (www.ok && www.records.length) rows.push(["www CNAME", www.records.join(", ")]);
    else if (wwwA && wwwA.ok) rows.push(["www A", wwwA.records.join(", ")]);
  }
  const md = [`## 🧭 DNS — ${host}${t === "FULL" ? "" : ` (${t})`}`, mdTable(["Type", "Value"], rows)];
  if (missing.length) md.push(`_No records: ${missing.join(", ")}_`);
  md.push("_Reply to this message with another host (and a type) to look it up._");
  m5.run.progress(1, "done");
  // A list: the table, then buttons for the other types of the same host.
  return [
    m5.out.markdown(md.join("\n\n")),
    buttons(CHOICES.filter((c) => c.toUpperCase() !== t).map((c) => ({ name: "type", title: c === "full" ? "everything" : c, data: { name: host, type: c } }))),
  ];
}

export async function button({ name, data } = {}) {
  if (name === "type" && data) return execute({ name: data.name, type: data.type });
  return execute({ name: data && data.name });
}

export async function form({ values } = {}) {
  return execute(values || {});
}

export async function response({ name, type } = {}) {
  // "example.org" or "example.org MX" (the response entry point's inputs read the reply); the type defaults to the first call's.
  const first = m5.model.first;
  return execute({ name, type: type || (first && first.parms && first.parms.type) || "full" });
}

export async function error({ error } = {}) {
  return sorry(error, "Check the host name — e.g. **example.com** — or reply to the result with another one.");
}
