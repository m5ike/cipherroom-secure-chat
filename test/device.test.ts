// @vitest-environment node
//
// Device / browser classification with real User-Agent strings. The layout
// (data-os / data-browser / data-form …) is chosen from this.

import { describe, it, expect } from "vitest";
import { classifyDevice, describeDevice } from "../client/src/lib/device";

const base = { touchPoints: 0, shortSide: 0, coarse: false, standalone: false };
const touch = (shortSide: number) => ({ touchPoints: 5, shortSide, coarse: true, standalone: false });

const UA = {
  iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1",
  iphoneFirefox: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15",
  iphoneInApp: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 330.0",
  ipadDesktopMode: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  androidChrome: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.71 Mobile Safari/537.36",
  androidTablet: "Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  samsung: "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
  webview: "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.71 Mobile Safari/537.36",
  firefoxAndroid: "Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0",
  edgeAndroid: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 EdgA/126.0.2592.61",
  chromeWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  edgeWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.68",
  safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
  chromebook: "Mozilla/5.0 (X11; CrOS x86_64 15917.71.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

describe("classifyDevice", () => {
  it.each([
    ["iPhone Safari", UA.iphoneSafari, touch(390), { os: "ios", browser: "safari", engine: "webkit", form: "phone", osVersion: "18.1" }],
    ["iPhone Chrome (still WebKit)", UA.iphoneChrome, touch(390), { os: "ios", browser: "chrome", engine: "webkit", form: "phone" }],
    ["iPhone Firefox (still WebKit)", UA.iphoneFirefox, touch(390), { os: "ios", browser: "firefox", engine: "webkit", form: "phone" }],
    ["iPhone in-app browser", UA.iphoneInApp, touch(390), { os: "ios", browser: "webview", engine: "webkit" }],
    ["iPad in desktop mode (claims Mac)", UA.ipadDesktopMode, touch(820), { os: "ipados", browser: "safari", form: "tablet" }],
    ["Android Chrome phone", UA.androidChrome, touch(412), { os: "android", browser: "chrome", engine: "blink", form: "phone", osVersion: "14" }],
    ["Android tablet", UA.androidTablet, touch(800), { os: "android", browser: "chrome", form: "tablet" }],
    ["Samsung Internet", UA.samsung, touch(384), { os: "android", browser: "samsung", engine: "blink", form: "phone", browserVersion: "25.0" }],
    ["Android WebView", UA.webview, touch(412), { os: "android", browser: "webview", engine: "blink" }],
    ["Firefox Android", UA.firefoxAndroid, touch(412), { os: "android", browser: "firefox", engine: "gecko", form: "phone" }],
    ["Edge Android", UA.edgeAndroid, touch(412), { os: "android", browser: "edge", engine: "blink" }],
    ["Chrome Windows", UA.chromeWin, base, { os: "windows", browser: "chrome", engine: "blink", form: "desktop" }],
    ["Edge Windows", UA.edgeWin, base, { os: "windows", browser: "edge", form: "desktop" }],
    ["Safari macOS", UA.safariMac, base, { os: "macos", browser: "safari", engine: "webkit", form: "desktop" }],
    ["Firefox Linux", UA.firefoxLinux, base, { os: "linux", browser: "firefox", engine: "gecko", form: "desktop" }],
    ["Chromebook", UA.chromebook, base, { os: "chromeos", browser: "chrome", form: "desktop" }],
  ])("%s", (_name, ua, env, expected) => {
    expect(classifyDevice({ ua, ...env })).toMatchObject(expected);
  });

  it("a touch Windows laptop stays desktop; a small coarse screen is a phone", () => {
    expect(classifyDevice({ ua: UA.chromeWin, touchPoints: 10, shortSide: 1200, coarse: false, standalone: false }).form).toBe("desktop");
    expect(classifyDevice({ ua: UA.chromeWin, touchPoints: 10, shortSide: 540, coarse: true, standalone: false }).form).toBe("phone");
    expect(classifyDevice({ ua: UA.chromeWin, touchPoints: 10, shortSide: 900, coarse: true, standalone: false }).form).toBe("tablet");
  });

  it("describes the device for the Appearance screen", () => {
    expect(describeDevice(classifyDevice({ ua: UA.iphoneSafari, ...touch(390) }))).toBe("iPhone (iOS) 18.1 · Safari 18 · webkit");
  });
});
