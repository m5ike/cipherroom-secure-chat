// @vitest-environment node
//
// M5cet Desktop (6.13): the pure parts of the native shell — the server
// address (https only, no credentials, IDN), the navigation guard, the
// permission table, m5cet:// links, the version check, the stored settings,
// the badge and the desktop texts in nine languages.

import { describe, expect, it } from "vitest";
import { parseServerUrl } from "../desktop/src/server-url";
import { decideNavigation, decideWindowOpen, describeExternal } from "../desktop/src/nav-guard";
import { decideDevicePermission, decidePermission } from "../desktop/src/permissions";
import { deepLinkFromArgv, parseDeepLink } from "../desktop/src/deep-link";
import { compareVersions } from "../desktop/src/version-compat";
import { addServer, defaultSettings, effectivePasskeyMode, MAX_SERVERS, removeServer, sanitizeSettings, setCodeSource } from "../desktop/src/settings";
import { badgeText, overlayBitmap, unreadFromTitle } from "../desktop/src/badge";
import { resolveLocale, spellcheckLanguages, STRINGS, t } from "../desktop/src/i18n";
import { LOCALES } from "../client/src/lib/locales";

const ORIGIN = "https://chat.example.org";

describe("server address", () => {
  const ok = (input: string, opts = {}) => {
    const r = parseServerUrl(input, opts);
    if (!r.ok) throw new Error(`refused ${input}: ${r.error}`);
    return r.value;
  };
  const err = (input: string, opts = {}) => {
    const r = parseServerUrl(input, opts);
    return r.ok ? "ok" : r.error;
  };

  it("adds https:// and keeps only the origin", () => {
    expect(ok("chat.example.org")).toMatchObject({ origin: ORIGIN, host: "chat.example.org", rest: "", insecure: false, idn: false });
    expect(ok("https://chat.example.org/")).toMatchObject({ origin: ORIGIN, rest: "" });
    expect(ok("  HTTPS://Chat.Example.ORG:8443  ")).toMatchObject({ origin: "https://chat.example.org:8443", host: "chat.example.org:8443" });
    expect(ok("https://chat.example.org/#j=abc.def")).toMatchObject({ origin: ORIGIN, rest: "/#j=abc.def" });
    expect(ok("https://chat.example.org/signin?x=1")).toMatchObject({ rest: "/signin?x=1" });
  });

  it("https only — http just for a loopback development server, when allowed", () => {
    expect(err("http://chat.example.org")).toBe("scheme");
    expect(err("ftp://chat.example.org")).toBe("scheme");
    expect(err("javascript:alert(1)")).toBe("scheme");
    expect(err("file:///etc/passwd")).toBe("scheme");
    expect(err("http://localhost:5173")).toBe("insecure");
    expect(ok("http://localhost:5173", { allowLoopbackHttp: true })).toMatchObject({ origin: "http://localhost:5173", insecure: true });
    expect(ok("http://127.0.0.1:5173", { allowLoopbackHttp: true })).toMatchObject({ origin: "http://127.0.0.1:5173" });
    expect(err("http://192.168.1.10", { allowLoopbackHttp: true })).toBe("scheme");
  });

  it("no credentials in the address", () => {
    expect(err("https://user:pass@chat.example.org")).toBe("credentials");
    expect(err("https://user@chat.example.org")).toBe("credentials");
    expect(err("user@chat.example.org")).toBe("credentials");
  });

  it("IDN: loads the ASCII form, shows both", () => {
    const v = ok("https://müller.example");
    expect(v.origin).toBe("https://xn--mller-kva.example");
    expect(v.idn).toBe(true);
    expect(v.display).toBe("müller.example (xn--mller-kva.example)");
    // A look-alike (Cyrillic "а" in "pаypal") is visibly not the Latin name.
    const spoof = ok("https://pаypal.example");
    expect(spoof.origin).toMatch(/^https:\/\/xn--/);
    expect(spoof.display).toContain("xn--");
  });

  it("refuses malformed hosts, ports, and junk", () => {
    expect(err("")).toBe("empty");
    expect(err("   ")).toBe("empty");
    expect(err("intranet")).toBe("host");
    expect(err("https://exa mple.org")).toBe("invalid");
    expect(err("https://example.org:99999")).toBe("invalid");
    expect(err("https://-bad-.example.org")).toBe("host");
    expect(err("https://chat.example.org\\@evil.org")).toBe("invalid");
    expect(err(`https://${"a".repeat(300)}.org`)).not.toBe("ok");
    expect(err("https://1.2.3.4")).toBe("ok");
  });
});

