// @vitest-environment node
// 6.12 — the Android app's security fixes that do not depend on protocol 4
// (docs/security-analysis.md: F-16, F-22, G-14, G-20, G-22). The rules are
// JVM-tested (LockStoreTest, PinWrapTest, DuressTest, NamesTest,
// ServerVoiceConsentTest, DesignShareTest, LockScreenTest); here: the
// design's texts and rows (server/android/design-612-security.ts) in Czech,
// English and German, and that the app is wired the way the fixes need.

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { DEFAULT_SCREENS, DEFAULT_STRINGS, type ANode } from "../server/android/design";
import { STRINGS_612 } from "../server/android/design-612";
import { AREA } from "../server/android/design-612-security";

const app = (p: string) => readFileSync(new URL(`../android/app/src/main/${p}`, import.meta.url), "utf8");
const java = (p: string) => app(`java/cz/m5cet/app/${p}`);
const LANGS = ["cs", "en", "de"] as const;

const walk = (n: ANode, f: (n: ANode) => void): void => { f(n); (n.children ?? []).forEach((c) => walk(c, f)); };
const all = (root: ANode): ANode[] => { const out: ANode[] = []; walk(root, (x) => out.push(x)); return out; };

describe("android 6.12 security — the texts", () => {
  it("every text exists in Czech, English and German, also in the default design, and differs between them", () => {
    const keys = Object.keys(AREA.strings?.en ?? {});
    expect(keys.length).toBeGreaterThan(25);
    for (const k of keys) {
      for (const l of LANGS) {
        expect(AREA.strings?.[l]?.[k], `${l} ${k}`).toBeTruthy();
        expect(STRINGS_612[l][k], `${l} ${k}`).toBe(AREA.strings?.[l]?.[k]);
        expect(DEFAULT_STRINGS[l][k], `${l} ${k}`).toBe(AREA.strings?.[l]?.[k]);
      }
    }
    for (const k of ["set.security.duress.about", "voice.consent.speak", "notify.lockScreenHide.hint", "security.shareTooLong"]) {
      expect(new Set(LANGS.map((l) => DEFAULT_STRINGS[l][k])).size, k).toBe(3);
    }
    for (const l of LANGS) {
      expect(DEFAULT_STRINGS[l]["voice.consent.speak"], l).toContain("{provider}");
      expect(DEFAULT_STRINGS[l]["voice.consent.transcribe"], l).toContain("{provider}");
      expect(DEFAULT_STRINGS[l]["set.security.duress.length"], l).toContain("{n}");
    }
    expect(DEFAULT_STRINGS.cs["set.security.duress"]).toBe("Nouzový PIN");
  });

  it("every key the Java asks for exists", () => {
    const sources = [
      "ui/DesignShare.java", "ui/MainActivity.java", "ui/parts/Parts.java", "ui/parts/ComposerVoice.java", "ui/parts/Composer.java",
      "ui/parts/MessageList.java", "ui/parts/MsgDetails.java", "chat/RoomSession.java",
    ].map(java).join("\n");
    const used = new Set<string>();
    for (const m of sources.matchAll(/"((?:set\.security\.(?:duress|pinKey|lockHint)|voice\.consent|security\.(?:copy|share)|speakSend\.declined|send\.opt\.asVoiceServer|notice\.operator)[A-Za-z.]*)"/g)) used.add(m[1]);
    expect(used.size).toBeGreaterThan(12);
    for (const k of used) if (!k.endsWith(".")) for (const l of LANGS) expect(DEFAULT_STRINGS[l][k], `${l} ${k}`).toBeTruthy();
    // The PIN key's levels the security screen names ("set.security.pinKey." + level).
    for (const level of ["strongbox", "tee", "legacy", "software"]) for (const l of LANGS) expect(DEFAULT_STRINGS[l][`set.security.pinKey.${level}`], `${l} ${level}`).toBeTruthy();
  });
});

