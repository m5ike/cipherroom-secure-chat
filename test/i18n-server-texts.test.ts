// @vitest-environment node
//
// 6.13: what the server itself says to a person, in the nine languages of
// the contract (client/src/lib/locales.ts) — notification templates (every
// kind, title and body), the e-mail channel's own mail and page, the
// goodbye page, the phone's spoken prompts — and that every byte of it goes
// out as UTF-8: an e-mail with "Příliš žluťoučký kůň" or "Ärger ñ ç œ" in the
// subject and the sender's name comes back the same after RFC 2047 / base64.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const dir = mkdtempSync(join(tmpdir(), "m5-i18n-server-"));
process.env.DATA_DIR = dir;

const { LOCALES, LOCALE_INFO } = await import("../client/src/lib/locales");
const tpl = await import("../client/src/lib/notify-template");
const smtp = await import("../server/notify/smtp");
const lang = await import("../server/notify/lang");
const { NotifyStore } = await import("../server/notify/store");
const { confirmationMail } = await import("../server/notify/routes");
const share = await import("../server/share");
const speech = await import("../server/telephony/speech-texts");
const { TSA_CATALOG } = await import("../server/telephony/tsa/catalog");
const { LOCAL_MODELS } = await import("../server/ai/local-speech");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The {variables} of a template, and its optional parts' count — what a translation must keep. */
const shape = (s: string) => ({ vars: [...s.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort(), parts: (s.match(/\[/g) ?? []).length });

describe("notification templates speak nine languages", () => {
  it("NOTIFY_LANGS is the contract's languages", () => {
    expect([...tpl.NOTIFY_LANGS].sort()).toEqual([...LOCALES].sort());
    for (const l of LOCALES) expect(tpl.isLang(l)).toBe(true);
    expect(tpl.isLang("pl")).toBe(false);
  });

  it("every kind has a title and a body in every language, with English's variables and optional parts", () => {
    for (const kind of tpl.NOTIFY_KINDS) {
      for (const part of ["title", "body"] as const) {
        const texts = tpl.DEFAULT_TEMPLATES[kind][part];
        for (const l of LOCALES) {
          expect(texts[l], `${kind}.${part}.${l}`).toBeTruthy();
          expect(shape(texts[l]), `${kind}.${part}.${l}`).toEqual(shape(texts.en));
        }
      }
      // the bodies are translated, not copied (the titles are only variables)
      expect(new Set(LOCALES.map((l) => tpl.DEFAULT_TEMPLATES[kind].body[l])).size, kind).toBeGreaterThanOrEqual(8);
    }
  });

  it("renders each language with its own words and characters", () => {
    const vars = { app: "M5cet", sender: "Žofie" };
    const body = (l: (typeof LOCALES)[number], kind: "message" | "call" = "message") => tpl.renderNotification(tpl.DEFAULT_TEMPLATES[kind], l, vars, "neutral").body;
    expect(body("cs")).toBe("Nová zpráva");
    expect(body("sk")).toBe("Nová správa");
    expect(body("sl")).toBe("Novo sporočilo");
    expect(body("fi")).toBe("Uusi viesti");
    expect(body("es")).toBe("Mensaje nuevo");
    expect(body("it")).toBe("Nuovo messaggio");
    expect(body("fr")).toBe("Nouveau message");
    expect(tpl.renderNotification(tpl.DEFAULT_TEMPLATES.call, "fr", vars, "sender").body).toBe("Žofie vous appelle");
    expect(tpl.renderNotification(tpl.DEFAULT_TEMPLATES.call, "sl", vars, "neutral").body).toBe("Nekdo vas kliče");
  });

  it("a template saved with three languages falls back along the chain (Slovak → Czech → English)", () => {
    const old = { title: { cs: "{app}", en: "{app}", de: "{app}" }, body: { cs: "Zpráva od {sender|někoho}", en: "From {sender|someone}", de: "Von {sender|jemandem}", es: "" } } as never;
    expect(tpl.renderNotification(old, "sk", { app: "A", sender: "Ľuboš" }, "sender").body).toBe("Zpráva od Ľuboš");
    expect(tpl.renderNotification(old, "es", { app: "A" }, "neutral").body).toBe("From someone"); // empty = missing
    expect(tpl.renderNotification(old, "fi", { app: "A" }, "neutral").title).toBe("A");
    expect(tpl.templateText({ cs: "c", en: "e" }, "xx")).toBe("e");
  });

  it("a user's language is any of the nine, else English", () => {
    expect(tpl.sanitizeUserPrefs({ lang: "fi" }).lang).toBe("fi");
    expect(tpl.sanitizeUserPrefs({ lang: "sk" }).lang).toBe("sk");
    expect(tpl.sanitizeUserPrefs({ lang: "pl" }).lang).toBe("en");
  });
});

describe("the language a person gets", () => {
  it("Accept-Language picks the first supported language", () => {
    expect(lang.acceptedLocale("sk-SK,sk;q=0.9,cs;q=0.8,en;q=0.7")).toBe("sk");
    expect(lang.acceptedLocale("pl-PL, fi;q=0.5")).toBe("fi");
    expect(lang.acceptedLocale("pl, ja")).toBeNull();
    expect(lang.acceptedLocale(undefined)).toBeNull();
    expect(lang.requestLocale({ header: () => "fr-CH, fr;q=0.9" } as never)).toBe("fr");
    expect(lang.requestLocale({ header: () => undefined } as never)).toBe("en");
  });

  it("notifications follow the account's requests until the user chooses a language", () => {
    const store = new NotifyStore(() => join(dir, "hint"));
    expect(store.prefs("acc1").lang).toBe("en");
    store.noteLanguage("acc1", "sl");
    expect(store.prefs("acc1").lang).toBe("sl");
    expect(store.hasPrefs("acc1")).toBe(false);
    // kept across a restart
    expect(new NotifyStore(() => join(dir, "hint")).prefs("acc1").lang).toBe("sl");
    store.setPrefs("acc1", { lang: "de" });
    store.noteLanguage("acc1", "fi");
    expect(store.prefs("acc1").lang).toBe("de"); // the user's own choice wins
    store.noteLanguage("acc2", null);
    expect(store.prefs("acc2").lang).toBe("en");
  });

  it("the confirmation mail speaks the user's language", () => {
    for (const l of LOCALES) {
      const m = confirmationMail("M5cet <bot@example.org>", "a@example.org", "https://chat.example.org/api/notify/email/confirm?t=x", "M5cet", l);
      expect(m.subject).toBe(lang.notifyText("mailSubject", l));
      expect(m.text).toContain(lang.notifyText("mailIntro", l));
      expect(m.html).toContain(`<html lang="${LOCALE_INFO[l].tag}">`);
      expect(m.html).toContain('<meta charset="utf-8">');
    }
    expect(confirmationMail("b@x.org", "a@x.org", "https://x/y", "Firma", "cs").subject).toBe("Firma: potvrzení upozornění e-mailem");
    for (const key of Object.keys(lang.NOTIFY_TEXTS) as Array<keyof typeof lang.NOTIFY_TEXTS>) {
      for (const l of LOCALES) expect(lang.NOTIFY_TEXTS[key][l], `${key}.${l}`).toBeTruthy();
      expect(new Set(LOCALES.map((l) => lang.NOTIFY_TEXTS[key][l])).size, key).toBeGreaterThanOrEqual(8);
    }
  });
});

/* -------------------------------------------------------------- e-mail */

/** An RFC 2047 decoder written here (not the server's): B and Q words, whitespace between words dropped. */
function decode2047(v: string): string {
  return v.replace(/\r\n[ \t]/g, " ").replace(/\?=\s+=\?/g, "?==?").replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_w, cs: string, e: string, t: string) => {
    expect(cs.toLowerCase()).toBe("utf-8");
    const bytes = e.toUpperCase() === "B" ? Buffer.from(t, "base64") : Buffer.from(t.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  });
}

/** The headers of a message (unfolded) and its MIME parts. */
function parse(raw: string) {
  const [head, ...rest] = raw.split("\r\n\r\n");
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r\n[ \t]/g, " ").split("\r\n")) { const i = line.indexOf(":"); headers.set(line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()); }
  const boundary = /boundary="([^"]+)"/.exec(headers.get("content-type") ?? "")![1];
  const body = rest.join("\r\n\r\n");
  const parts = body.split(`--${boundary}`).slice(1, -1).map((p) => {
    const [h, b] = p.replace(/^\r\n/, "").split("\r\n\r\n");
    return { headers: h, text: Buffer.from(b.replace(/\s+/g, ""), "base64").toString("utf8") };
  });
  return { head, headers, parts };
}

