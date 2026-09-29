// @vitest-environment node
// The built-in packages (server/functions/builtins, 5.2): the generated
// sources match ./src, installing them creates packages, versions and
// switched-on models, /help lists what the caller may run (via
// m5.functions.list), and the demos work — the web analysis against a local
// page here; the DNS / RDAP ones against the internet when NET_TESTS=1.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const DATA = mkdtempSync(join(tmpdir(), "m5bi-"));
process.env.DATA_DIR = DATA;
process.env.FUNCTIONS_DB_FILE = join(DATA, "functions.db");
process.env.FUNCTIONS_WARM = "0";
process.env.FUNCTIONS_HTTP_ALLOW_LOCAL = "1";

const { functionsStore } = await import("../server/functions/store");
const { installBuiltin, builtinCatalog, BUILTINS, seedBuiltins } = await import("../server/functions/builtins");
const { execute, closeRunner } = await import("../server/functions/runner");
// @ts-expect-error — a plain .mjs script
const { renderSources } = await import("../script/gen-builtins.mjs");

const console_ = { kind: "console" as const, account: "", name: "tester", groups: ["owner"], room: null, client: "t", lang: "en", tz: "UTC" };
const text = (outs: unknown[]) => outs.map((o) => (o as { text?: string }).text ?? "").join("\n");
const run = async (keyword: string, inputs: Record<string, unknown>) => {
  const m = functionsStore.modelByKeyword(keyword)!;
  expect(m, keyword).toBeTruthy();
  return execute(m, inputs, console_, { executor: "console", test: true });
};