describe("android 6.12 security — the design's rows", () => {
  it("Settings › Security: the duress PIN's switch, the lock's hint, the PIN key", () => {
    const nodes = all(DEFAULT_SCREENS["settings.security"]);
    const ids = nodes.map((x) => x.id);
    expect(nodes.filter((x) => x.el === "switch").map((x) => x.props?.setting)).toContain("security.duress");
    expect(nodes.filter((x) => x.el === "switch").map((x) => x.props?.setting)).toContain("security.lockDisconnect");
    expect(ids.indexOf("duress")).toBe(ids.indexOf("shuffle-hint") + 1);
    expect(ids.indexOf("lock-hint")).toBe(ids.indexOf("lock") + 3); // the lock row's icon and label, then the hint
    expect(ids.indexOf("lockdisconnect")).toBe(ids.indexOf("lock-hint") + 1);
    // The strict mode says honestly what it costs.
    expect(DEFAULT_STRINGS.en["set.security.lockDisconnectHint"]).toMatch(/without an account you miss the messages/);
    expect(DEFAULT_STRINGS.cs["set.security.lockDisconnectHint"]).toMatch(/bez účtu zprávy poslané během zámku zmeškáte/);
    expect(nodes.find((x) => x.id === "pinkey-value")?.text).toBe("{$security.pinKeyLabel}");
    // patched once, even if the patch ran again
    AREA.patch!(DEFAULT_SCREENS);
    expect(all(DEFAULT_SCREENS["settings.security"]).filter((x) => x.id === "duress").length).toBe(1);
  });

  it("Settings › Notifications: hide on the lock screen, before the quiet hours (Privacy and the conversations keep their places)", () => {
    const nodes = all(DEFAULT_SCREENS["settings.notify"]);
    const ids = nodes.map((x) => x.id);
    expect(nodes.filter((x) => x.el === "switch").map((x) => x.props?.setting)).toContain("notify.lockScreenHide");
    expect(ids.indexOf("lockscreen-hint") + 1).toBe(ids.indexOf("s-quiet"));
    expect(ids.indexOf("s-conversations")).toBe(ids.indexOf("privacy-hint") + 1);
    AREA.patch!(DEFAULT_SCREENS);
    expect(all(DEFAULT_SCREENS["settings.notify"]).filter((x) => x.id === "lockscreen").length).toBe(1);
  });

  it("the shipped default design carries them", () => {
    const shipped = JSON.parse(app("assets/m5/default-design.json"));
    expect(JSON.stringify(shipped.screens["settings.security"])).toContain("security.duress");
    expect(JSON.stringify(shipped.screens["settings.notify"])).toContain("notify.lockScreenHide");
    expect(shipped.strings.de["notice.operator"]).toBe("Betreiber");
  });
});