describe("an e-mail is UTF-8 end to end", () => {
  const subjects = [
    "Příliš žluťoučký kůň",
    "Ärger ñ ç œ",
    "Příliš žluťoučký kůň úpěl ďábelské ódy — Ärger ñ ç œ, ľahký ôsmy kôň, Slovenščina čšž, Hyvää päivää ÅÄÖ, « Ça va ? »",
  ];

  for (const subject of subjects) {
    it(`"${subject.slice(0, 30)}…" round-trips (subject, sender's name, body)`, () => {
      const text = `${subject}\nŘádek dvě ñ œ\n`;
      const raw = smtp.buildMessage({ from: "Žluťoučký Kůň <bot@example.org>", to: "Ärger Œuvre <a@example.org>", subject, text, html: `<p>${subject}</p>` });
      // nothing but 7-bit ASCII on the wire
      expect(/^[\x00-\x7f]*$/.test(raw)).toBe(true); // eslint-disable-line no-control-regex
      const m = parse(raw);
      expect(decode2047(m.headers.get("subject")!)).toBe(subject);
      expect(smtp.decodeHeader(m.headers.get("subject")!)).toBe(subject);
      expect(decode2047(m.headers.get("from")!)).toBe("Žluťoučký Kůň <bot@example.org>");
      expect(decode2047(m.headers.get("to")!)).toBe("Ärger Œuvre <a@example.org>");
      // every encoded word within RFC 2047's 75 characters, every header line within 78
      for (const w of m.head.match(/=\?[^?]+\?[BQ]\?[^?]*\?=/g) ?? []) expect(w.length).toBeLessThanOrEqual(75);
      for (const line of m.head.split("\r\n")) expect(line.length).toBeLessThanOrEqual(78);
      expect(m.headers.get("mime-version")).toBe("1.0");
      expect(m.parts).toHaveLength(2);
      expect(m.parts[0].headers).toContain("Content-Type: text/plain; charset=utf-8");
      expect(m.parts[0].headers).toContain("Content-Transfer-Encoding: base64");
      expect(m.parts[0].text).toBe(text);
      expect(m.parts[1].headers).toContain("Content-Type: text/html; charset=utf-8");
      expect(m.parts[1].text).toBe(`<p>${subject}</p>`);
    });
  }

  it("ASCII stays readable; a name with specials is quoted; no header injection", () => {
    expect(smtp.encodeHeader("Plain subject")).toBe("Plain subject");
    const raw = smtp.buildMessage({ from: "Firma, s.r.o. <bot@example.org>", to: "a@example.org", subject: "Hi\r\nBcc: x@example.org", text: "x" });
    const m = parse(raw);
    expect(m.headers.get("from")).toBe('"Firma, s.r.o." <bot@example.org>');
    expect(m.headers.has("bcc")).toBe(false);
    // a word never splits a character's bytes
    const words = smtp.encodeHeader("ž".repeat(60)).split("\r\n ");
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) expect(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(/\?B\?(.*)\?=/.exec(w)![1], "base64"))).toMatch(/^ž+$/);
  });
});