describe("navigation guard", () => {
  it("the server's origin stays in the app; other sites open in the browser after a confirmation", () => {
    expect(decideNavigation(`${ORIGIN}/signin`, ORIGIN)).toBe("allow");
    expect(decideNavigation("https://example.com/", ORIGIN)).toBe("external");
    expect(decideNavigation("http://chat.example.org/", ORIGIN)).toBe("external");
    expect(decideNavigation("https://chat.example.org:444/", ORIGIN)).toBe("external");
    expect(decideNavigation("mailto:a@b.c", ORIGIN)).toBe("external");
    expect(decideNavigation("tel:+420123", ORIGIN)).toBe("external");
    expect(decideNavigation("m5cet://auth/callback?id=x", ORIGIN)).toBe("deep-link");
  });

  it("refuses dangerous schemes and credentials", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,<script>1</script>", "file:///etc/passwd", "blob:https://chat.example.org/uuid", "chrome://settings", "devtools://x", "about:blank", "vbscript:x", "smb://host/share", "https://u:p@chat.example.org/", "not a url"]) {
      expect(decideNavigation(url, ORIGIN)).toBe("block");
    }
  });

  it("new windows: same origin navigates, own blobs open in a script-less viewer, the rest as above", () => {
    expect(decideWindowOpen(`${ORIGIN}/layout-preview.html`, ORIGIN)).toBe("navigate");
    expect(decideWindowOpen(`blob:${ORIGIN}/0f1e2d3c`, ORIGIN)).toBe("viewer");
    expect(decideWindowOpen("blob:https://evil.example/0f1e", ORIGIN)).toBe("block");
    expect(decideWindowOpen("https://example.com", ORIGIN)).toBe("external");
    expect(decideWindowOpen("about:blank", ORIGIN)).toBe("block");
    expect(decideWindowOpen("javascript:void(0)", ORIGIN)).toBe("block");
  });

  it("describes an external link without credentials or a query", () => {
    expect(describeExternal("https://example.com/path?q=secret#x")).toBe("https://example.com/path");
    expect(describeExternal("mailto:someone@example.com")).toBe("mailto:someone@example.com");
    expect(describeExternal(`https://example.com/${"a".repeat(400)}`).length).toBeLessThanOrEqual(200);
  });
});

describe("permissions", () => {
  const q = (permission: string, extra: Partial<Parameters<typeof decidePermission>[0]> = {}) =>
    decidePermission({ permission, requestingOrigin: `${ORIGIN}/`, isMainFrame: true, ...extra }, ORIGIN);

  it("the server's main frame gets what the web client uses", () => {
    for (const p of ["media", "notifications", "clipboard-sanitized-write", "geolocation", "fullscreen", "display-capture", "speaker-selection", "serial", "usb", "hid", "fileSystem"]) {
      expect(q(p)).toBe(true);
    }
    expect(q("media", { mediaTypes: ["video", "audio"] })).toBe(true);
  });

  it("everything else, other origins and frames get nothing", () => {
    for (const p of ["clipboard-read", "midi", "midiSysex", "idle-detection", "window-management", "storage-access", "top-level-storage-access", "keyboardLock", "pointerLock", "mediaKeySystem", "openExternal", "unknown"]) {
      expect(q(p)).toBe(false);
    }
    expect(q("media", { requestingOrigin: "https://evil.example/" })).toBe(false);
    expect(q("media", { requestingOrigin: "null" })).toBe(false);
    expect(q("media", { isMainFrame: false })).toBe(false);
    expect(q("media", { topOrigin: "https://evil.example" })).toBe(false);
    expect(q("media", { mediaTypes: ["video", "screen"] })).toBe(false);
    expect(decidePermission({ permission: "media", requestingOrigin: ORIGIN, isMainFrame: true }, "")).toBe(false);
  });

  it("devices: USB, serial and HID for the server origin only", () => {
    expect(decideDevicePermission("usb", ORIGIN, ORIGIN)).toBe(true);
    expect(decideDevicePermission("serial", `${ORIGIN}/`, ORIGIN)).toBe(true);
    expect(decideDevicePermission("hid", "https://evil.example", ORIGIN)).toBe(false);
    expect(decideDevicePermission("bluetooth", ORIGIN, ORIGIN)).toBe(false);
  });
});

