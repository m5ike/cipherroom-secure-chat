// Device + browser detection and the viewport plumbing mobile layouts need.
//
// detectDevice() classifies OS / browser / engine / form factor / input /
// standalone (installed PWA). applyDeviceAttributes() publishes the result as
// data-* attributes on <html>, which mobile.css keys its optimised layout on:
//
//   data-os        ios | ipados | android | windows | macos | linux | chromeos | other
//   data-browser   safari | chrome | firefox | edge | samsung | opera | webview | other
//   data-engine    webkit | blink | gecko | other
//   data-form      phone | tablet | desktop   (after the user's override)
//   data-input     touch | mouse
//   data-standalone  yes | no                  (home-screen app / display-mode)
//   data-fullscreen  yes | no
//   data-keyboard  open | closed                (on-screen keyboard, via visualViewport)
//
// Feature detection wins over the UA string where it can (iPadOS 13+ claims
// to be a Mac; touch is measured, not guessed). Runs before the first React
// render (main.tsx), so the first paint already has the right layout.

export type OsId = "ios" | "ipados" | "android" | "windows" | "macos" | "linux" | "chromeos" | "other";
export type BrowserId = "safari" | "chrome" | "firefox" | "edge" | "samsung" | "opera" | "webview" | "other";
export type EngineId = "webkit" | "blink" | "gecko" | "other";
export type FormFactor = "phone" | "tablet" | "desktop";
export type DeviceLayoutPref = "auto" | FormFactor;

export type DeviceInfo = {
  os: OsId;
  browser: BrowserId;
  engine: EngineId;
  form: FormFactor;
  touch: boolean;
  standalone: boolean;
  browserVersion: string;
  osVersion: string;
};

type UaInput = {
  ua: string;
  /** navigator.maxTouchPoints */
  touchPoints: number;
  /** min(screen.width, screen.height) in CSS px */
  shortSide: number;
  /** matchMedia("(pointer: coarse)") */
  coarse: boolean;
  standalone: boolean;
};

function version(ua: string, re: RegExp): string {
  const m = re.exec(ua);
  return m ? m[1].replace(/_/g, ".") : "";
}