/* ----------------------------------------------------------- the pages */

describe("the server's pages are in the visitor's language, as UTF-8", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    const express = (await import("express")).default;
    const app = express();
    share.registerGoodbyeRoute(app);
    app.get("/json", (_req, res) => { res.json({ text: "Příliš žluťoučký kůň" }); });
    server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server?.close());

  it("the goodbye page: each language's text, <html lang>, <meta charset>, Content-Type charset, Vary", async () => {
    for (const [accept, l] of [["sk-SK,cs;q=0.5", "sk"], ["fi", "fi"], ["fr-CA", "fr"], ["pl-PL", "en"], ["", "en"], ["sl-SI", "sl"]] as const) {
      const res = await fetch(`${base}/goodbye`, { headers: accept ? { "accept-language": accept } : {} });
      const html = new TextDecoder("utf-8", { fatal: true }).decode(await res.arrayBuffer());
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("content-language")).toBe(LOCALE_INFO[l].tag);
      expect(res.headers.get("vary")).toMatch(/Accept-Language/i);
      expect(res.headers.get("clear-site-data")).toContain("storage");
      expect(html).toContain(`<html lang="${LOCALE_INFO[l].tag}">`);
      expect(html).toContain('<meta charset="utf-8">');
      expect(html).toContain(share.GOODBYE_TEXTS[l].title);
      expect(html).not.toMatch(/<script/i);
    }
    for (const l of LOCALES) for (const k of ["title", "gone", "history"] as const) expect(share.GOODBYE_TEXTS[l][k], `${l}.${k}`).toBeTruthy();
    expect(share.goodbyeHtml("cs")).toContain("Relace byla smazána");
  });

  it("JSON goes as UTF-8", async () => {
    const res = await fetch(`${base}/json`);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect((await res.json()).text).toBe("Příliš žluťoučký kůň");
  });
});

