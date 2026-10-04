// The test inbound SIP address (6.9, Telephony › Tests): a SIP URI the
// operator calls from any SIP phone or softphone to try the inbound routing
// and a TSA without buying a DID. It is made at a provider whose SIP side
// hands calls to this server's inbound webhook; the routing then treats a
// call to it as a call to its test DID (control/calls.ts).
//
//   Twilio  a SIP Domain <m5cet-…>.sip.twilio.com with Voice URL
//           /wh/twilio/voice (+ status callback) and a credential list —
//           Twilio refuses calls to a domain without an auth method, so the
//           address comes with a username and a password (shown once)
//   Telnyx  the Call Control application's SIP subdomain
//           (inbound.sip_subdomain = m5cet-…, receive "from_anyone"):
//           sip:test-…@m5cet-….sip.telnyx.com reaches /wh/telnyx/events;
//           no credentials — the random user part is the secret
//   Vonage  a Programmable SIP domain (POST /v1/psip) linked to the Voice
//           application (answer URL /wh/vonage/answer), digest auth with a
//           domain user, plus the IP allow list (acl) given
// Kept in the telephony data file (no password); removed at the provider on
// DELETE or when a new one replaces it.

import { randomBytes, randomInt } from "node:crypto";
import { publicBaseUrl } from "../connectors";
import { loadTelephonyFile, saveTelephonyFile } from "../store";
import type { ProviderId } from "../providers/types";
import type { TelCheck, TestSipAddress } from "./types";
import { api, apiMessage, ApiError, telnyxCreds, twilioCreds, vonageCreds, VONAGE_API } from "./provider-api";
import { writeLog } from "./log";

const env = (name: string): string => process.env[name]?.trim() || "";

export const DEFAULT_TEST_DID = "+000100";

export function readTestSip(): TestSipAddress | null {
  return loadTelephonyFile().data.testSip ?? null;
}

function writeTestSip(addr: TestSipAddress | null): { ok: true } | { ok: false; message: string } {
  const { data } = loadTelephonyFile(); // read-modify-write keeps the trunks and settings
  return saveTelephonyFile({ ...data, testSip: addr });
}

/** Which providers can make one, and how (the console shows it next to the button). */
export function sipAddressProviders(): Array<{ id: ProviderId; can: boolean; how: string }> {
  const tw = twilioCreds(); const tx = telnyxCreds(); const vg = vonageCreds();
  const base = publicBaseUrl();
  const needBase = base ? [] : ["PUBLIC_BASE_URL"];
  const say = (missing: string[], how: string) => (missing.length ? `Set ${missing.join(", ")}. ${how}` : how);
  const txMissing = [...tx.missing, ...(env("TELNYX_CONNECTION_ID") ? [] : ["TELNYX_CONNECTION_ID"]), ...needBase];
  const vgMissing = [...vg.missing, ...(env("VONAGE_APPLICATION_ID") ? [] : ["VONAGE_APPLICATION_ID"]), ...needBase];
  return [
    { id: "twilio", can: tw.missing.length === 0 && !!base, how: say([...tw.missing, ...needBase], "A Twilio SIP Domain (<name>.sip.twilio.com) whose Voice URL is this server's /wh/twilio/voice, with a credential list (digest username + password)." ) },
    { id: "telnyx", can: txMissing.length === 0, how: say(txMissing, "The Call Control application's SIP subdomain (<name>.sip.telnyx.com, open to anyone; the random address is the secret)." ) },
    { id: "vonage", can: vgMissing.length === 0, how: say(vgMissing, "A Vonage Programmable SIP domain (<name>.sip-eu|us|ap.vonage.com) linked to the Voice application, with a digest user and your IP allow list." ) },
  ];
}

const rand = (n: number) => randomBytes(n).toString("hex");

/** Twilio's credential rules: ≥ 12 characters, a digit, upper and lower case. */
export function sipPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let p = "";
  for (let i = 0; i < 20; i++) p += alphabet[randomInt(0, alphabet.length)];
  return `${p}A7z`;
}

