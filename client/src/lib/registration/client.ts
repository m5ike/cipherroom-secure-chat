// Registration (6.4) — the web app's side of the server's registration API.
//
//   countries()   GET  /api/account/countries   (cached for the page's life)
//   check(form)   POST /api/account/register/check → normalized, or field errors
//   start(form)   POST /api/account/register/start → the username and the
//                 passkey creation options, whose challenge carries the
//                 contact hashes; account.ts › registerAccount(report, preset)
//                 then runs the very same passkey / key / database steps as
//                 "Create an account"
//
// Loaded on demand with the registration dialog.

import type { ServerCreationOptions } from "../passkey";
import type { Country, RegistrationErrors, RegistrationInput } from "./form";

export type RemoteCheck =
  | { ok: true; normalized: RegistrationInput }
  | { ok: false; status: number; errors: RegistrationErrors; message: string };

export type RemoteStart =
  | { ok: true; normalized: RegistrationInput; preset: { publicKey: ServerCreationOptions; username: string } }
  | { ok: false; status: number; errors: RegistrationErrors; message: string };

let countryCache: Promise<Country[]> | null = null;

export function countries(): Promise<Country[]> {
  countryCache ??= fetch("/api/account/countries")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((j: { countries?: Country[] }) => j.countries ?? [])
    .catch((err) => { countryCache = null; throw err; });
  return countryCache;
}

async function post(path: string, form: RegistrationInput): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
  let body: Record<string, unknown> = {};
  try { body = (await res.json()) as Record<string, unknown>; } catch { /* an HTML error page */ }
  return { status: res.status, body };
}

function refusal(status: number, body: Record<string, unknown>) {
  return {
    ok: false as const,
    status,
    errors: (body.errors && typeof body.errors === "object" ? body.errors : {}) as RegistrationErrors,
    message: typeof body.message === "string" ? body.message : `Server error ${status}.`,
  };
}

export async function check(form: RegistrationInput): Promise<RemoteCheck> {
  const { status, body } = await post("/api/account/register/check", form);
  return status === 200 && body.ok ? { ok: true, normalized: body.normalized as RegistrationInput } : refusal(status, body);
}

export async function start(form: RegistrationInput): Promise<RemoteStart> {
  const { status, body } = await post("/api/account/register/start", form);
  if (status !== 200 || !body.ok) return refusal(status, body);
  return {
    ok: true,
    normalized: body.normalized as RegistrationInput,
    preset: { publicKey: body.publicKey as ServerCreationOptions, username: String(body.username) },
  };
}
