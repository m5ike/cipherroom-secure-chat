// 6.10 (security review G-12, G-13, G-14): the side paths of sending in the
// web client keep the recipient selection and the message options, and the
// text that goes to the server's speech provider is disclosed and asked.
//
//   client/src/lib/send-plan.ts   attachmentKinds, forwardPlan, largeFileTargets, liveLocationTargets
//   client/src/lib/speak-send.ts  textToVoiceFile's confirm, serverVoiceConsent
//   client/src/App.tsx            where they are used (checked in its source: the
//                                 component itself is not mounted by unit tests)

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { attachmentKinds, forwardPlan, largeFileTargets, liveLocationTargets, type SendKinds } from "../client/src/lib/send-plan";
import { resetServerVoiceConsent, serverVoiceConsent, textToVoiceFile } from "../client/src/lib/speak-send";
import { largeFileRoute } from "../client/src/lib/file-transfer";
import type { ServerSpeechStatus } from "../client/src/lib/speech";
import { t, type Lang } from "../client/src/lib/i18n";

const APP = readFileSync(join(__dirname, "..", "client", "src", "App.tsx"), "utf8");
const NONE: SendKinds = { tap: false, vanishSeconds: 0, sealed: false, sealCode: "", asVoice: false };
/** The body of a function in App.tsx (from its declaration to the next one at the same indentation). */
const fnBody = (name: string) => {
  const start = APP.search(new RegExp(`\\n  (async )?function ${name}\\(`));
  expect(start, name).toBeGreaterThan(0);
  const next = APP.slice(start + 1).search(/\n  (async )?function \w+\(/);
  return APP.slice(start, next > 0 ? start + 1 + next : undefined);
};

describe("G-12 — the recipient selection holds on every path", () => {
  it("a large file from the Files panel: the whole room, or only the chosen people connected now; nobody / all away is refused", () => {
    expect(largeFileTargets(null)).toEqual({ ok: false, error: "none" });
    expect(largeFileTargets({})).toEqual({ ok: true });
    expect(largeFileTargets({ targets: new Set() })).toEqual({ ok: false, error: "chosen-away" });
    expect(largeFileTargets({ targets: new Set(["p-eva"]) })).toEqual({ ok: true, targets: new Set(["p-eva"]) });
    // …and with targets, the transfer never takes the server's relay (it reaches the whole room).
    const peers: Array<[string, { channel: { readyState: string } | null }]> = [["p-eva", { channel: null }], ["p-jan", { channel: { readyState: "open" } }]];
    expect(largeFileRoute(peers, new Set(["p-eva"]))).toEqual({ channels: [], relay: false, refused: true });
    expect(largeFileRoute(peers, new Set(["p-jan"]))).toMatchObject({ relay: false, refused: false });
    // App.tsx: the Files panel's input goes through it (6.9 sent to everyone: sendLargeFileToAll(file)).
    const body = fnBody("handleLargeFileChange");
    expect(body).toMatch(/largeFileTargets\(resolveRecipients\(\)\)/);
    expect(body).toMatch(/sendLargeFileToAll\(file, to\.targets\)/);
  });

  it("a live location: fixed to the selection when it starts, never wider; only the chosen who are connected get an update", () => {
    const open = new Set(["p-eva"]);
    const isOpen = (id: string) => open.has(id);
    expect(liveLocationTargets({}, isOpen)).toEqual({ send: true });
    expect(liveLocationTargets({ targets: new Set(["p-eva", "p-jan"]) }, isOpen)).toEqual({ send: true, targets: new Set(["p-eva"]) });
    open.clear();
    expect(liveLocationTargets({ targets: new Set(["p-eva"]) }, isOpen)).toEqual({ send: false });
    const live = fnBody("startContinuousLocation");
    expect(live).toMatch(/const rec = resolveRecipients\(\)/);
    expect(live).toMatch(/liveLocationTargets\(rec,/);
    expect(live).toMatch(/sendChatPayload\(`📍 live[^`]*`, \{ targets: to\.targets, toNames: rec\.toNames \}\)/);
    expect(live).toMatch(/app\.location\.chosenAway/);
  });

  it("a one-off location and the Speech panel's text go like a message: targets, names, the away members the server keeps it for", () => {
    expect(fnBody("shareCurrentLocation")).toMatch(/sendChatPayload\(`📍[^`]*`, \{ targets: rec\.targets, toNames: rec\.toNames, away: rec\.away \}\)/);
    expect(APP).not.toMatch(/onSendText=\{\(text\) => void sendChatPayload\(text\)\}/);
    expect(APP).toMatch(/onSendText=\{\(text\) => \{[\s\S]{0,300}resolveRecipients\(\)[\s\S]{0,300}sendChatPayload\(text, \{ targets: rec\.targets, toNames: rec\.toNames, away: rec\.away \}\)/);
  });
});

describe("G-13 — the message options are never dropped in silence", () => {
  it("an inline attachment keeps tap-to-reveal and disappearing; the seal cannot apply and is named", () => {
    expect(attachmentKinds(NONE, false)).toEqual({ send: NONE, dropped: [] });
    const all = { ...NONE, tap: true, vanishSeconds: 60, sealed: true, sealCode: "abcd-efgh-ijkl" };
    expect(attachmentKinds(all, false)).toEqual({ send: { ...all, sealed: false, sealCode: "" }, dropped: ["sealed"] });
    // A large file (the chunked transfer) carries none of them.
    expect(attachmentKinds(all, true)).toEqual({ send: { ...NONE }, dropped: ["sealed", "tap", "vanish"] });
    expect(attachmentKinds({ ...NONE, vanishSeconds: 15 }, true).dropped).toEqual(["vanish"]);
    // App.tsx asks before sending when anything would not apply.
    const body = fnBody("sendPickedFile");
    expect(body).toMatch(/attachmentKinds\(sendOpts, file\.size > INLINE_ATTACHMENT_LIMIT\)/);
    expect(body).toMatch(/kinds\.dropped\.length && !window\.confirm\(tf\(lang, "app\.send\.kindsDropped"/);
    expect(body).not.toMatch(/\{ \.\.\.sendOpts, sealed: false, sealCode: "" \}/);
  });

  it("Forward sends the message as it was: tap and vanish stay; an own sealed message is sealed again; one without its code is refused", () => {
    expect(forwardPlan({ mine: false, text: "hi" })).toEqual({ ok: true, text: "hi", send: NONE });
    expect(forwardPlan({ mine: false, text: "boo", flags: { tap: true, vanishSeconds: 30 } })).toEqual({ ok: true, text: "boo", send: { ...NONE, tap: true, vanishSeconds: 30 } });
    const sealed = { salt: "s", iv: "i" };
    expect(forwardPlan({ mine: true, text: "ciphertext", sealPlain: "secret", sealCode: "ABCD-EFGH-IJKL", flags: { sealed } })).toEqual({ ok: true, text: "secret", send: { ...NONE, sealed: true, sealCode: "ABCD-EFGH-IJKL" } });
    // Someone else's (the code is theirs), or an own one after a reload (the code is gone): not forwardable — 6.9 sent ciphertext or plaintext.
    expect(forwardPlan({ mine: false, text: "ciphertext", flags: { sealed } })).toEqual({ ok: false, reason: "sealed" });
    expect(forwardPlan({ mine: true, text: "ciphertext", flags: { sealed } })).toEqual({ ok: false, reason: "sealed" });
    const body = fnBody("forwardMessage");
    expect(body).toMatch(/const plan = forwardPlan\(m\)/);
    expect(body).toMatch(/send: plan\.send/);
    expect(body).not.toMatch(/DEFAULT_SEND_STATE/);
    // The bubble offers no Forward for one that cannot go.
    expect(APP).toMatch(/onForward=\{isSystem \|\| !layout\.flags\.showActions \|\| !forwardPlan\(message\)\.ok \? undefined/);
  });
});

describe("G-14 — the text that goes to the server's speech provider is said and asked", () => {
  const ON: ServerSpeechStatus = { tts: { enabled: true, connectors: [{ id: "openai/tts-1", label: "OpenAI TTS (cloud)" }] }, stt: { enabled: true, connectors: [] } };
  const tts = vi.fn(async () => ({ ok: true as const, blob: new Blob([new Uint8Array([1, 2])], { type: "audio/mpeg" }), mime: "audio/mpeg" }));
  beforeEach(() => { tts.mockClear(); resetServerVoiceConsent(); });

  it("names the provider before the text leaves; no → nothing is sent", async () => {
    const asked: string[] = [];
    expect(await textToVoiceFile("Ahoj", { status: async () => ON, tts, confirm: (p) => { asked.push(p); return false; } })).toEqual({ ok: false, error: "declined" });
    expect(asked).toEqual(["OpenAI TTS (cloud)"]);
    expect(tts).not.toHaveBeenCalled();
    expect((await textToVoiceFile("Ahoj", { status: async () => ON, tts, confirm: async () => true })).ok).toBe(true);
    expect(tts).toHaveBeenCalledTimes(1);
  });

  it("asks once per room (in this page's life)", () => {
    const ask = vi.fn(() => true);
    expect(serverVoiceConsent("r3.brno", ask)).toBe(true);
    expect(serverVoiceConsent("r3.brno", ask)).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    const no = vi.fn(() => false);
    expect(serverVoiceConsent("r3.praha", no)).toBe(false);
    expect(serverVoiceConsent("r3.praha", no)).toBe(false);
    expect(no).toHaveBeenCalledTimes(2);
    // App.tsx asks through it, and a "no" sends nothing and says nothing more.
    const body = fnBody("sendTextAsVoice");
    expect(body).toMatch(/confirm: \(provider\) => serverVoiceConsent\(roomRef\.current \?\? "", \(\) => window\.confirm\(tf\(lang, "speakSend\.confirm", \{ provider \}\)\)\)/);
    expect(body).toMatch(/if \(!made\.ok && made\.error === "declined"\) return false;/);
  });

  it("the composer's chip says the server reads the text; a sealed reply to a function is refused (the server reads it)", () => {
    for (const lang of ["cs", "en", "de"] as Lang[]) {
      for (const key of ["speakSend.confirm", "speakSend.err.declined", "app.fnReply.sealed", "app.forward.sealed", "app.send.kindsDropped", "app.location.startedTo", "app.location.chosenAway"]) expect(t(lang, key), `${lang} ${key}`).not.toBe(key);
      expect(t(lang, "speakSend.confirm")).toContain("{provider}");
    }
    expect(t("en", "speakSend.on")).toBe("As voice — the server reads the text");
    expect(t("cs", "speakSend.on")).toBe("Jako hlas — text čte server");
    expect(fnBody("sendMessage")).toMatch(/if \(sendOpts\.sealed\) \{ setNotice\(t\(lang, "app\.fnReply\.sealed"\)\); return; \}\s*const quote/);
  });
});