type Step = (label: string, fn: () => Promise<string>) => Promise<boolean>;

function stepper(checks: TelCheck[]): Step {
  return async (label, fn) => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      checks.push({ id: `step-${checks.length + 1}`, label, ok: true, detail, ms: Date.now() - t0 });
      return true;
    } catch (err) {
      checks.push({ id: `step-${checks.length + 1}`, label, ok: false, detail: (err as Error).message.slice(0, 300), ms: Date.now() - t0 });
      return false;
    }
  };
}

const must = (a: Awaited<ReturnType<typeof api>>): Awaited<ReturnType<typeof api>> => {
  if (!a.ok) throw new ApiError(a.status, apiMessage(a));
  return a;
};

export type SipAddressSpec = { provider: string; did?: string; acl?: string[]; region?: string; by: string };
export type SipAddressOutcome = { ok: boolean; address: TestSipAddress | null; password?: string; checks: TelCheck[]; message?: string };

/** Creates (or rotates) the test SIP address at a provider. */
export async function createTestSipAddress(spec: SipAddressSpec): Promise<SipAddressOutcome> {
  const checks: TelCheck[] = [];
  const provider = spec.provider as ProviderId;
  const offer = sipAddressProviders().find((p) => p.id === provider);
  if (!offer) return { ok: false, address: null, checks, message: "provider: twilio, telnyx or vonage" };
  if (!offer.can) {
    checks.push({ id: "config", label: "Configuration", ok: false, detail: offer.how });
    return { ok: false, address: null, checks, message: offer.how };
  }
  const did = /^\+?[0-9]{3,15}$/.test(String(spec.did ?? "")) ? `+${String(spec.did).replace(/^\+/, "")}` : DEFAULT_TEST_DID;
  const step = stepper(checks);
  // One address at a time: the old one goes first.
  const old = readTestSip();
  if (old) await step(`Remove the previous address (${old.provider})`, async () => { const r = await removeAtProvider(old); return r; });

  const base = publicBaseUrl();
  const token = rand(6);
  const name = `m5cet-${rand(4)}`;
  const user = `test-${token}`;
  let address: TestSipAddress | null = null;
  let password: string | undefined;

  if (provider === "twilio") {
    const c = twilioCreds();
    const username = `m5test${rand(2)}`;
    password = sipPassword();
    let cl = ""; let sd = "";
    const ok = await step("Credential list", async () => {
      const r = must(await api("POST", `${c.base}/SIP/CredentialLists.json`, c.auth, { form: new URLSearchParams({ FriendlyName: `M5cet test ${name}` }) }));
      cl = String(r.json.sid ?? "");
      return cl;
    }) && await step("Credential (digest username + password)", async () => {
      must(await api("POST", `${c.base}/SIP/CredentialLists/${encodeURIComponent(cl)}/Credentials.json`, c.auth, { form: new URLSearchParams({ Username: username, Password: password! }) }));
      return username;
    }) && await step("SIP Domain → this server's voice webhook", async () => {
      const r = must(await api("POST", `${c.base}/SIP/Domains.json`, c.auth, { form: new URLSearchParams({
        DomainName: `${name}.sip.twilio.com`, FriendlyName: `M5cet test ${name}`,
        VoiceUrl: `${base}/wh/twilio/voice`, VoiceMethod: "POST",
        VoiceStatusCallbackUrl: `${base}/wh/twilio/voice_status`, VoiceStatusCallbackMethod: "POST",
      }) }));
      sd = String(r.json.sid ?? "");
      return `${String(r.json.domain_name ?? `${name}.sip.twilio.com`)} (${sd})`;
    }) && await step("Calls to the domain authenticate with the credential list", async () => {
      must(await api("POST", `${c.base}/SIP/Domains/${encodeURIComponent(sd)}/Auth/Calls/CredentialListMappings.json`, c.auth, { form: new URLSearchParams({ CredentialListSid: cl }) }));
      return "mapped";
    });
    if (!ok) {
      // Leave nothing half-made behind.
      if (sd) await api("DELETE", `${c.base}/SIP/Domains/${encodeURIComponent(sd)}.json`, c.auth).catch(() => undefined);
      if (cl) await api("DELETE", `${c.base}/SIP/CredentialLists/${encodeURIComponent(cl)}.json`, c.auth).catch(() => undefined);
      return finish(spec, checks, null);
    }
    address = { provider, uri: `sip:${user}@${name}.sip.twilio.com`, did, setup: { resource: `${sd}|${cl}`, at: Date.now(), by: spec.by }, username, enabled: true };
  } else if (provider === "telnyx") {
    const c = telnyxCreds();
    const app = env("TELNYX_CONNECTION_ID");
    let current: Record<string, unknown> = {};
    const ok = await step("Call Control application", async () => {
      const r = must(await api("GET", `${c.base}/call_control_applications/${encodeURIComponent(app)}`, c.auth));
      current = (r.json.data ?? {}) as Record<string, unknown>;
      return String(current.application_name ?? app);
    }) && await step("SIP subdomain → this application (from anyone)", async () => {
      const inbound = { ...((current.inbound ?? {}) as Record<string, unknown>), sip_subdomain: name, sip_subdomain_receive_settings: "from_anyone" };
      must(await api("PATCH", `${c.base}/call_control_applications/${encodeURIComponent(app)}`, c.auth, { json: {
        application_name: current.application_name ?? "M5cet",
        webhook_event_url: current.webhook_event_url || `${base}/wh/telnyx/events`,
        inbound,
      } }));
      return `${name}.sip.telnyx.com`;
    });
    if (!ok) return finish(spec, checks, null);
    address = { provider, uri: `sip:${user}@${name}.sip.telnyx.com`, did, setup: { resource: `ccapp:${app}:${name}`, at: Date.now(), by: spec.by }, username: "", enabled: true };
  } else {
    const c = vonageCreds();
    const region = ["eu", "us", "ap"].includes(String(spec.region)) ? String(spec.region) : "eu";
    const acl = (spec.acl ?? []).filter((x) => /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(x)).slice(0, 50);
    const username = `m5test${rand(2)}`;
    password = sipPassword();
    let made = false;
    const ok = await step("Programmable SIP domain → the Voice application", async () => {
      must(await api("POST", `${VONAGE_API}/v1/psip/`, c.auth, { json: { name, application_id: env("VONAGE_APPLICATION_ID"), acl, digest_auth: true, tls: "optional", srtp: "optional" } }));
      made = true;
      return `${name}.sip-${region}.vonage.com${acl.length ? ` (allowed: ${acl.join(", ")})` : " (no IP allow list: digest only)"}`;
    }) && await step("Domain user (digest username + password)", async () => {
      must(await api("POST", `${VONAGE_API}/v1/psip/${encodeURIComponent(name)}/users`, c.auth, { json: { key: username, secret: password } }));
      return username;
    });
    if (!ok) {
      if (made) await api("DELETE", `${VONAGE_API}/v1/psip/${encodeURIComponent(name)}?cascade=true`, c.auth).catch(() => undefined);
      return finish(spec, checks, null);
    }
    address = { provider, uri: `sip:${user}@${name}.sip-${region}.vonage.com`, did, setup: { resource: `psip:${name}`, at: Date.now(), by: spec.by }, username, enabled: true };
  }
  const saved = writeTestSip(address);
  checks.push({ id: "saved", label: "Saved (the telephony data file)", ok: saved.ok, detail: saved.ok ? `calls to ${address.uri} route as ${did}` : saved.message });
  return finish(spec, checks, saved.ok ? address : null, password);
}

