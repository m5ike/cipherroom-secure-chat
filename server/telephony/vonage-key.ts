// Vonage Voice credential: turns whatever the operator put into VONAGE_JWT_KEY /
// VONAGE_PRIVATE_KEY / VONAGE_PRIVATE_KEY_PATH into a usable RS256 signing key
// — or a precise reason why not. The reason never contains key material.
//
// Why this exists: handing a mangled PEM straight to OpenSSL fails only at
// call time, with "error:1E08010C:DECODER routines::unsupported", while the
// connector status still claimed "configured". Shapes seen in real .env files,
// systemd EnvironmentFile and compose files:
//
//   - a multi-line PEM pasted WITHOUT quotes: the dotenv / systemd parsers keep
//     only the first line, so the value is just "-----BEGIN PRIVATE KEY-----"
//   - one line with "\n" escapes (the documented form), sometimes "\\n"
//     double-escaped by a shell or installer, or CRLF line ends
//   - the PEM flattened to one line with spaces (copied out of a web form)
//   - surrounding quotes left in by a parser that did not strip them
//   - the whole PEM base64-encoded (secrets managers, Kubernetes)
//   - only the base64 body, without the BEGIN/END lines
//   - a path to private.key (the file the Vonage dashboard downloads)
//   - a ready-made JWT from the dashboard's "JWT generator" (eyJ…)

import { createPrivateKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { decodeJwtUnsafe } from "./jwt";

export type VonageCredential =
  | { kind: "key"; key: KeyObject; source: string }
  | { kind: "token"; token: string; source: string; expiresAt?: number }
  | { kind: "missing" }
  | { kind: "invalid"; source: string; reason: string };

const env = (name: string): string => (process.env[name]?.trim() || "");

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/;
const PEM_HEADER = /-----BEGIN ([A-Z0-9 ]+)-----/;
const JWT_SHAPE = /^eyJ[\w-]*\.[\w-]+\.[\w-]*$/;
const B64_SHAPE = /^[A-Za-z0-9+/=_-]+$/;

const CUT_AT_FIRST_LINE =
  "holds only the PEM header line — the value was cut at the first line break. " +
  "A multi-line key in .env / systemd EnvironmentFile must be wrapped in double quotes, " +
  "or put on ONE line with \\n escapes. Simplest: VONAGE_PRIVATE_KEY_PATH=/path/to/private.key";

/** Strip wrapping quotes and turn escaped line breaks back into real ones. */
function unescapeValue(raw: string): string {
  let s = raw.trim();
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) s = s.slice(1, -1).trim();
  // "\n", "\\n", "\r\n" escapes (a genuine PEM never contains a backslash).
  return s.replace(/\\+r/g, "").replace(/\\+n/g, "\n").replace(/\\/g, "").replace(/\r/g, "");
}

class KeyError extends Error {}

/** Rebuild a canonical PEM (64-column body) from a possibly flattened one. */
function canonicalPem(label: string, body: string): string {
  const b64 = body.replace(/[^A-Za-z0-9+/=]/g, "");
  if (!b64) throw new KeyError("has BEGIN/END lines but no key data between them");
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;
}

function checkRsa(key: KeyObject): KeyObject {
  if (key.asymmetricKeyType !== "rsa") {
    throw new KeyError(`is a ${String(key.asymmetricKeyType).toUpperCase()} key; Vonage application keys are RSA`);
  }
  return key;
}

function keyFromPem(text: string): KeyObject {
  const block = PEM_BLOCK.exec(text);
  if (!block) {
    const header = PEM_HEADER.exec(text);
    if (header && !text.includes("-----END")) {
      const rest = text.slice(header.index + header[0].length).replace(/\s/g, "");
      throw new KeyError(rest ? "has a BEGIN line but no END line — the key is truncated" : CUT_AT_FIRST_LINE);
    }
    throw new KeyError("has mismatched BEGIN/END lines");
  }
  const label = block[1].trim();
  if (/PUBLIC KEY|CERTIFICATE/.test(label)) {
    throw new KeyError(`is a ${label.toLowerCase()} — Vonage needs the application's PRIVATE key (the private.key file generated with the application)`);
  }
  if (/ENCRYPTED/.test(label) || /Proc-Type:\s*4,ENCRYPTED/.test(block[2])) {
    throw new KeyError("is passphrase-protected; export it unencrypted (openssl pkcs8 -topk8 -nocrypt -in key.pem)");
  }
  if (label === "OPENSSH PRIVATE KEY") {
    throw new KeyError("is in OpenSSH format; use the PEM private.key Vonage generated (or convert: ssh-keygen -p -m PKCS8 -f key)");
  }
  try {
    return checkRsa(createPrivateKey(canonicalPem(label, block[2])));
  } catch (err) {
    if (err instanceof KeyError) throw err;
    throw new KeyError(`could not be parsed as a ${label} (${(err as Error).message.replace(/^error:[0-9A-F]+:/, "")}) — the key data is damaged`);
  }
}