describe("m5cet:// links", () => {
  const ID = "AbCdEfGhIjKlMnOpQrStUv12";

  it("the sign-in callback carries only a well-formed id", () => {
    expect(parseDeepLink(`m5cet://auth/callback?id=${ID}`)).toEqual({ kind: "auth", id: ID });
    expect(parseDeepLink("m5cet://auth/callback?id=short")).toMatchObject({ kind: "invalid" });
    expect(parseDeepLink(`m5cet://auth/other?id=${ID}`)).toMatchObject({ kind: "invalid" });
    expect(parseDeepLink(`m5cet://auth/callback?id=${ID}<script>`)).toMatchObject({ kind: "invalid" });
  });

  it("opens a server page — an invite keeps its fragment", () => {
    expect(parseDeepLink("m5cet://chat.example.org/#j=abc.def")).toMatchObject({ kind: "open", origin: ORIGIN, path: "/#j=abc.def" });
    expect(parseDeepLink("m5cet://chat.example.org")).toMatchObject({ kind: "open", origin: ORIGIN, path: "/" });
    expect(parseDeepLink(`m5cet://open?url=${encodeURIComponent("https://chat.example.org/signin")}`)).toMatchObject({ kind: "open", origin: ORIGIN, path: "/signin" });
    expect(parseDeepLink(`m5cet://open?url=${encodeURIComponent("http://localhost:5173/")}`, { allowLoopbackHttp: true })).toMatchObject({ kind: "open", origin: "http://localhost:5173" });
  });

  it("refuses the rest", () => {
    for (const link of [
      "https://chat.example.org/", "m5cet:chat.example.org", "m5cet://user:pw@chat.example.org/", "m5cet://intranet/",
      `m5cet://open?url=${encodeURIComponent("http://chat.example.org/")}`, `m5cet://open?url=${encodeURIComponent("javascript:alert(1)")}`,
      "m5cet://chat.example.org/\\evil", "m5cet://chat.example.org/ x", `m5cet://chat.example.org/${"a".repeat(5000)}`,
    ]) expect(parseDeepLink(link)).toMatchObject({ kind: "invalid" });
  });

  it("finds the link among command-line arguments (Windows, second instance)", () => {
    expect(deepLinkFromArgv(["M5cet.exe", "--hidden", `m5cet://auth/callback?id=${ID}`])).toBe(`m5cet://auth/callback?id=${ID}`);
    expect(deepLinkFromArgv(["M5cet.exe", "--inspect"])).toBeNull();
  });
});

describe("version check", () => {
  const app = { app: "m5cet", version: "6.13.0", build: "aaaa1111", protocol: 2 };
  it("same, compatible, incompatible, unknown", () => {
    expect(compareVersions(app, { ...app })).toMatchObject({ level: "same" });
    expect(compareVersions(app, { ...app, build: "bbbb2222" })).toMatchObject({ level: "compatible" });
    expect(compareVersions(app, { ...app, version: "6.13.4", build: "x" })).toMatchObject({ level: "compatible" });
    expect(compareVersions(app, { ...app, version: "6.14.0", build: "x" })).toMatchObject({ level: "incompatible", reasons: ["version"], newer: "server" });
    expect(compareVersions(app, { ...app, version: "6.12.0", build: "x" })).toMatchObject({ level: "incompatible", newer: "app" });
    expect(compareVersions(app, { ...app, protocol: 3 })).toMatchObject({ level: "incompatible", reasons: ["protocol"] });
    expect(compareVersions(app, null)).toMatchObject({ level: "unknown" });
    expect(compareVersions(app, { html: "<!doctype html>" })).toMatchObject({ level: "unknown" });
    expect(compareVersions(app, { app: "other", version: "6.13.0", build: "x", protocol: 2 })).toMatchObject({ level: "unknown" });
  });
  it("a broken bundled manifest is an error, not a silent pass", () => {
    expect(() => compareVersions({}, app)).toThrow();
  });
});

