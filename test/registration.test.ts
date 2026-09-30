// @vitest-environment node
//
// Registration with a form (6.4): the shared field checks, what only the
// server checks (line type, the e-mail domain's MX, uniqueness), the contact
// hashes on the account, and the whole check → start → verify path over HTTP
// with the synthetic authenticator. DNS is replaced; nothing here touches
// the network.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  process.env.WEBAUTHN_RP_ID = "localhost";
});

import express from "express";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEmail, checkName, checkPhone, checkRegistration, countryList, flagEmoji } from "../client/src/lib/registration/form";
import { checkRegistrationOnServer, mailDomain, setMxLookupForTests, type MailDomain } from "../server/accounts/registration";
import { AccountStore } from "../server/accounts/store";
import { registerAccountRoutes } from "../server/accounts/routes";
import { REGISTERED_USERNAME_RE, generateRegisteredUsername, isUsername } from "../server/accounts/username";
import { FakeAuthenticator } from "./helpers/authenticator";

const FORM = { firstName: " Jan  ", lastName: "Novák", country: "CZ", phone: "777 123 456", email: " Jan.Novak@Example.CZ " };
const MX: Record<string, MailDomain> = { "example.cz": "ok", "nomail.cz": "no-mx", "gone.invalid": "no-domain", "flaky.cz": "dns-unavailable", "xn--bcher-kva.de": "ok" };

let dir = "";
let store: AccountStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "m5cet-registration-"));
  store = new AccountStore(dir);
  setMxLookupForTests(async (domain) => MX[domain] ?? "no-domain");
});