describe("android 6.12 security — the wiring", () => {
  it("F-16: a lock forgets the data key (also the auto-lock in the background), unlocking derives it again", () => {
    const lock = java("security/AppLock.java");
    expect(lock).toMatch(/public void lockNow\(boolean remote\) \{\s*uiLocked = true;\s*forgetOrWait\(remote\);\s*app\.onLocked\(\);/);
    expect(lock).toContain("app.forgetSecrets();");
    expect(lock).toContain("public void autolocked()");
    const m5 = java("M5.java");
    expect(m5).toMatch(/public void onLocked\(\) \{ whenLocked\(\); emit\("locked"\); \}/);
    expect(m5).toContain("lock.autolocked()");
    const forget = m5.slice(m5.indexOf("public void forgetSecrets()"));
    // The default keeps receiving into the lock inbox; the strict setting disconnects. Both before the key goes.
    expect(forget).toMatch(/if \(settings\.bool\(LOCK_DISCONNECT\)\) rooms\.disconnectAll\(\);\s*else rooms\.lockReceiving\(\);/);
    expect(m5).toContain('LOCK_DISCONNECT = "security.lockDisconnect"');
    expect(forget.indexOf("rooms.lockReceiving()")).toBeLessThan(forget.indexOf("vault.lock()")); // the inbox key sealed, histories saved with the key
    for (const s of ["account.reload()", "Store.forget()", "Profiles.of(this).forget()", "ServerVoiceConsent.reset()"]) expect(forget).toContain(s);
    expect(m5).toContain("cz.m5cet.app.chat.LockedRooms.unlocked(this, rooms);");
    const rooms = java("chat/Rooms.java");
    expect(rooms).toContain("boolean inbox = LockedRooms.begin(app);");
    expect(rooms).toContain("if (!\"sys\".equals(m.kind) && LockedRooms.active()) LockedRooms.message(r.key, m);");
    expect(java("chat/Files.java")).toContain("LockedRooms.keepFile(room.app, room.key, in.id, in.key, in.tmp, in.slots");
    expect(java("chat/History.java")).toContain("static synchronized void saveSession(M5 app, RoomSession r)");
    expect(java("security/AppLock.java")).toContain("cz.m5cet.app.chat.LockedRooms.draining()");
    const vault = java("security/Vault.java");
    expect(vault).toMatch(/byte\[\] k = userKey;\s*userKey = null;\s*Crypto\.wipe\(k\);/);
    expect(java("ui/MainActivity.java")).toContain('case "locked": forgetUi();');
    expect(java("push/NotifyPrefs.java")).toContain("if (!app.vault.unlocked()) return;");
    expect(java("telecom/Conversations.java")).toContain("setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP");
  });

  it("F-16: the counter is sealed and written durably; the PIN key moves; the duress PIN wipes quietly", () => {
    const lock = java("security/AppLock.java");
    expect(lock).toContain("new LockStore(new KeystoreAnchor()");
    expect(lock).toContain("app.vault.putDurable(Vault.Tier.SYS, \"lock\"");
    expect(lock).toContain("if (v.verdict == LockStore.Verdict.ROLLBACK) return rolledBack();");
    expect(lock).toMatch(/if \(unlock && Duress\.check\(app, pin\)\) return duress\(\);/);
    expect(lock).toContain('Wiper.wipe(app, "duress", false, 0, true);');
    expect(java("security/Vault.java")).toContain("android.system.Os.fsync(fd)");
    expect(java("security/Vault.java")).toContain("PinWrap.moved(v1, key, stretched, hw, KEYSTORE_KEK)");
    expect(java("security/Keystore.java")).toContain("setIsStrongBoxBacked(strongBox)");
    expect(java("security/Keystore.java")).toContain("info.getSecurityLevel()");
    expect(java("ui/MainActivity.java")).toContain("!Wiper.pendingQuiet(this)");
    expect(java("ui/MainActivity.java")).toContain("case DURESS: app.restart(); break;");
  });

  it("F-22: names normalized and look-alikes flagged in the member list and the bubbles; notices are the operator's", () => {
    expect(java("ui/parts/People.java")).toContain("flagLookalikes(list);");
    expect(java("ui/parts/MessageList.java")).toContain("cz.m5cet.app.core.Names.shown(m.senderName, flag)");
    const notice = java("chat/RoomSession.java");
    expect(notice).toContain('app.t("notice.operator")');
    expect(notice).not.toMatch(/f\.optString\("from", "operator"\)/);
    const vectors = JSON.parse(readFileSync(new URL("../android/app/src/test/resources/cz/m5cet/app/names-vectors.json", import.meta.url), "utf8"));
    expect(vectors.names.length).toBeGreaterThanOrEqual(30);
    expect(vectors.pairs.length).toBeGreaterThan(5);
  });

  it("G-14, G-20, G-22: the speech consent, the computed copy / share, the lock screen", () => {
    expect(java("voice/Voice.java")).toContain("ServerVoiceConsent.check(room, ServerVoiceConsent.Use.SPEAK, voice.label, ask");
    expect(java("voice/Voice.java")).toContain("ServerVoiceConsent.check(room, ServerVoiceConsent.Use.TRANSCRIBE, provider, ask");
    expect(java("ui/parts/Composer.java")).toContain('app().t("send.opt.asVoiceServer")');
    expect(java("ui/Actions.java")).toContain('case "copy": case "share": DesignShare.run(a, action, s, ActionGuard.computed(raw, arg)); break;');
    const notify = java("telecom/Notify.java");
    expect(notify).toContain('LockScreen.secret("message", locked, app.settings.bool(LockScreen.SETTING))');
    expect(notify).toContain("LockScreen.secret(kind, locked, app.settings.bool(LockScreen.SETTING))");
    expect(notify).toContain("LockScreen.secret(key, true, hides)");
    expect(notify).toContain('neutralMark("notify.message", locked)');
  });
});
