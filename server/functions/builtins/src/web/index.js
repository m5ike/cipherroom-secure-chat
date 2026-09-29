// /web — a web page analysed: status, redirects, speed, size, server and
// technologies, security headers (score), title and meta tags, Open Graph,
// robots.txt and sitemap, links (internal, external, e-mail, phone), social
// networks.
//
// Entry points (1.1): execute; form — the address asked for when it is
// missing; button — "security" (the headers in detail) and "check again";
// response — a reply with another address; error.
import { webInfo, mdTable, yes, bar, ask, buttons, sorry } from "pkg:netkit";

export async function execute({ url } = {}) {
  const target = String(url || "").trim();
  if (!target) return ask("Web analysis", [{ name: "url", type: "url", label: "Web address", placeholder: "https://example.com" }], "Analyse");
  m5.run.progress(0.1, "fetching the page…");
  const w = await webInfo(target);
  m5.run.progress(0.9, "reading it…");
  const p = w.page;
  const md = [`## 🌍 ${p.title || w.url}`, `**${w.url}** — HTTP ${w.status}${w.redirected ? ` (redirected from ${w.input})` : ""}`];
  md.push(mdTable(["", ""], [
    ["Response", `${w.ms ?? "—"} ms · ${Math.round((w.bytes || 0) / 1024)} kB · ${w.contentType || "—"}`],
    ["Server", [w.server, w.poweredBy].filter(Boolean).join(" · ")],
    ["HTTPS", yes(w.security.https)],
    ["Language", p.lang], ["Description", p.description.slice(0, 200)],
    ["Generator", p.generator], ["Canonical", p.canonical],
    ["Open Graph", [p.og.site, p.og.type, p.og.title].filter(Boolean).join(" · ")],
    ["Mobile viewport", yes(p.viewport)], ["Robots meta", p.robotsMeta],
    ["Page", `${p.h1} × H1 · ${p.images} images · ${p.forms} forms · ${p.scripts.length} scripts`],
    ["robots.txt", w.robots ? `✅ ${w.robots.lines} lines${w.robots.disallowAll ? " — ⚠️ disallows everything" : ""}` : "❌"],
    ["Sitemap", w.sitemap || (w.robots && w.robots.sitemaps.length) ? `✅ ${(w.robots && w.robots.sitemaps[0]) || "/sitemap.xml"}` : "❌"],
    ["Feeds", p.feeds.join(", ")],
  ]));
  md.push(`### 🛡️ Security headers — ${bar(w.security.score)}`);
  md.push(mdTable(["Header", "Set", "Why"], w.security.rows.map((r) => [r.label, r.present ? `✅ ${r.value.slice(0, 60)}` : "❌", r.why])));
  md.push("### 🧩 Technologies");
  md.push(w.tech.length ? mdTable(["Technology", "Kind"], w.tech.map((t) => [t.name, t.category])) : "_nothing recognised_");
  md.push("### 🔗 Links");
  md.push(mdTable(["", ""], [
    ["Internal", w.links.internal], ["External", w.links.external],
    ["E-mail", w.links.mailto.join(", ")], ["Phone", w.links.tel.join(", ")],
    ["Most linked sites", w.links.topExternal.map(([d, n]) => `${d} (${n})`).join(", ")],
  ]));
  if (w.social.length) { md.push("### 👥 Social networks"); md.push(mdTable(["Network", "Link"], w.social.map((s) => [s.network, s.url]))); }
  m5.run.progress(1, "done");
  await m5.model.cache.set("security", w.security, { ttl: "1h" });
  return [
    m5.out.markdown(md.join("\n\n")),
    buttons([{ name: "security", title: "Security in detail", icon: "🛡️", data: { url: w.url } }, { name: "again", title: "Check again", icon: "↻", data: { url: w.url } }]),
  ];
}

export async function button({ name, data } = {}) {
  if (name === "security") {
    const s = await m5.model.cache.get("security");
    if (!s) return execute({ url: data && data.url });
    return [
      m5.out.table(["Header", "Value", "Why"], s.rows.map((r) => [r.label, r.present ? r.value : "— missing", r.why]), { title: `Security headers — ${s.score}/100` }),
      s.missing && s.missing.length ? m5.out.flash(`Missing: ${s.missing.join(", ")}`, "warning") : m5.out.flash("Every header we check is set", "success"),
    ];
  }
  return execute({ url: data && data.url });
}

export async function form({ values } = {}) { return execute(values || {}); }

export async function response({ text } = {}) { return execute({ url: String(text || "").trim().split(/\s+/)[0] }); }

export async function error({ error } = {}) {
  return sorry(error, "Give a public web address — e.g. **https://example.com** or **example.com**.");
}