afterEach(() => {
  setMxLookupForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("form fields (shared)", () => {
  it("normalizes and checks names", () => {
    expect(checkName("  Jan   Maria ")).toEqual({ value: "Jan Maria" });
    expect(checkName("O’Brien-Smith")).toEqual({ value: "O’Brien-Smith" });
    expect(checkName("").error).toBe("required");
    expect(checkName("R2D2").error).toBe("invalid");
    expect(checkName("--").error).toBe("invalid");
    expect(checkName("a".repeat(65)).error).toBe("too-long");
  });

  it("lower-cases e-mail and puts the domain in ASCII", () => {
    expect(checkEmail(" Jan.Novak@Example.CZ ")).toEqual({ value: "jan.novak@example.cz", domain: "example.cz" });
    expect(checkEmail("a@bücher.de")).toEqual({ value: "a@xn--bcher-kva.de", domain: "xn--bcher-kva.de" });
    for (const bad of ["plain", "@x.cz", "a@", "a..b@x.cz", "a@x", "a@-x.cz", "a b@x.cz", "a@x.c0m"]) expect(checkEmail(bad).error, bad).toBe("invalid");
    expect(checkEmail("").error).toBe("required");
  });

  it("puts phones in E.164, the country being the default region", () => {
    expect(checkPhone("777 123 456", "CZ")).toEqual({ value: "+420777123456" });
    expect(checkPhone("00420 777 123 456", "DE")).toEqual({ value: "+420777123456" });
    expect(checkPhone("+44 7700 900 123", "CZ").error).toBe("invalid");
    expect(checkPhone("12", "CZ").error).toBe("invalid");
    expect(checkPhone("", "CZ").error).toBe("required");
  });

  it("reports every field at once", () => {
    const r = checkRegistration({ firstName: "", lastName: "X1", country: "ZZ", phone: "1", email: "nope" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual({ firstName: "required", lastName: "invalid", country: "invalid", phone: "invalid", email: "invalid" });
    const good = checkRegistration(FORM);
    expect(good).toEqual({ ok: true, emailDomain: "example.cz", normalized: { firstName: "Jan", lastName: "Novák", country: "CZ", phone: "+420777123456", email: "jan.novak@example.cz" } });
  });

  it("lists countries with calling codes and flags", () => {
    const list = countryList();
    expect(list.length).toBeGreaterThan(200);
    expect(list.find((c) => c.code === "CZ")).toEqual({ code: "CZ", dial: "420" });
    expect(flagEmoji("CZ")).toBe("🇨🇿");
  });
});

describe("server checks", () => {
  it("accepts a valid form and returns the contact hashes", async () => {
    const r = await checkRegistrationOnServer(FORM, store);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.hashes.email).toMatch(/^[0-9a-f]{64}$/);
      expect(r.hashes).toEqual(store.contactHashes("jan.novak@example.cz", "+420777123456"));
    }
  });

  it("refuses a landline and a VoIP number for the mobile field", async () => {
    const landline = await checkRegistrationOnServer({ ...FORM, phone: "222 123 456" }, store);
    expect(landline.ok || landline.errors).toEqual({ phone: "not-mobile" });
    const voip = await checkRegistrationOnServer({ ...FORM, phone: "910 123 456" }, store);
    expect(voip.ok || voip.errors).toEqual({ phone: "not-mobile" });
    const us = await checkRegistrationOnServer({ ...FORM, country: "US", phone: "202 555 0123" }, store);
    expect(us.ok).toBe(true); // FIXED_LINE_OR_MOBILE — can't tell, accepted
  });

  it("asks DNS about the e-mail domain", async () => {
    const noMx = await checkRegistrationOnServer({ ...FORM, email: "a@nomail.cz" }, store);
    expect(noMx.ok ? null : [noMx.status, noMx.errors]).toEqual([400, { email: "no-mx" }]);
    const gone = await checkRegistrationOnServer({ ...FORM, email: "a@gone.invalid" }, store);
    expect(gone.ok ? null : gone.errors).toEqual({ email: "no-domain" });
    const flaky = await checkRegistrationOnServer({ ...FORM, email: "a@flaky.cz" }, store);
    expect(flaky.ok ? null : [flaky.status, flaky.errors]).toEqual([503, { email: "dns-unavailable" }]);
    const idn = await checkRegistrationOnServer({ ...FORM, email: "a@bücher.de" }, store);
    expect(idn.ok).toBe(true);
  });

  it("caches DNS answers but never a failure", async () => {
    let calls = 0;
    setMxLookupForTests(async (d) => { calls++; return d === "flaky.cz" ? "dns-unavailable" : "ok"; });
    await mailDomain("example.cz", 1_000);
    await mailDomain("example.cz", 2_000);
    expect(calls).toBe(1);
    await mailDomain("flaky.cz", 1_000);
    await mailDomain("flaky.cz", 2_000);
    expect(calls).toBe(3);
  });
});

describe("contact hashes on the account", () => {
  const credential = (id: string) => ({ credentialId: id, publicKeyJwk: { kty: "EC" }, alg: -7, signCount: 0 });

  it("keeps a random pepper in registration.json (0600) and reuses it", () => {
    const a = store.contactHashes("x@example.cz", "+420777123456");
    const file = join(dir, "registration.json");
    expect(JSON.parse(readFileSync(file, "utf8")).pepper).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new AccountStore(dir).contactHashes("x@example.cz", "+420777123456")).toEqual(a);
    expect(new AccountStore(mkdtempSync(join(tmpdir(), "m5cet-registration-other-"))).contactHashes("x@example.cz", "+420777123456")).not.toEqual(a);
  });

  it("refuses a second account with the same e-mail or phone, and frees them on delete", () => {
    const c1 = store.contactHashes("a@example.cz", "+420777123456");
    const made = store.create(credential("cred-one-aaaaaaaa"), { username: "abcdefghjk", contact: c1 });
    expect(made.ok).toBe(true);
    expect(store.contactTaken(c1)).toEqual({ email: true, phone: true });
    const samePhone = store.contactHashes("b@example.cz", "+420777123456");
    const refused = store.create(credential("cred-two-bbbbbbbb"), { username: "mnpqrstuvw", contact: samePhone });
    expect(refused).toMatchObject({ ok: false, reason: "contact taken", taken: { email: false, phone: true } });
    expect(new AccountStore(dir).contactTaken(c1)).toEqual({ email: true, phone: true }); // survives a reload
    expect(store.summary("abcdefghjk")?.registered).toBe(true);
    store.deleteAccount("abcdefghjk");
    expect(store.contactTaken(c1)).toEqual({ email: false, phone: false });
  });
});

describe("registered usernames", () => {
  it("are ten characters without look-alikes (~49.5 bits)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const name = generateRegisteredUsername(() => false);
      expect(name).toMatch(REGISTERED_USERNAME_RE);
      expect(isUsername(name)).toBe(true);
      seen.add(name);
    }
    expect(seen.size).toBe(200);
    expect(Math.log2(31 ** 10)).toBeGreaterThan(32);
  });

  it("skip a taken one", () => {
    let first = "";
    const name = generateRegisteredUsername((n) => { if (!first) { first = n; return true; } return false; });
    expect(name).not.toBe(first);
  });
});