let server: Server;
let site = "";
beforeAll(async () => {
  await functionsStore.ready();
  server = createServer((req, res) => {
    if (req.url === "/robots.txt") { res.writeHead(200, { "content-type": "text/plain" }); res.end("User-agent: *\nDisallow: /private\nSitemap: http://example.test/sitemap.xml\n"); return; }
    if (req.url === "/sitemap.xml") { res.writeHead(200, { "content-type": "application/xml" }); res.end("<urlset/>"); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", server: "nginx/1.27", "x-powered-by": "PHP/8.3", "x-frame-options": "DENY", "x-content-type-options": "nosniff" });
    res.end(`<!doctype html><html lang="cs"><head><title>Kavárna &amp; pekárna</title>
      <meta name="description" content="Nejlepší káva ve městě"><meta name="generator" content="WordPress 6.6">
      <meta property="og:site_name" content="Kavárna"><meta name="viewport" content="width=device-width">
      <link rel="canonical" href="https://kavarna.example/"><script src="/wp-includes/js/jquery/jquery.min.js"></script></head>
      <body><h1>Vítejte</h1><img src="a.jpg"><a href="/menu">Menu</a><a href="https://www.facebook.com/kavarna">FB</a>
      <a href="https://instagram.com/kavarna/">IG</a><a href="https://www.facebook.com/sharer/sharer.php?u=x">share</a>
      <a href="mailto:info@kavarna.example">mail</a><a href="tel:+420123456789">call</a><a href="https://maps.google.com/?q=x">map</a></body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server?.close(); closeRunner(); });

describe("built-in packages", () => {
  it("the generated sources match src/ (run npm run gen:builtins)", () => {
    expect(readFileSync(join(process.cwd(), "server/functions/builtins/sources.ts"), "utf8")).toBe(renderSources());
  });

  it("install: packages, published versions, dependencies and switched-on models", async () => {
    const results = await seedBuiltins("test");
    expect(results).not.toBeNull();
    const cat = builtinCatalog();
    for (const def of BUILTINS) {
      const c = cat.find((x) => x.name === def.name)!;
      expect(c.installed, def.name).toBe(true);
      expect(c.current, def.name).toBe(true);
      if (def.model) expect(c.model?.enabled, def.name).toBe(true);
    }
    const dns = functionsStore.versionByName("dns", "1.2.0")!;
    expect(dns.manifest.dependencies).toEqual({ netkit: "1.2.0" });
    // A second seed does nothing; installing again changes nothing.
    expect(await seedBuiltins("test")).toEqual([]);
    expect(installBuiltin("whois", "test").every((r) => r.package === "unchanged")).toBe(true);
  });

  it("/help lists the commands and explains one", async () => {
    const all = await run("help", {});
    expect(all.run.error ?? null).toBeNull();
    const t = text(all.outputs);
    for (const kw of ["/dns", "/whois", "/web", "/mail", "/domain", "/help"]) expect(t).toContain(kw);
    const one = await run("help", { topic: "dns" });
    expect(text(one.outputs)).toMatch(/\/dns — DNS lookup[\s\S]*`type`[\s\S]*full, A, AAAA/);
    const hooks = await run("help", { topic: "webhooks" });
    expect(text(hooks.outputs)).toContain("Webhook");
    // 6.0: the Android app and several rooms at once.
    expect(text((await run("help", { topic: "android" })).outputs)).toMatch(/Android app[\s\S]*erases all its data/);
    expect(text((await run("help", { topic: "rooms" })).outputs)).toMatch(/Several rooms at once[\s\S]*unread/);
    expect(text((await run("help", { topic: "telephony" })).outputs)).toMatch(/m5\.telephony[\s\S]*5-digit code[\s\S]*not end-to-end encrypted/);
    expect(text((await run("help", { topic: "adm" })).outputs)).toMatch(/only if an owner granted it[\s\S]*fn:<model>\/<caller>/);
  }, 60_000);

  it("/web reads a page: technologies, security headers, meta, links, social networks", async () => {
    const r = await run("web", { url: site });
    expect(r.run.error ?? null).toBeNull();
    const t = text(r.outputs);
    expect(t).toContain("Kavárna & pekárna");
    expect(t).toMatch(/WordPress/);
    expect(t).toMatch(/jQuery/);
    expect(t).toMatch(/nginx/);
    expect(t).toMatch(/X-Frame-Options \| ✅/);
    expect(t).toMatch(/HSTS \| ❌/);
    expect(t).toContain("Facebook");
    expect(t).toContain("https://instagram.com/kavarna");
    expect(t).not.toContain("sharer");
    expect(t).toContain("info@kavarna.example");
    expect(t).toMatch(/robots\.txt \| ✅/);
  }, 60_000);

  it("1.1: /help answers with topic buttons; a click and a reply reach its entry points", async () => {
    const m = functionsStore.modelByKeyword("help")!;
    const { endpointsOf } = await import("../server/functions/endpoints");
    expect(endpointsOf(m).map((e) => e.type)).toEqual(expect.arrayContaining(["execute", "response", "button", "error"]));
    const r = await run("help", {});
    expect(r.values.map((o) => o.type)).toEqual(["markdown", "button", "button", "button", "button", "button", "button", "button", "button", "button", "button", "button", "button", "button", "button", "button", "button", "button"].slice(0, r.values.length));
    const topic = r.values.find((o) => o.type === "button" && (o as { data?: { topic?: string } }).data?.topic === "forms") as { name: string; data: unknown };
    expect(topic).toBeTruthy();
    const ep = (type: string) => endpointsOf(m).find((e) => e.type === type)!;
    const clicked = await execute(m, { name: topic.name, data: topic.data, event: { type: "click" } }, console_, { executor: "console", endpoint: ep("button"), chainId: r.chain, skipValidation: true });
    expect(text(clicked.outputs)).toMatch(/## 📝 Forms/);
    expect(functionsStore.chain(r.chain)!.calls.map((c) => c.type)).toEqual(["execute", "button"]);
    const replied = await execute(m, { text: "dns", message: { text: "", call: 0 } }, console_, { executor: "console", endpoint: ep("response"), chainId: r.chain, skipValidation: true });
    expect(text(replied.outputs)).toMatch(/\/dns — DNS lookup/);
  }, 60_000);

  it("1.1: a missing input is asked for with a form (a form entry point answers it)", async () => {
    const r = await run("mail", {});
    expect(r.values[0]).toMatchObject({ type: "form", name: "ask", fields: [{ name: "domain", required: true }] });
  }, 30_000);

  it("1.1: an older install is updated on the next start (unless it was deleted)", async () => {
    const { writeFileSync } = await import("node:fs");
    const marker = join(DATA, "functions", "builtins.json");
    writeFileSync(marker, JSON.stringify({ netkit: "1.0.0", help: "1.0.0", whois: "1.0.0", dns: "1.0.0", web: "1.0.0", mail: "1.0.0", domain: "1.0.0" }));
    const results = await seedBuiltins("test");
    expect(results!.every((x) => x.package === "unchanged")).toBe(true); // 1.2.0 is there already
    expect(JSON.parse(readFileSync(marker, "utf8")).dns).toBe("1.2.0");
  }, 60_000);

  it("a missing input without anyone to ask is a clear error", async () => {
    const m = functionsStore.modelByKeyword("mail")!;
    const r = await execute(m, {}, { ...console_, kind: "api" }, { executor: "api", skipValidation: true });
    expect(r.run.status).toBe("failed");
    expect(r.run.error?.message).toMatch(/Domain is required/);
  }, 30_000);
});

describe.skipIf(process.env.NET_TESTS !== "1")("demos on the internet", () => {
  beforeAll(async () => { await seedBuiltins("test"); if (!functionsStore.modelByKeyword("dns")) installBuiltin("dns", "test"); });
  it("/dns, /whois, /mail, /domain", async () => {
    const dns = text((await run("dns", { name: "cloudflare.com", type: "full" })).outputs);
    expect(dns).toMatch(/\| NS \|/);
    const who = text((await run("whois", { query: "cloudflare.com" })).outputs);
    expect(who).toMatch(/Registrar/);
    const mail = text((await run("mail", { domain: "google.com" })).outputs);
    expect(mail).toMatch(/Google Workspace/);
    const dom = await run("domain", { domain: "example.com" });
    expect(dom.run.error ?? null).toBeNull();
    expect(text(dom.outputs)).toMatch(/## Registration[\s\S]*## DNS[\s\S]*## Web[\s\S]*## Hosting[\s\S]*## E-mail/);
  }, 240_000);
});