function keyFromDer(der: Buffer): KeyObject {
  for (const type of ["pkcs8", "pkcs1"] as const) {
    try { return checkRsa(createPrivateKey({ key: der, format: "der", type })); } catch (err) {
      if (err instanceof KeyError) throw err;
    }
  }
  throw new KeyError("is neither a PEM private key, a base64-encoded key, a file path nor a JWT");
}

function looksLikePath(v: string): boolean {
  return !v.includes("\n") && (/^(\/|\.{1,2}\/|~\/)/.test(v) || /\.(key|pem)$/i.test(v));
}

function readKeyFile(path: string): string {
  const full = path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(path);
  try {
    return readFileSync(full, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code || "error";
    const hint = code === "ENOENT" ? " (in Docker the file must be mounted into the container)" : code === "EACCES" ? " (not readable by the service user)" : "";
    throw new KeyError(`points to ${full}, which cannot be read: ${code}${hint}`);
  }
}

type Parsed = { kind: "key"; key: KeyObject } | { kind: "token"; token: string; expiresAt?: number; appId?: string };

/** Parse one configured value (inline or file contents). Throws KeyError. */
export function parseVonageKey(raw: string, depth = 0): Parsed {
  const value = unescapeValue(raw);
  if (!value) throw new KeyError("is empty");
  if (value.includes("-----BEGIN")) return { kind: "key", key: keyFromPem(value) };
  if (JWT_SHAPE.test(value)) {
    const decoded = decodeJwtUnsafe(value);
    if (!decoded) throw new KeyError("looks like a JWT but cannot be decoded");
    const exp = typeof decoded.payload.exp === "number" ? decoded.payload.exp : undefined;
    const appId = typeof decoded.payload.application_id === "string" ? decoded.payload.application_id : undefined;
    return { kind: "token", token: value, expiresAt: exp, appId };
  }
  if (depth === 0 && looksLikePath(value)) return parseVonageKey(readKeyFile(value), 1);
  const compact = value.replace(/\s/g, "");
  if (compact.length >= 64 && B64_SHAPE.test(compact)) {
    const bytes = Buffer.from(compact.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const asText = bytes.toString("utf8");
    if (depth === 0 && asText.includes("-----BEGIN")) return parseVonageKey(asText, 1);
    return { kind: "key", key: keyFromDer(bytes) };
  }
  throw new KeyError(`is neither a PEM private key, a base64-encoded key, a file path nor a JWT (${value.length} characters)`);
}

let memo: { input: string; result: Parsed | { error: string } } | null = null;

function parseMemo(input: string): Parsed | { error: string } {
  if (memo?.input === input) return memo.result;
  let result: Parsed | { error: string };
  try { result = parseVonageKey(input); } catch (err) {
    result = { error: err instanceof KeyError ? err.message : `could not be read (${(err as Error).message})` };
  }
  memo = { input, result };
  return result;
}

/** What the connector will sign with, resolved from the environment right now. */
export function resolveVonageCredential(now = Date.now()): VonageCredential {
  const candidates: Array<[string, string]> = [
    ["VONAGE_JWT_KEY", env("VONAGE_JWT_KEY")],
    ["VONAGE_PRIVATE_KEY", env("VONAGE_PRIVATE_KEY")],
  ];
  const [source, inline] = candidates.find(([, v]) => v) ?? ["", ""];
  let input = inline;
  let from = source;
  if (!input) {
    const path = env("VONAGE_PRIVATE_KEY_PATH");
    if (!path) return { kind: "missing" };
    from = "VONAGE_PRIVATE_KEY_PATH";
    try { input = readKeyFile(path); } catch (err) {
      return { kind: "invalid", source: from, reason: `${from} ${(err as Error).message}` };
    }
  }
  const parsed = parseMemo(input);
  if ("error" in parsed) return { kind: "invalid", source: from, reason: `${from} ${parsed.error}` };
  if (parsed.kind === "key") return { kind: "key", key: parsed.key, source: from };

  const appId = env("VONAGE_APPLICATION_ID");
  if (parsed.expiresAt !== undefined && parsed.expiresAt * 1000 <= now) {
    return {
      kind: "invalid", source: from,
      reason: `${from} holds a pre-generated JWT that expired ${new Date(parsed.expiresAt * 1000).toISOString()}. ` +
        "Put the application's private key there instead — the server mints a fresh token for every call.",
    };
  }
  if (appId && parsed.appId && parsed.appId !== appId) {
    return { kind: "invalid", source: from, reason: `${from} holds a JWT issued for application ${parsed.appId}, but VONAGE_APPLICATION_ID is ${appId}.` };
  }
  return { kind: "token", token: parsed.token, source: from, expiresAt: parsed.expiresAt };
}