describe("registration over HTTP", () => {
  let server: Server;
  let base = "";

  beforeEach(async () => {
    const app = express();
    app.use(express.json());
    registerAccountRoutes(app, store);
    server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
  });

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const KEY_PROOF = "k".repeat(43);

  async function register(form: Record<string, string>, auth = new FakeAuthenticator("localhost", "http://localhost")) {
    const start = await post("/api/account/register/start", form);
    const s = await start.json() as { ok: boolean; username: string; publicKey: { challenge: string; user: { name: string } } };
    expect(start.status).toBe(200);
    const verify = await post("/api/account/register/verify", { credential: auth.register(s.publicKey.challenge), keyProof: KEY_PROOF });
    return { start: s, verify, body: await verify.json() as { ok: boolean; token?: string; code?: string; errors?: Record<string, string>; account?: { username: string; registered: boolean } } };
  }

  it("serves the country list", async () => {
    const r = await fetch(`${base}/api/account/countries`);
    const j = await r.json() as { countries: Array<{ code: string; dial: string }> };
    expect(j.countries).toContainEqual({ code: "CZ", dial: "420" });
  });

  it("checks, starts with a new username, and registers with the contact hashes", async () => {
    const check = await post("/api/account/register/check", FORM);
    expect(await check.json()).toEqual({ ok: true, normalized: { firstName: "Jan", lastName: "Novák", country: "CZ", phone: "+420777123456", email: "jan.novak@example.cz" } });
    const { start, body } = await register(FORM);
    expect(start.username).toMatch(REGISTERED_USERNAME_RE);
    expect(start.publicKey.user.name).toBe(start.username);
    expect(body.ok).toBe(true);
    expect(body.account).toMatchObject({ username: start.username, registered: true });
    // The account keeps hashes only — the typed values are nowhere in its record.
    const raw = readFileSync(join(dir, "accounts.json"), "utf8");
    for (const value of ["Novák", "jan.novak", "777123456"]) expect(raw).not.toContain(value);
  });

  it("returns field errors, then refuses a registered e-mail or phone", async () => {
    const bad = await post("/api/account/register/check", { ...FORM, email: "a@nomail.cz", phone: "222 123 456" });
    expect(bad.status).toBe(400);
    expect((await bad.json() as { errors: unknown }).errors).toEqual({ email: "no-mx", phone: "not-mobile" });
    await register(FORM);
    const again = await post("/api/account/register/check", { ...FORM, email: "other@example.cz" });
    expect(again.status).toBe(409);
    expect((await again.json() as { errors: unknown }).errors).toEqual({ phone: "taken" });
    const start = await post("/api/account/register/start", { ...FORM, phone: "608 123 456" });
    expect(start.status).toBe(409);
    expect((await start.json() as { errors: unknown }).errors).toEqual({ email: "taken" });
  });

  it("catches a race between start and verify", async () => {
    const first = await post("/api/account/register/start", FORM);
    const second = await post("/api/account/register/start", FORM);
    const [a, b] = [await first.json(), await second.json()] as Array<{ publicKey: { challenge: string } }>;
    const auth1 = new FakeAuthenticator("localhost", "http://localhost");
    const auth2 = new FakeAuthenticator("localhost", "http://localhost");
    const ok = await post("/api/account/register/verify", { credential: auth1.register(a.publicKey.challenge), keyProof: KEY_PROOF });
    expect(ok.status).toBe(200);
    const late = await post("/api/account/register/verify", { credential: auth2.register(b.publicKey.challenge), keyProof: KEY_PROOF });
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ ok: false, code: "taken", errors: { email: "taken", phone: "taken" } });
  });

  it("keeps the sealed registration in its own vault slot, untouched by profile saves", async () => {
    const { body } = await register(FORM);
    const token = body.token!;
    const put = (vault: unknown) => fetch(`${base}/api/account/vault`, { method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(vault) });
    expect((await put({ registration: "c2VhbGVkLXJlZw==" })).status).toBe(200);
    expect((await put({ profile: "cHJvZmlsZQ==" })).status).toBe(200);
    expect((await put({ registration: "not base64!" })).status).toBe(413);
    const vault = await (await fetch(`${base}/api/account/vault`, { headers: { authorization: `Bearer ${token}` } })).json() as { registration: { ct: string }; profile: { ct: string } };
    expect(vault.registration.ct).toBe("c2VhbGVkLXJlZw==");
    expect(vault.profile.ct).toBe("cHJvZmlsZQ==");
  });

  it("keeps the anonymous 'create an account' path unchanged", async () => {
    const r = await post("/api/account/register/options", {});
    const j = await r.json() as { username: string };
    expect(j.username).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{4,6}$/);
  });
});
