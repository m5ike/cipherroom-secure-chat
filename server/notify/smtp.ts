// A small SMTP client for the e-mail channel (6.7): one message to one
// recipient through the operator's relay — implicit TLS (465), STARTTLS
// (587) or plain (a relay on localhost), AUTH PLAIN or LOGIN, a
// multipart/alternative body (text + HTML), UTF-8 everywhere. No
// dependency: the server's other outbound protocols are hand-written too.
//
// Header values lose CR and LF before they are written (no header
// injection from a display name), the body is base64, and a 5xx answer is
// reported as permanent so the notifier does not try that address again.

import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";

export type SmtpSettings = { host: string; port: number; secure: "tls" | "starttls" | "none"; user: string; pass: string };
export type SmtpMessage = { from: string; to: string; subject: string; text: string; html?: string };
export type SmtpResult = { ok: true; code: number } | { ok: false; code?: number; error: string; permanent: boolean };

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

/** An encoded word's payload at most: 39 bytes → 52 base64 characters — a 64-character word, within RFC 2047's 75 and, after "Subject: ", RFC 5322's 78 a line. */
const WORD_BYTES = 39;

/**
 * RFC 2047: encoded words when the text is not plain ASCII (6.13: "Příliš
 * žluťoučký kůň", "Ärger ñ ç œ"). A long text becomes several words of at most
 * 75 characters, never splitting a character's UTF-8 bytes, folded onto
 * continuation lines ("\r\n "); a decoder drops the whitespace between them.
 */
export function encodeHeader(value: string): string {
  const v = oneLine(value);
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  const words: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const ch of v) {
    const n = Buffer.byteLength(ch, "utf8");
    if (bytes + n > WORD_BYTES && chunk) { words.push(chunk); chunk = ""; bytes = 0; }
    chunk += ch;
    bytes += n;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join("\r\n ");
}

/** RFC 2047's decoder (B and Q), for tests and the console: encoded words → text. */
export function decodeHeader(value: string): string {
  return value
    .replace(/\r\n[ \t]+/g, " ")
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, "$1")
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_whole, charset: string, enc: string, text: string) => {
      const bytes = enc.toUpperCase() === "B"
        ? Buffer.from(text, "base64")
        : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1");
      return new TextDecoder(charset.toLowerCase() === "utf-8" ? "utf-8" : charset).decode(bytes);
    });
}

/** "Name <a@b>" or "a@b" → the bare address. */
export function addressOf(v: string): string {
  const m = /<([^<>]+)>\s*$/.exec(v);
  return oneLine(m ? m[1] : v);
}