describe("settings", () => {
  it("reads back only what is well-formed", () => {
    const s = sanitizeSettings({
      servers: [
        { origin: ORIGIN, codeSource: "server", addedAt: 1, lastUsedAt: 2 },
        { origin: "http://evil.example" }, { origin: "https://u:p@x.example" }, { origin: ORIGIN }, "junk", null,
        { origin: "https://chat.example.org/#j=1" },
      ],
      current: "https://not-in-list.example", window: { width: 50, height: 9e9 }, passkeys: "everything", locale: "xx", closeToTray: false,
    });
    expect(s.servers).toHaveLength(1);
    expect(s.servers[0]).toMatchObject({ origin: ORIGIN, codeSource: "server" });
    expect(s.current).toBeNull();
    expect(s.window).toBeNull();
    expect(s.passkeys).toBe("auto");
    expect(s.locale).toBeNull();
    expect(s.closeToTray).toBe(false);
    expect(sanitizeSettings("not json")).toEqual(defaultSettings());
  });

  it("adds, refreshes, removes servers and remembers the code source per server", () => {
    let s = defaultSettings();
    const a = addServer(s, "chat.example.org", 10);
    expect(a.ok).toBe(true);
    s = (a as { settings: typeof s }).settings;
    expect(s.current).toBe(ORIGIN);
    s = setCodeSource(s, ORIGIN, "server");
    expect(s.servers[0].codeSource).toBe("server");
    const again = addServer(s, "https://chat.example.org/", 20);
    s = (again as { settings: typeof s }).settings;
    expect(s.servers).toHaveLength(1);
    expect(s.servers[0]).toMatchObject({ addedAt: 10, lastUsedAt: 20, codeSource: "server" });
    expect(addServer(s, "http://chat.example.org", 1)).toMatchObject({ ok: false, error: "scheme" });
    for (let i = 0; i < MAX_SERVERS + 5; i++) s = (addServer(s, `s${i}.example.org`, 100 + i) as { settings: typeof s }).settings;
    expect(s.servers).toHaveLength(MAX_SERVERS);
    s = removeServer(s, s.current!);
    expect(s.current).toBeNull();
  });

  it("passkeys: macOS through the browser, Windows in the app, unless chosen", () => {
    expect(effectivePasskeyMode("auto", "darwin")).toBe("browser");
    expect(effectivePasskeyMode("auto", "win32")).toBe("app");
    expect(effectivePasskeyMode("app", "darwin")).toBe("app");
    expect(effectivePasskeyMode("browser", "win32")).toBe("browser");
  });
});

describe("badge", () => {
  it("reads the count the page writes into its title", () => {
    expect(unreadFromTitle("(3) M5cet | room")).toBe(3);
    expect(unreadFromTitle("M5cet | (3) room")).toBe(0);
    expect(unreadFromTitle("(abc) M5cet")).toBe(0);
    expect(badgeText(0)).toBe("");
    expect(badgeText(7)).toBe("7");
    expect(badgeText(250)).toBe("99+");
  });
  it("draws a 32×32 BGRA overlay", () => {
    const b = overlayBitmap(5);
    expect(b.length).toBe(32 * 32 * 4);
    const centre = (16 * 32 + 3) * 4;
    expect([b[centre], b[centre + 1], b[centre + 2], b[centre + 3]]).toEqual([0x2f, 0x1c, 0xd6, 0xff]);
    expect(overlayBitmap(42).equals(overlayBitmap(99))).toBe(true); // both "9+"
  });
});

describe("desktop texts", () => {
  it("every text exists in all nine languages with the same placeholders", () => {
    for (const [key, row] of Object.entries(STRINGS)) {
      const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
      for (const l of LOCALES) {
        expect(row[l], `${key}/${l}`).toBeTruthy();
        expect(vars(row[l]), `${key}/${l}`).toBe(vars(row.en));
      }
    }
  });
  it("French puts a non-breaking space before : ; ? !", () => {
    for (const [key, row] of Object.entries(STRINGS)) {
      expect(/ [:;?!]/.test(row.fr), key).toBe(false);
    }
  });
  it("fills placeholders, falls back, picks the language", () => {
    expect(t("cs", "tray.unread", { count: 4 })).toBe("Nepřečtené: 4");
    expect(t("fr", "dlg.device.body", { server: "x" })).toBe("x veut utiliser un appareil :");
    expect(resolveLocale("sk", ["en-US"])).toBe("sk");
    expect(resolveLocale(null, ["de-AT", "en"])).toBe("de");
    expect(resolveLocale("xx", ["pt-BR"])).toBe("en");
    expect(spellcheckLanguages("cs", ["cs", "en-US", "de"])).toEqual(["cs", "en-US"]);
    expect(spellcheckLanguages("en", ["en-US"])).toEqual(["en-US"]);
    expect(spellcheckLanguages("fi", [])).toEqual([]);
  });
});