/** Pure classification — unit-tested with real UA strings. */
export function classifyDevice(input: UaInput): DeviceInfo {
  const { ua, touchPoints, shortSide, coarse, standalone } = input;
  let os: OsId = "other";
  let osVersion = "";
  if (/iPhone|iPod/.test(ua)) { os = "ios"; osVersion = version(ua, /OS (\d+[_.]\d+)/); }
  else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) { os = "ipados"; osVersion = version(ua, /OS (\d+[_.]\d+)/) || version(ua, /Version\/(\d+\.\d+)/); }
  else if (/Android/.test(ua)) { os = "android"; osVersion = version(ua, /Android (\d+(?:\.\d+)?)/); }
  else if (/CrOS/.test(ua)) os = "chromeos";
  else if (/Windows NT/.test(ua)) { os = "windows"; osVersion = version(ua, /Windows NT (\d+\.\d+)/); }
  else if (/Macintosh|Mac OS X/.test(ua)) { os = "macos"; osVersion = version(ua, /Mac OS X (\d+[_.]\d+)/); }
  else if (/Linux|X11/.test(ua)) os = "linux";

  const apple = os === "ios" || os === "ipados";
  let browser: BrowserId = "other";
  let browserVersion = "";
  if (/SamsungBrowser\//.test(ua)) { browser = "samsung"; browserVersion = version(ua, /SamsungBrowser\/(\d+(?:\.\d+)?)/); }
  else if (/EdgA?\/|EdgiOS\/|Edg\//.test(ua)) { browser = "edge"; browserVersion = version(ua, /Edg(?:A|iOS)?\/(\d+(?:\.\d+)?)/); }
  else if (/OPR\/|OPT\/|Opera/.test(ua)) { browser = "opera"; browserVersion = version(ua, /(?:OPR|OPT)\/(\d+(?:\.\d+)?)/); }
  else if (/FxiOS\/|Firefox\//.test(ua)) { browser = "firefox"; browserVersion = version(ua, /(?:FxiOS|Firefox)\/(\d+(?:\.\d+)?)/); }
  else if (/CriOS\//.test(ua)) { browser = "chrome"; browserVersion = version(ua, /CriOS\/(\d+(?:\.\d+)?)/); }
  else if (os === "android" && /; wv\)/.test(ua)) { browser = "webview"; browserVersion = version(ua, /Chrome\/(\d+(?:\.\d+)?)/); }
  else if (/Chrome\/|Chromium\//.test(ua)) { browser = "chrome"; browserVersion = version(ua, /(?:Chrome|Chromium)\/(\d+(?:\.\d+)?)/); }
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) { browser = "safari"; browserVersion = version(ua, /Version\/(\d+(?:\.\d+)?)/); }
  else if (apple) browser = "webview"; // in-app WKWebView (no "Safari/" token)

  // Every iOS / iPadOS browser is WebKit underneath, whatever its name.
  const engine: EngineId = apple ? "webkit"
    : browser === "firefox" ? "gecko"
    : browser === "safari" ? "webkit"
    : browser === "other" ? "other"
    : "blink";

  const touch = touchPoints > 0 || coarse;
  let form: FormFactor;
  if (os === "ios") form = "phone";
  else if (os === "ipados") form = "tablet";
  else if (os === "android") form = /Mobile/.test(ua) ? "phone" : "tablet";
  else if (coarse && shortSide > 0 && shortSide < 600) form = "phone";
  else if (coarse && shortSide > 0 && shortSide < 1100) form = "tablet";
  else form = "desktop";

  return { os, browser, engine, form, touch, standalone, browserVersion, osVersion };
}

function mq(query: string): boolean {
  try { return typeof matchMedia === "function" && matchMedia(query).matches; } catch { return false; }
}

export function isStandalone(): boolean {
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { standalone?: boolean }) : undefined;
  return nav?.standalone === true || mq("(display-mode: standalone)") || mq("(display-mode: fullscreen)") || mq("(display-mode: minimal-ui)");
}

export function detectDevice(): DeviceInfo {
  if (typeof navigator === "undefined") {
    return classifyDevice({ ua: "", touchPoints: 0, shortSide: 0, coarse: false, standalone: false });
  }
  const shortSide = typeof screen !== "undefined" ? Math.min(screen.width || 0, screen.height || 0) : 0;
  return classifyDevice({
    ua: navigator.userAgent || "",
    touchPoints: navigator.maxTouchPoints || 0,
    shortSide,
    coarse: mq("(pointer: coarse)"),
    standalone: isStandalone(),
  });
}

const OS_LABEL: Record<OsId, string> = { ios: "iPhone (iOS)", ipados: "iPad (iPadOS)", android: "Android", windows: "Windows", macos: "macOS", linux: "Linux", chromeos: "ChromeOS", other: "?" };
const BROWSER_LABEL: Record<BrowserId, string> = { safari: "Safari", chrome: "Chrome", firefox: "Firefox", edge: "Edge", samsung: "Samsung Internet", opera: "Opera", webview: "WebView (in-app)", other: "?" };

export function describeDevice(d: DeviceInfo): string {
  const os = `${OS_LABEL[d.os]}${d.osVersion ? ` ${d.osVersion}` : ""}`;
  const br = `${BROWSER_LABEL[d.browser]}${d.browserVersion ? ` ${d.browserVersion.split(".")[0]}` : ""}`;
  return `${os} · ${br} · ${d.engine}`;
}

let current: DeviceInfo | null = null;
export function deviceInfo(): DeviceInfo {
  if (!current) current = detectDevice();
  return current;
}

/** Publish the classification (with the user's layout override) on <html>. */
export function applyDeviceAttributes(info: DeviceInfo = deviceInfo(), override: DeviceLayoutPref = "auto"): FormFactor {
  const form = override === "auto" ? info.form : override;
  if (typeof document === "undefined") return form;
  const root = document.documentElement;
  root.setAttribute("data-os", info.os);
  root.setAttribute("data-browser", info.browser);
  root.setAttribute("data-engine", info.engine);
  root.setAttribute("data-form", form);
  root.setAttribute("data-form-detected", info.form);
  root.setAttribute("data-input", info.touch && mq("(pointer: coarse)") ? "touch" : "mouse");
  root.setAttribute("data-standalone", isStandalone() ? "yes" : "no");
  return form;
}

/* --------------------------------------------------------- viewport sync */

/** Keeps --app-h / --app-top / --kb in step with the *visual* viewport.
 *  iOS Safari does not shrink the layout viewport for the keyboard (and
 *  100dvh ignores it), so a 100dvh app hides its composer behind the
 *  keyboard; sizing the shell to visualViewport.height keeps the input in
 *  view. Pinch-zoom (scale != 1) is ignored so zooming never resizes the app. */
export function startViewportSync(): () => void {
  if (typeof window === "undefined") return () => {};
  const root = document.documentElement;
  const vv = window.visualViewport;
  let raf = 0;
  const update = () => {
    raf = 0;
    const zoomed = vv ? Math.abs(vv.scale - 1) > 0.01 : false;
    const h = vv && !zoomed ? vv.height : window.innerHeight;
    const top = vv && !zoomed ? vv.offsetTop : 0;
    const kb = vv && !zoomed ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    // A hidden / not-yet-laid-out page reports 0: never size the shell to
    // that — drop the variables so the 100dvh fallbacks apply until a real
    // measurement arrives.
    if (h < 1) {
      root.style.removeProperty("--app-h");
      root.style.removeProperty("--app-top");
      root.style.removeProperty("--kb");
      root.setAttribute("data-keyboard", "closed");
      return;
    }
    root.style.setProperty("--app-h", `${Math.round(h)}px`);
    root.style.setProperty("--app-top", `${Math.round(top)}px`);
    root.style.setProperty("--kb", `${Math.round(kb)}px`);
    root.setAttribute("data-keyboard", kb > 80 ? "open" : "closed");
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };
  const onOrientation = () => { schedule(); window.setTimeout(schedule, 350); };
  vv?.addEventListener("resize", schedule);
  vv?.addEventListener("scroll", schedule);
  window.addEventListener("resize", schedule);
  window.addEventListener("orientationchange", onOrientation);
  window.addEventListener("pageshow", schedule);
  document.addEventListener("visibilitychange", schedule);
  // Standalone / display-mode can change when the app is installed while open.
  const standaloneMq = typeof matchMedia === "function" ? matchMedia("(display-mode: standalone)") : null;
  const onStandalone = () => root.setAttribute("data-standalone", isStandalone() ? "yes" : "no");
  standaloneMq?.addEventListener?.("change", onStandalone);
  update();
  return () => {
    if (raf) cancelAnimationFrame(raf);
    vv?.removeEventListener("resize", schedule);
    vv?.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
    window.removeEventListener("orientationchange", onOrientation);
    window.removeEventListener("pageshow", schedule);
    document.removeEventListener("visibilitychange", schedule);
    standaloneMq?.removeEventListener?.("change", onStandalone);
  };
}

/* ------------------------------------------------------------ fullscreen */

type FsDocument = Document & {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type FsElement = HTMLElement & { webkitRequestFullscreen?: (opts?: unknown) => Promise<void> | void };

/** Element fullscreen: Android, desktop, iPadOS 16.4+. iPhone Safari has none
 *  (only video) — there "Add to Home Screen" gives the full-screen app. */
export function fullscreenSupported(): boolean {
  if (typeof document === "undefined") return false;
  const d = document as FsDocument;
  return Boolean(d.fullscreenEnabled || d.webkitFullscreenEnabled);
}

export function isFullscreen(): boolean {
  if (typeof document === "undefined") return false;
  const d = document as FsDocument;
  return Boolean(d.fullscreenElement || d.webkitFullscreenElement);
}

export async function toggleFullscreen(): Promise<boolean> {
  const d = document as FsDocument;
  try {
    if (isFullscreen()) {
      if (d.exitFullscreen) await d.exitFullscreen();
      else await d.webkitExitFullscreen?.();
      return false;
    }
    const el = document.documentElement as FsElement;
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: "hide" });
    else await el.webkitRequestFullscreen?.();
    return true;
  } catch {
    return isFullscreen();
  }
}