describe("confirming an e-mail address in the user's language", () => {
  let server: Server;
  let base = "";
  let token = "";
  const mails: Array<import("../server/notify/smtp").SmtpMessage> = [];

  beforeAll(async () => {
    const express = (await import("express")).default;
    const { registerNotifyRoutes } = await import("../server/notify/routes");
    const { createNotifierService } = await import("../server/notify/service");
    const { accountStore } = await import("../server/accounts/store");
    const svc = createNotifierService(accountStore);
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { if (req.path.startsWith("/api/admin")) { res.locals.adminName = "tester"; res.locals.adminRole = "owner"; } next(); });
    registerNotifyRoutes(app, { accounts: accountStore, ...svc, sendMail: async (_cfg, msg) => { mails.push(msg); return { ok: true, code: 250 }; } });
    server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const r = accountStore.create({ credentialId: "cred-i18n-0000000000", publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, alg: -7, signCount: 1 }, "Ľubica");
    if (!r.ok) throw new Error(r.reason);
    token = accountStore.issueToken(r.account.id);
    await fetch(`${base}/api/admin/notify`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ channels: [{ id: "email", on: true }], email: { host: "smtp.example.org", port: 587, from: "Upozornění M5cet <bot@example.org>" } }) });
  });
  afterAll(() => server?.close());

  it("an account that never chose: the mail and the page in the language its requests ask for", async () => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", "accept-language": "sk-SK,sk;q=0.9,en;q=0.5" };
    const prefs = await (await fetch(`${base}/api/account/notify`, { headers })).json() as { prefs: { lang: string }; saved: boolean };
    expect(prefs).toMatchObject({ saved: false, prefs: { lang: "sk" } });
    const r = await fetch(`${base}/api/account/notify/email`, { method: "POST", headers, body: JSON.stringify({ address: "lubica@example.org" }) });
    expect(r.status).toBe(200);
    const mail = mails.at(-1)!;
    expect(mail.subject).toBe("M5cet: potvrdenie upozornení e-mailom");
    expect(mail.text).toContain("Otvorte tento odkaz");
    // the raw message carries it as UTF-8 words, and the sender's name too
    const raw = smtp.buildMessage(mail);
    const subject = /\r\nSubject: ((?:.|\r\n )+?)\r\n(?! )/.exec(raw)![1];
    expect(decode2047(subject)).toBe("M5cet: potvrdenie upozornení e-mailom");
    expect(decode2047(/^From: (.*)$/m.exec(raw.replace(/\r\n /g, " "))![1].trim())).toBe("Upozornění M5cet <bot@example.org>");
    // the page the link opens: the account has no language of its own, so the visitor's
    const t = /confirm\?t=(\S+)/.exec(mail.text)![1];
    const page = await fetch(`${base}/api/notify/email/confirm?t=${t}`, { headers: { "accept-language": "fi-FI" } });
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await page.text();
    expect(html).toContain('<html lang="fi-FI">');
    expect(html).toContain("Sähköposti vahvistettu");
    const again = await fetch(`${base}/api/notify/email/confirm?t=${t}`, { headers: { "accept-language": "fr" } });
    expect(again.status).toBe(400);
    expect(await again.text()).toContain("Ce lien ne fonctionne pas");
  });

  it("the user's own choice wins over the request's language", async () => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", "accept-language": "es" };
    await fetch(`${base}/api/account/notify`, { method: "PUT", headers, body: JSON.stringify({ lang: "sl" }) });
    await fetch(`${base}/api/account/notify/email`, { method: "POST", headers, body: JSON.stringify({ address: "lubica@example.org" }) });
    expect(mails.at(-1)!.subject).toBe("M5cet: potrditev obvestil po e-pošti");
  });
});