/** A display name: encoded words when not ASCII, a quoted string when it has RFC 5322 specials. */
function displayName(name: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/^[\x20-\x7e]*$/.test(name)) return encodeHeader(name);
  return /[()<>@,;:\\".[\]]/.test(name) ? `"${name.replace(/(["\\])/g, "\\$1")}"` : name;
}

function mailbox(v: string): string {
  const m = /^(.*)<([^<>]+)>\s*$/.exec(oneLine(v));
  if (!m) return oneLine(v);
  const name = m[1].trim().replace(/^"|"$/g, "");
  return name ? `${displayName(name)} <${m[2].trim()}>` : `<${m[2].trim()}>`;
}

const b64lines = (s: string) => (Buffer.from(s, "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");

/** The whole message as it goes after DATA (dot-stuffed, CRLF). */
export function buildMessage(msg: SmtpMessage, now = new Date(), domain = "m5cet.local"): string {
  const boundary = `m5-${randomBytes(9).toString("hex")}`;
  const headers = [
    `From: ${mailbox(msg.from)}`,
    `To: ${mailbox(msg.to)}`,
    `Subject: ${encodeHeader(msg.subject)}`,
    `Date: ${now.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${randomBytes(12).toString("hex")}@${domain}>`,
    "MIME-Version: 1.0",
    "Auto-Submitted: auto-generated",
  ];
  const parts = [
    `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64lines(msg.text)}`,
    ...(msg.html ? [`--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64lines(msg.html)}`] : []),
    `--${boundary}--`,
  ];
  const body = `${headers.join("\r\n")}\r\nContent-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n${parts.join("\r\n")}\r\n`;
  return body.replace(/\r\n\./g, "\r\n..");
}

/** Reads SMTP replies (multi-line "250-…" until "250 …"). */
class Replies {
  private buf = "";
  private waiting: Array<(r: { code: number; text: string }) => void> = [];
  private lines: string[] = [];
  private error: Error | null = null;
  private failers: Array<(e: Error) => void> = [];

  feed(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      this.lines.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        const code = Number(line.slice(0, 3));
        const text = this.lines.map((l) => l.slice(4)).join("\n");
        this.lines = [];
        const w = this.waiting.shift();
        this.failers.shift();
        if (w) w({ code, text });
      }
    }
  }

  fail(err: Error): void {
    this.error = err;
    for (const f of this.failers.splice(0)) f(err);
    this.waiting = [];
  }

  next(): Promise<{ code: number; text: string }> {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => { this.waiting.push(resolve); this.failers.push(reject); });
  }
}

export async function sendSmtp(cfg: SmtpSettings, msg: SmtpMessage, timeoutMs = 15_000): Promise<SmtpResult> {
  let socket: Socket | TLSSocket;
  const replies = new Replies();
  const attach = (s: Socket | TLSSocket) => {
    s.setEncoding("utf8");
    s.on("data", (d: string) => replies.feed(d));
    s.on("error", (e) => replies.fail(e));
    s.on("close", () => replies.fail(new Error("the SMTP server closed the connection")));
  };
  const timer = setTimeout(() => { replies.fail(new Error("SMTP timed out")); try { socket?.destroy(); } catch { /* gone */ } }, timeoutMs);
  timer.unref?.();
  const write = (line: string) => socket.write(`${line}\r\n`);
  const expect = async (ok: number[], what: string) => {
    const r = await replies.next();
    if (!ok.includes(r.code)) throw Object.assign(new Error(`${what}: ${r.code} ${oneLine(r.text).slice(0, 200)}`), { code: r.code });
    return r;
  };
  try {
    socket = cfg.secure === "tls" ? tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host }) : netConnect({ host: cfg.host, port: cfg.port });
    attach(socket);
    await expect([220], "greeting");
    const me = hostname().replace(/[^A-Za-z0-9.-]/g, "") || "m5cet";
    write(`EHLO ${me}`);
    let ehlo = await expect([250], "EHLO");
    if (cfg.secure === "starttls") {
      write("STARTTLS");
      await expect([220], "STARTTLS");
      const plain = socket;
      plain.removeAllListeners("data");
      plain.removeAllListeners("close");
      socket = tlsConnect({ socket: plain, servername: cfg.host });
      attach(socket);
      await new Promise<void>((resolve, reject) => { (socket as TLSSocket).once("secureConnect", () => resolve()); socket.once("error", reject); });
      write(`EHLO ${me}`);
      ehlo = await expect([250], "EHLO");
    }
    if (cfg.user) {
      const caps = ehlo.text.toUpperCase();
      if (/AUTH[ =][^\n]*PLAIN/.test(caps) || !/AUTH[ =][^\n]*LOGIN/.test(caps)) {
        write(`AUTH PLAIN ${Buffer.from(`\0${cfg.user}\0${cfg.pass}`, "utf8").toString("base64")}`);
        await expect([235], "AUTH");
      } else {
        write("AUTH LOGIN");
        await expect([334], "AUTH");
        write(Buffer.from(cfg.user, "utf8").toString("base64"));
        await expect([334], "AUTH");
        write(Buffer.from(cfg.pass, "utf8").toString("base64"));
        await expect([235], "AUTH");
      }
    }
    write(`MAIL FROM:<${addressOf(msg.from)}>`);
    await expect([250], "MAIL FROM");
    write(`RCPT TO:<${addressOf(msg.to)}>`);
    await expect([250, 251], "RCPT TO");
    write("DATA");
    await expect([354], "DATA");
    socket.write(buildMessage(msg, new Date(), addressOf(msg.from).split("@")[1] || "m5cet.local"));
    write(".");
    const done = await expect([250], "message");
    write("QUIT");
    socket.end();
    return { ok: true, code: done.code };
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    const n = typeof code === "number" ? code : undefined;
    try { socket!?.destroy(); } catch { /* gone */ }
    return { ok: false, ...(n ? { code: n } : {}), error: (err as Error).message, permanent: n !== undefined && n >= 500 && n < 600 };
  } finally {
    clearTimeout(timer);
  }
}