function finish(spec: SipAddressSpec, checks: TelCheck[], address: TestSipAddress | null, password?: string): SipAddressOutcome {
  const ok = Boolean(address) && checks.every((c) => c.ok !== false || c.label.startsWith("Remove the previous"));
  writeLog({ kind: "test", level: ok ? "notice" : "warn", provider: spec.provider, summary: ok ? `test SIP address ${address!.uri} → ${address!.did} (by ${spec.by})` : `test SIP address at ${spec.provider} failed`, parsed: { address, checks } });
  return { ok, address, ...(ok && password ? { password } : {}), checks, ...(ok ? {} : { message: checks.find((c) => c.ok === false)?.detail ?? "failed" }) };
}

/** Removes the address's resources at its provider; returns what was done. */
async function removeAtProvider(a: TestSipAddress): Promise<string> {
  if (a.provider === "twilio") {
    const c = twilioCreds();
    if (c.missing.length) throw new Error(`Set ${c.missing.join(", ")} to remove it at Twilio`);
    const [sd, cl] = a.setup.resource.split("|");
    if (sd) { const r = await api("DELETE", `${c.base}/SIP/Domains/${encodeURIComponent(sd)}.json`, c.auth); if (!r.ok && r.status !== 404) throw new ApiError(r.status, apiMessage(r)); }
    if (cl) { const r = await api("DELETE", `${c.base}/SIP/CredentialLists/${encodeURIComponent(cl)}.json`, c.auth); if (!r.ok && r.status !== 404) throw new ApiError(r.status, apiMessage(r)); }
    return `domain ${sd} and credential list ${cl} deleted`;
  }
  if (a.provider === "telnyx") {
    const c = telnyxCreds();
    if (c.missing.length) throw new Error(`Set ${c.missing.join(", ")} to remove it at Telnyx`);
    const [, app, sub] = a.setup.resource.split(":");
    const cur = await api("GET", `${c.base}/call_control_applications/${encodeURIComponent(app)}`, c.auth);
    if (!cur.ok) { if (cur.status === 404) return "the application is gone"; throw new ApiError(cur.status, apiMessage(cur)); }
    const data = (cur.json.data ?? {}) as Record<string, unknown>;
    const inbound = (data.inbound ?? {}) as Record<string, unknown>;
    if (inbound.sip_subdomain !== sub) return "the subdomain was already changed";
    const r = await api("PATCH", `${c.base}/call_control_applications/${encodeURIComponent(app)}`, c.auth, { json: { application_name: data.application_name ?? "M5cet", webhook_event_url: data.webhook_event_url, inbound: { ...inbound, sip_subdomain: null } } });
    if (!r.ok) throw new ApiError(r.status, apiMessage(r));
    return `subdomain ${sub} removed from ${app}`;
  }
  const c = vonageCreds();
  if (c.missing.length) throw new Error(`Set ${c.missing.join(", ")} to remove it at Vonage`);
  const name = a.setup.resource.replace(/^psip:/, "");
  const r = await api("DELETE", `${VONAGE_API}/v1/psip/${encodeURIComponent(name)}?cascade=true`, c.auth);
  if (!r.ok && r.status !== 404) throw new ApiError(r.status, apiMessage(r));
  return `PSIP domain ${name} deleted`;
}

/** Removes the test SIP address (at its provider, then here — here even when the provider refuses). */
export async function deleteTestSipAddress(by: string): Promise<{ ok: boolean; checks: TelCheck[] }> {
  const checks: TelCheck[] = [];
  const a = readTestSip();
  if (!a) return { ok: true, checks: [{ id: "none", label: "No test SIP address", ok: true, detail: "nothing to remove" }] };
  const step = stepper(checks);
  const remote = await step(`Remove at ${a.provider}`, () => removeAtProvider(a));
  const saved = writeTestSip(null);
  checks.push({ id: "saved", label: "Forgotten here", ok: saved.ok, detail: saved.ok ? a.uri : saved.message });
  writeLog({ kind: "test", level: remote && saved.ok ? "notice" : "warn", provider: a.provider, summary: `test SIP address ${a.uri} removed (by ${by})${remote ? "" : " — not at the provider"}`, parsed: { checks } });
  return { ok: remote && saved.ok, checks };
}