/* ------------------------------------------------------------ the phone */

describe("the phone speaks the nine languages", () => {
  it("every spoken text has all nine, and the provider tag of each", () => {
    for (const key of Object.keys(speech.SPEECH) as Array<keyof typeof speech.SPEECH>) {
      for (const l of LOCALES) expect((speech.SPEECH[key] as Record<string, string>)[l], `${key}.${l}`).toBeTruthy();
      expect(new Set(LOCALES.map((l) => speech.speech(key, l))).size, key).toBeGreaterThanOrEqual(8);
    }
    expect(speech.speech("prompt", "sk-SK")).toMatch(/päťmiestny/);
    expect(speech.speech("apology", "pl-PL")).toMatch(/Przepraszamy/);
    expect(speech.speech("bye", "xx")).toBe(speech.SPEECH.bye.en);
    const tags = { cs: "cs-CZ", en: "en-US", de: "de-DE", es: "es-ES", it: "it-IT", fr: "fr-FR", sk: "sk-SK", sl: "sl-SI", fi: "fi-FI" };
    for (const [code, tag] of Object.entries(tags)) { expect(speech.phoneLanguage(code)).toBe(tag); expect(speech.phoneLanguage(tag)).toBe(tag); }
    expect(speech.phoneLanguage("en-GB")).toBe("en-US"); // as before 6.13
    expect(speech.phoneLanguage("ja-JP")).toBe("ja-JP");
  });

  it("a TSA's Start offers the new languages; the offline voices include Slovenian and Finnish", () => {
    {
      const start = (TSA_CATALOG as Array<{ type: string; params?: Array<{ key: string; options?: Array<{ value: string }> }> }>).find((t) => t.type === "start");
      const options = start?.params?.find((p) => p.key === "language")?.options?.map((o) => o.value) ?? [];
      for (const tag of ["cs-CZ", "sk-SK", "de-DE", "es-ES", "it-IT", "fr-FR", "sl-SI", "fi-FI"]) expect(options).toContain(tag);
    }
    const piper = LOCAL_MODELS.filter((m) => m.engine === "piper");
    for (const l of LOCALES) expect(piper.some((m) => m.langs.includes(l)), l).toBe(true);
    for (const m of piper) expect(m.url).toMatch(/^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\/tts-models\/vits-piper-[a-z]{2}_[A-Z]{2}-[a-z_]+-(medium|low|high)-int8\.tar\.bz2$/);
  });
});