export function watchFullscreen(onChange: (on: boolean) => void): () => void {
  if (typeof document === "undefined") return () => {};
  const handler = () => {
    const on = isFullscreen();
    document.documentElement.setAttribute("data-fullscreen", on ? "yes" : "no");
    onChange(on);
  };
  document.addEventListener("fullscreenchange", handler);
  document.addEventListener("webkitfullscreenchange", handler);
  document.documentElement.setAttribute("data-fullscreen", isFullscreen() ? "yes" : "no");
  return () => {
    document.removeEventListener("fullscreenchange", handler);
    document.removeEventListener("webkitfullscreenchange", handler);
  };
}

/* ------------------------------------------------------ install prompt */

type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice?: Promise<{ outcome: string }> };
let deferredInstall: InstallPromptEvent | null = null;
const installListeners = new Set<() => void>();

/** Chromium (Android, desktop) offers "install app" through
 *  beforeinstallprompt; keep it for an explicit button in Appearance. iOS has
 *  no such event — there it is Share → Add to Home Screen. */
export function captureInstallPrompt(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstall = e as InstallPromptEvent;
    installListeners.forEach((l) => l());
  });
  window.addEventListener("appinstalled", () => {
    deferredInstall = null;
    installListeners.forEach((l) => l());
  });
}

export const canPromptInstall = (): boolean => deferredInstall !== null;

export async function promptInstall(): Promise<boolean> {
  const ev = deferredInstall;
  if (!ev) return false;
  deferredInstall = null;
  installListeners.forEach((l) => l());
  await ev.prompt();
  const choice = await ev.userChoice?.catch(() => undefined);
  return choice?.outcome === "accepted";
}

export function onInstallAvailability(fn: () => void): () => void {
  installListeners.add(fn);
  return () => installListeners.delete(fn);
}
