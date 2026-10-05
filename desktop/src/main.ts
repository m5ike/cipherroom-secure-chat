// M5cet Desktop — the main process.
//
// The window shows https://<server>/ in a session partition of its own; the
// client's code comes from inside the signed app (intercept.ts + router.ts),
// the server provides only the service (API, WebSocket, files). docs/desktop.md
// describes the whole design; this file wires it together:
//
//   startup     single instance, sandbox for every renderer, fuses (build time),
//               no remote debugging in a packaged build, settings (store.ts)
//   servers     the picker (m5cet-app://ui/welcome.html), the version check
//               (version-compat.ts), "use this server's web code" per server
//               with a banner the page cannot hide
//   the page    navigation guard, new windows, permissions, device choosers,
//               screen sharing, downloads, spell checking, context menu
//   native      menus, tray, notifications, dock / taskbar badge, deep links,
//               start at login, window state, updates (signed builds only)
//   passkeys    in the app (Windows Hello, security keys) or through the system
//               browser (desktop-auth: the result comes back encrypted)

import {
  app, BaseWindow, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, nativeImage, Notification, protocol, session,
  shell, systemPreferences, Tray, WebContentsView,
  type IpcMainEvent, type IpcMainInvokeEvent, type Session, type WebContents, type WebPreferences,
} from "electron";
import { existsSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { APP_SCHEME, BUILD, PAGE_PARTITION } from "./config";
import { deepLinkFromArgv, parseDeepLink, type DeepLink } from "./deep-link";
import { resolveLocale, spellcheckLanguages, STRINGS, t, type StringKey } from "./i18n";
import { Interceptor, loadBundle, type Target, type WebBundle } from "./intercept";
import { applicationMenu, contextMenu, trayMenu, type MenuContext } from "./menu";
import { decideNavigation, decideWindowOpen, describeExternal } from "./nav-guard";
import { decideDevicePermission, decidePermission } from "./permissions";
import { parseServerUrl, type ServerUrlError } from "./server-url";
import { addServer, effectivePasskeyMode, removeServer, serverEntry, setCodeSource, type CodeSource, type PasskeyMode } from "./settings";
import { SettingsStore } from "./store";
import { Updater } from "./updater";
import { compareVersions, type Compat } from "./version-compat";
import { webSecurityHeaders } from "./web-headers";
import { badgeText, overlayBitmap, unreadFromTitle } from "./badge";
import { isLocale, type Locale } from "../../client/src/lib/locales";

/* ======================================================= process hardening */

const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";
/** A development server on http://localhost — only unpackaged, or explicitly for a local test. */
const ALLOW_LOOPBACK = !app.isPackaged || process.env.M5CET_ALLOW_LOOPBACK === "1";
const SMOKE_REPORT = process.env.M5CET_SMOKE_REPORT ?? "";
const SMOKE_SERVER = process.env.M5CET_SMOKE_SERVER ?? "";

// A packaged build is not debuggable from the command line: remote debugging
// would hand the page (and its keys) to whoever started the process. (The
// node --inspect switches are off through the fuses.)
if (app.isPackaged) {
  for (const sw of ["remote-debugging-port", "remote-debugging-pipe", "inspect", "inspect-brk", "inspect-port", "js-flags"]) {
    if (app.commandLine.hasSwitch(sw)) {
      console.error(`M5cet: --${sw} is not allowed in a release build.`);
      app.exit(2);
    }
  }
}

if (process.env.M5CET_USER_DATA) app.setPath("userData", process.env.M5CET_USER_DATA);
app.enableSandbox();
if (IS_WIN) app.setAppUserModelId(BUILD.appId);
protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true } }]);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.exit(0);

/* ================================================================== state */

let store: SettingsStore;
let bundle: WebBundle;
let interceptor: Interceptor;
let pageSession: Session;
let updater: Updater;
let tray: Tray | null = null;

let win: BaseWindow | null = null;
let page: WebContentsView | null = null;
let banner: WebContentsView | null = null;
let welcome: BrowserWindow | null = null;
let welcomeError = "";
let quitting = false;
let unread = { title: 0, bridge: 0 };
let shownBackgroundNotice = false;
const pendingLinks: string[] = [];
const notes = new Map<string, Notification>();
let authBox: AbortController | null = null;
let ready = false;

const headersFor = (target: Target) => webSecurityHeaders({ insecureLoopback: target.origin.startsWith("http:") });

function locale(): Locale {
  return resolveLocale(store?.get().locale ?? null, app.getPreferredSystemLanguages());
}
const L = (key: StringKey, vars?: Record<string, string | number>) => t(locale(), key, vars);

function current(): Target | null {
  return interceptor?.getTarget() ?? null;
}

function currentDisplay(): string {
  const tgt = current();
  if (!tgt) return "";
  return serverEntry(store.get(), tgt.origin)?.display ?? new URL(tgt.origin).host;
}

/* ========================================================== deep links */

app.on("will-finish-launching", () => {
  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (ready) void handleDeepLink(url); else pendingLinks.push(url);
  });
});

app.on("second-instance", (_event, argv) => {
  const link = deepLinkFromArgv(argv);
  if (link) void handleDeepLink(link);
  else showMain();
});

async function handleDeepLink(raw: string): Promise<void> {
  const link: DeepLink = parseDeepLink(raw, { allowLoopbackHttp: ALLOW_LOOPBACK });
  if (link.kind === "invalid") { console.warn(`[m5cet] ignored link (${link.reason})`); return; }
  if (link.kind === "auth") {
    // The browser finished: the page collects the encrypted result itself.
    showMain();
    page?.webContents.send("m5:auth-callback", link.id);
    return;
  }
  const known = serverEntry(store.get(), link.origin);
  if (!known) {
    const r = await messageBox({
      type: "question", message: L("dlg.newServer.title"), detail: L("dlg.newServer.body", { server: link.display }),
      buttons: [L("btn.open"), L("btn.cancel")], defaultId: 1, cancelId: 1,
    });
    if (r !== 0) return;
    const added = addServer(store.get(), link.origin, Date.now(), { allowLoopbackHttp: ALLOW_LOOPBACK });
    if (!added.ok) return;
    store.set(added.settings);
  }
  await openServer(link.origin, { path: link.path });
}

/* ============================================================ dialogs */

async function messageBox(opts: Electron.MessageBoxOptions): Promise<number> {
  const parent = win && !win.isDestroyed() && win.isVisible() ? win : welcome && !welcome.isDestroyed() ? welcome : null;
  const r = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
  return r.response;
}

async function confirmExternal(url: string): Promise<void> {
  const shown = describeExternal(url);
  if (!shown) return;
  const r = await messageBox({
    type: "question", message: L("dlg.external.title"), detail: `${L("dlg.external.body", { server: currentDisplay() })}\n\n${shown}`,
    buttons: [L("btn.open"), L("btn.cancel")], defaultId: 0, cancelId: 1, noLink: true,
  });
  if (r === 0) await shell.openExternal(url);
}

/** A native chooser for USB / serial / HID / Bluetooth devices and screens (at most 8 shown). */
async function choose(items: Array<{ id: string; label: string }>): Promise<string | null> {
  if (items.length === 0) {
    await messageBox({ type: "info", message: L("dlg.device.title"), detail: L("dlg.device.none"), buttons: [L("btn.ok")] });
    return null;
  }
  const shown = items.slice(0, 8);
  const r = await messageBox({
    type: "question", message: L("dlg.device.title"), detail: L("dlg.device.body", { server: currentDisplay() }),
    buttons: [...shown.map((i) => i.label.slice(0, 80) || i.id), L("btn.cancel")], cancelId: shown.length, noLink: true,
  });
  return r < shown.length ? shown[r].id : null;
}

/* ===================================================== the page session */

function isServerFrame(origin: string | undefined | null): boolean {
  const tgt = current();
  if (!tgt || !origin) return false;
  try { return new URL(origin).origin === tgt.origin; } catch { return false; }
}

function setupPageSession(ses: Session): void {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const tgt = current();
    const ok = Boolean(tgt) && wc === page?.webContents && decidePermission({
      permission, requestingOrigin: details.requestingUrl ?? "", isMainFrame: details.isMainFrame,
      mediaTypes: (details as { mediaTypes?: string[] }).mediaTypes,
    }, tgt!.origin);
    if (!ok) return callback(false);
    if (IS_MAC && permission === "media") {
      // The macOS privacy prompt (once per app); the page's request waits for it.
      const kinds = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
      void Promise.all(kinds.map((k) => systemPreferences.askForMediaAccess(k === "video" ? "camera" : "microphone").catch(() => false)))
        .then((granted) => callback(granted.every(Boolean)));
      return;
    }
    callback(true);
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    const tgt = current();
    if (!tgt) return false;
    // A service worker asks without a WebContents (its notifications).
    if (wc && wc !== page?.webContents) return false;
    return decidePermission({ permission, requestingOrigin, isMainFrame: details.isMainFrame ?? true }, tgt.origin);
  });
  ses.setDevicePermissionHandler((details) => {
    const tgt = current();
    return Boolean(tgt) && decideDevicePermission(details.deviceType, details.origin, tgt!.origin);
  });
  ses.on("select-serial-port", (event, portList, wc, callback) => {
    event.preventDefault();
    if (wc !== page?.webContents || !isServerFrame(wc.getURL())) return callback("");
    void choose(portList.map((p) => ({ id: p.portId, label: p.displayName || p.portName || p.portId }))).then((id) => callback(id ?? ""));
  });
  ses.on("select-hid-device", (event, details, callback) => {
    event.preventDefault();
    if (!isServerFrame(details.frame?.url)) return callback(null);
    void choose(details.deviceList.map((d) => ({ id: d.deviceId, label: d.name || `${d.vendorId}:${d.productId}` }))).then((id) => callback(id));
  });
  ses.on("select-usb-device", (event, details, callback) => {
    event.preventDefault();
    if (!isServerFrame(details.frame?.url)) return callback();
    void choose(details.deviceList.map((d) => ({ id: d.deviceId, label: d.productName || d.manufacturerName || `${d.vendorId}:${d.productId}` }))).then((id) => callback(id ?? undefined));
  });
  ses.setDisplayMediaRequestHandler((request, callback) => {
    if (!isServerFrame(request.securityOrigin)) return callback({});
    void desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } }).then(async (sources) => {
      const id = await choose(sources.map((s) => ({ id: s.id, label: s.name })));
      const source = sources.find((s) => s.id === id);
      if (!source) return callback({});
      callback({ video: source, ...(IS_WIN && request.audioRequested ? { audio: "loopback" as const } : {}) });
    }).catch(() => callback({}));
  }, { useSystemPicker: true });
  ses.on("will-download", (_event, item) => {
    // The save dialog as in a browser; nothing is opened automatically.
    item.setSaveDialogOptions({ title: item.getFilename() });
  });
}

function pagePreferences(): WebPreferences {
  return {
    session: pageSession,
    preload: join(__dirname, "preload.cjs"),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    spellcheck: true,
    safeDialogs: true,
    experimentalFeatures: false,
    // Messages and calls keep arriving while the window is hidden.
    backgroundThrottling: false,
    devTools: !app.isPackaged || process.env.M5CET_DEVTOOLS === "1",
  };
}

/** Navigation guard, new windows and the rest for the page and its child windows. */
function guardContents(wc: WebContents, kind: "page" | "child" | "viewer"): void {
  wc.setWindowOpenHandler(({ url }) => {
    const tgt = current();
    if (!tgt || kind === "viewer") return { action: "deny" };
    const d = decideWindowOpen(url, tgt.origin);
    if (d === "external") { void confirmExternal(url); return { action: "deny" }; }
    if (d === "deep-link") { void handleDeepLink(url); return { action: "deny" }; }
    if (d === "navigate" || d === "viewer") {
      const viewer = d === "viewer";
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 980, height: 760, autoHideMenuBar: true, backgroundColor: "#0a0d12",
          webPreferences: {
            session: pageSession, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false,
            spellcheck: !viewer, devTools: !app.isPackaged,
            // A decrypted file shown as a page: no script at all (its content came from another member).
            javascript: !viewer,
          },
        },
      };
    }
    return { action: "deny" };
  });
  wc.on("did-create-window", (child) => {
    const childKind = child.webContents.getURL().startsWith("blob:") ? "viewer" : "child";
    guardContents(child.webContents, childKind);
  });
  const onNavigate = (event: Electron.Event, url: string) => {
    const tgt = current();
    if (!tgt) { event.preventDefault(); return; }
    if (kind === "viewer") { event.preventDefault(); return; }
    const d = decideNavigation(url, tgt.origin);
    if (d === "allow") return;
    event.preventDefault();
    if (d === "external") void confirmExternal(url);
    else if (d === "deep-link") void handleDeepLink(url);
    else console.warn(`[m5cet] navigation refused: ${url.slice(0, 80)}`);
  };
  wc.on("will-navigate", onNavigate);
  wc.on("will-redirect", onNavigate);
  wc.on("will-frame-navigate", (event) => {
    if (event.isMainFrame) return;
    const tgt = current();
    const url = event.url;
    if (url === "about:blank" || url === "about:srcdoc") return;
    try { if (tgt && new URL(url).origin === tgt.origin) return; } catch { /* refuse */ }
    event.preventDefault();
  });
  wc.on("will-attach-webview", (event) => event.preventDefault());
}

/* ============================================================== window */

function layout(): void {
  if (!win || !page) return;
  const [w, h] = win.getContentSize();
  const bh = banner ? 30 : 0;
  banner?.setBounds({ x: 0, y: 0, width: w, height: bh });
  page.setBounds({ x: 0, y: bh, width: w, height: Math.max(0, h - bh) });
}

function saveWindowState(): void {
  if (!win || win.isDestroyed()) return;
  const b = win.getNormalBounds();
  store.update((s) => ({ ...s, window: { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win!.isMaximized(), fullscreen: win!.isFullScreen() } }));
}

function appIcon(): Electron.NativeImage | undefined {
  const p = join(__dirname, "icons", "icon.png");
  return existsSync(p) ? nativeImage.createFromPath(p) : undefined;
}

function createMainWindow(): void {
  const s = store.get().window;
  win = new BaseWindow({
    width: s?.width ?? 1200, height: s?.height ?? 820, ...(s?.x !== undefined ? { x: s.x, y: s.y } : {}),
    minWidth: 380, minHeight: 480, show: false, title: "M5cet", backgroundColor: "#0a0d12",
    autoHideMenuBar: IS_WIN, ...(IS_MAC ? {} : { icon: appIcon() }),
  });
  if (s?.maximized) win.maximize();
  page = new WebContentsView({ webPreferences: pagePreferences() });
  win.contentView.addChildView(page);
  layout();
  guardContents(page.webContents, "page");
  const wc = page.webContents;
  wc.on("page-title-updated", (_e, title) => {
    unread.title = unreadFromTitle(title);
    updateBadge();
    const tgt = current();
    win?.setTitle(tgt?.mode === "server" ? `${title} — ${L("title.serverCode")}` : title);
  });
  wc.on("context-menu", (_e, params) => contextMenu(locale(), params, wc)?.popup());
  wc.on("render-process-gone", (_e, details) => {
    if (details.reason === "clean-exit" || quitting) return;
    void messageBox({ type: "error", message: L("dlg.crash.title"), detail: details.reason, buttons: [L("menu.reload")] }).then(() => wc.reload());
  });
  wc.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3: aborted (a new navigation)
    console.warn(`[m5cet] load failed ${code} ${description} ${url.slice(0, 80)}`);
    showWelcome(`${L("dlg.load.title")} (${description})`);
  });
  wc.once("did-finish-load", () => { if (!startHidden) showMain(); });
  setTimeout(() => { if (win && !win.isVisible() && !startHidden) showMain(); }, 4000);
  win.on("resize", () => { layout(); scheduleSave(); });
  win.on("move", scheduleSave);
  win.on("enter-full-screen", () => { layout(); scheduleSave(); });
  win.on("leave-full-screen", () => { layout(); scheduleSave(); });
  win.on("focus", () => { if (IS_WIN) win?.flashFrame(false); });
  win.on("close", (event) => {
    saveWindowState();
    if (quitting) return;
    if (store.get().closeToTray || IS_MAC) {
      event.preventDefault();
      win?.hide();
      if (IS_WIN && !shownBackgroundNotice && Notification.isSupported()) {
        shownBackgroundNotice = true;
        new Notification({ title: "M5cet", body: L("notify.background"), silent: true }).show();
      }
    }
  });
  win.on("closed", () => { win = null; page = null; banner = null; });
}

let saveTimer: NodeJS.Timeout | null = null;
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveWindowState, 800);
}

function showMain(): void {
  if (!win) {
    const tgt = current();
    if (tgt) { void openServer(tgt.origin); return; }
    showWelcome();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (IS_MAC) app.focus({ steal: true });
}

function setBanner(on: boolean): void {
  if (!win) return;
  if (on && !banner) {
    banner = new WebContentsView({ webPreferences: { preload: join(__dirname, "ui-preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: !app.isPackaged } });
    banner.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    banner.webContents.on("will-navigate", (e) => e.preventDefault());
    void banner.webContents.loadURL(`${APP_SCHEME}://ui/banner.html`);
    win.contentView.addChildView(banner);
  } else if (!on && banner) {
    win.contentView.removeChildView(banner);
    banner.webContents.close();
    banner = null;
  }
  banner?.webContents.send("ui:changed");
  layout();
}

/* ============================================================== badge */

function updateBadge(): void {
  const n = Math.max(unread.title, unread.bridge);
  if (IS_MAC) app.dock?.setBadge(badgeText(n));
  else if (IS_WIN && win && !win.isDestroyed()) {
    win.setOverlayIcon(n > 0 ? nativeImage.createFromBitmap(overlayBitmap(n), { width: 32, height: 32 }) : null, n > 0 ? L("tray.unread", { count: n }) : "");
    if (n > 0 && !win.isFocused()) win.flashFrame(true);
  } else app.setBadgeCount(n);
  if (tray) {
    tray.setToolTip(n > 0 ? `M5cet — ${L("tray.unread", { count: n })}` : "M5cet");
    tray.setContextMenu(trayMenu(menuContext()));
  }
}

/* ============================================================ servers */

async function fetchServerManifest(origin: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await pageSession.fetch(`${origin}/version-manifest.json?ts=${Date.now()}`, {
      bypassCustomProtocolHandlers: true, cache: "no-store", signal: AbortSignal.timeout(8000),
    } as RequestInit & { bypassCustomProtocolHandlers: boolean });
    if (!res.ok) return null;
    return JSON.parse(await res.text()) as Record<string, unknown>;
  } catch { return null; }
}

async function probeServer(origin: string): Promise<boolean> {
  try {
    const res = await pageSession.fetch(`${origin}/api/health`, { bypassCustomProtocolHandlers: true, cache: "no-store", signal: AbortSignal.timeout(8000) } as RequestInit & { bypassCustomProtocolHandlers: boolean });
    if (!res.ok) return false;
    const j = JSON.parse(await res.text()) as { ok?: unknown; status?: unknown };
    return j !== null && typeof j === "object";
  } catch { return false; }
}

function compat(manifest: Record<string, unknown> | null): Compat {
  try { return compareVersions(bundle.versionManifest, manifest); } catch { return { level: "unknown", app: app.getVersion(), server: null }; }
}

/** Asks what to do when the server runs an incompatible version. */
async function askVersion(c: Extract<Compat, { level: "incompatible" }>, display: string): Promise<"update" | "server" | "app" | "cancel"> {
  const r = await messageBox({
    type: "warning", message: L("dlg.version.title"),
    detail: `${L("dlg.version.body", { app: c.app, server: display, serverVersion: c.server })}\n\n${L("dlg.version.detail")}`,
    buttons: [L("btn.update"), L("btn.useServerCode"), L("btn.useAppCode"), L("btn.cancel")], defaultId: 0, cancelId: 3, noLink: true,
  });
  return (["update", "server", "app", "cancel"] as const)[r] ?? "cancel";
}

/** Loads a server in the window: the version check, the code source, the interception, the banner. */
async function openServer(origin: string, opts: { path?: string } = {}): Promise<{ ok: boolean; error?: string }> {
  const entry = serverEntry(store.get(), origin);
  if (!entry) return { ok: false, error: L("err.invalid") };
  let source: CodeSource = entry.codeSource;
  if (source === "app") {
    const c = compat(await fetchServerManifest(origin));
    if (c.level === "incompatible") {
      const choice = await askVersion(c, entry.display);
      if (choice === "cancel") return { ok: false, error: "" };
      if (choice === "update") { void updater.checkInteractive(); return { ok: false, error: "" }; }
      if (choice === "server") { store.set(setCodeSource(store.get(), origin, "server")); source = "server"; }
    } else if (c.level !== "same") {
      console.log(`[m5cet] ${origin}: ${c.level} (app ${c.app}, server ${c.server ?? "?"})`);
    }
  }
  const prev = current();
  if (prev && page) await page.webContents.loadURL("about:blank").catch(() => undefined);
  // Whatever an earlier visit left in the browser layer must not answer for the app's code:
  // a service worker (a server's could serve its own pages) and the HTTP cache.
  if (source === "app") {
    await pageSession.clearStorageData({ origin, storages: ["serviceworkers", "cachestorage"] }).catch(() => undefined);
    await pageSession.clearCache().catch(() => undefined);
  }
  interceptor.setTarget({ origin, mode: source === "app" ? "bundled" : "server" });
  store.update((s) => ({ ...s, current: origin, servers: s.servers.map((x) => (x.origin === origin ? { ...x, lastUsedAt: Date.now() } : x)) }));
  if (!win) createMainWindow();
  setBanner(source === "server");
  refreshMenus();
  const path = opts.path && opts.path.startsWith("/") ? opts.path : "/";
  void page!.webContents.loadURL(`${origin}${path}`).catch(() => undefined);
  if (welcome && !welcome.isDestroyed()) welcome.close();
  if (!startHidden) showMain();
  return { ok: true };
}

async function switchCodeSource(source: CodeSource): Promise<void> {
  const tgt = current();
  if (!tgt) return;
  store.set(setCodeSource(store.get(), tgt.origin, source));
  if (source === "app") await pageSession.clearStorageData({ origin: tgt.origin, storages: ["serviceworkers", "cachestorage"] }).catch(() => undefined);
  await openServer(tgt.origin);
}

/* =========================================================== app pages */

const UI_FILES: Record<string, string> = {
  "/welcome.html": "text/html; charset=utf-8",
  "/banner.html": "text/html; charset=utf-8",
  "/ui.css": "text/css; charset=utf-8",
  "/welcome.js": "text/javascript; charset=utf-8",
  "/banner.js": "text/javascript; charset=utf-8",
  "/icon.svg": "image/svg+xml",
};
const UI_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function setupAppScheme(): void {
  protocol.handle(APP_SCHEME, async (req) => {
    const url = new URL(req.url);
    const type = UI_FILES[url.pathname];
    if (url.host !== "ui" || !type) return new Response("Not found", { status: 404 });
    try {
      const body = await readFile(join(__dirname, "ui", url.pathname.slice(1)));
      return new Response(new Uint8Array(body), { headers: { "Content-Type": type, "Content-Security-Policy": UI_CSP, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" } });
    } catch { return new Response("Not found", { status: 404 }); }
  });
  // The app's own pages ask for nothing.
  session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}

function showWelcome(error = ""): void {
  welcomeError = error;
  if (welcome && !welcome.isDestroyed()) {
    welcome.webContents.send("ui:changed");
    welcome.show();
    welcome.focus();
    return;
  }
  welcome = new BrowserWindow({
    width: 520, height: 620, resizable: false, maximizable: false, fullscreenable: false, show: false,
    title: "M5cet", backgroundColor: "#0a0d12", autoHideMenuBar: true, ...(IS_MAC ? {} : { icon: appIcon() }),
    webPreferences: { preload: join(__dirname, "ui-preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, devTools: !app.isPackaged },
  });
  welcome.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  welcome.webContents.on("will-navigate", (e) => e.preventDefault());
  welcome.once("ready-to-show", () => welcome?.show());
  welcome.on("closed", () => {
    welcome = null;
    if (!win && !quitting && !IS_MAC) app.quit();
  });
  void welcome.loadURL(`${APP_SCHEME}://ui/welcome.html`);
}

const ERROR_KEY: Record<ServerUrlError, StringKey> = {
  empty: "err.invalid", invalid: "err.invalid", host: "err.invalid", port: "err.invalid", "too-long": "err.invalid",
  scheme: "err.scheme", insecure: "err.scheme", credentials: "err.credentials",
};

function isUiSender(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return (welcome !== null && !welcome.isDestroyed() && e.sender === welcome.webContents) || (banner !== null && e.sender === banner.webContents);
}

function setupUiIpc(): void {
  ipcMain.handle("ui:state", (e) => {
    if (!isUiSender(e)) return null;
    const loc = locale();
    const strings: Record<string, string> = {};
    for (const key of Object.keys(STRINGS) as StringKey[]) {
      if (/^(welcome|btn|err|banner|title)\./.test(key)) strings[key] = t(loc, key);
    }
    const s = store.get();
    const tgt = current();
    return {
      strings, lang: loc, version: app.getVersion(), error: welcomeError, signed: BUILD.signed,
      defaultServer: BUILD.defaultServer,
      servers: s.servers.map((x) => ({ origin: x.origin, display: x.display, codeSource: x.codeSource, current: x.origin === s.current })),
      banner: tgt && tgt.mode === "server" ? { server: currentDisplay() } : null,
    };
  });
  ipcMain.handle("ui:connect", async (e, input: unknown) => {
    if (!isUiSender(e)) return { ok: false };
    const parsed = parseServerUrl(String(input ?? ""), { allowLoopbackHttp: ALLOW_LOOPBACK });
    if (!parsed.ok) return { ok: false, error: L(ERROR_KEY[parsed.error]) };
    if (!(await probeServer(parsed.value.origin))) return { ok: false, error: L("err.unreachable") };
    const added = addServer(store.get(), parsed.value.origin, Date.now(), { allowLoopbackHttp: ALLOW_LOOPBACK });
    if (!added.ok) return { ok: false, error: L("err.invalid") };
    store.set(added.settings);
    welcomeError = "";
    // An invite link pasted as the address opens the invitation.
    return openServer(parsed.value.origin, { path: parsed.value.rest || "/" });
  });
  ipcMain.handle("ui:open", async (e, origin: unknown) => {
    if (!isUiSender(e) || typeof origin !== "string" || !serverEntry(store.get(), origin)) return { ok: false };
    welcomeError = "";
    return openServer(origin);
  });
  ipcMain.handle("ui:remove", (e, origin: unknown) => {
    if (!isUiSender(e) || typeof origin !== "string") return;
    store.set(removeServer(store.get(), origin));
    refreshMenus();
  });
  ipcMain.handle("ui:code-app", async (e) => {
    if (!isUiSender(e)) return;
    await switchCodeSource("app");
  });
}

/* ========================================================= page bridge */

function isPageSender(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const tgt = current();
  if (!tgt || !page || e.sender !== page.webContents) return false;
  const frame = e.senderFrame;
  if (!frame || frame !== page.webContents.mainFrame) return false;
  try { return new URL(frame.url).origin === tgt.origin; } catch { return false; }
}

function setupPageIpc(): void {
  ipcMain.on("m5:info", (e) => {
    const tgt = current();
    e.returnValue = page && e.sender === page.webContents
      ? { version: app.getVersion(), platform: process.platform, codeSource: tgt?.mode === "server" ? "server" : "app" }
      : null;
  });
  ipcMain.on("m5:notify", (e, n: { id?: unknown; title?: unknown; body?: unknown; tag?: unknown; silent?: unknown }) => {
    if (!isPageSender(e) || !Notification.isSupported()) return;
    const id = String(n?.id ?? "").slice(0, 64);
    if (!id) return;
    const tag = String(n?.tag ?? "");
    if (tag) for (const [k, old] of notes) if ((old as Notification & { m5tag?: string }).m5tag === tag) { old.close(); notes.delete(k); }
    const note = new Notification({ title: String(n?.title ?? "M5cet").slice(0, 200), body: String(n?.body ?? "").slice(0, 500), silent: n?.silent === true, ...(IS_MAC ? {} : { icon: appIcon() }) });
    (note as Notification & { m5tag?: string }).m5tag = tag;
    note.on("click", () => { showMain(); page?.webContents.send("m5:notification-click", id); });
    note.on("close", () => notes.delete(id));
    notes.set(id, note);
    if (notes.size > 50) { const first = notes.keys().next().value as string; notes.get(first)?.close(); notes.delete(first); }
    note.show();
  });
  ipcMain.on("m5:notify-close", (e, id: unknown) => {
    if (!isPageSender(e)) return;
    const note = notes.get(String(id));
    note?.close();
    notes.delete(String(id));
  });
  ipcMain.on("m5:badge", (e, count: unknown) => {
    if (!isPageSender(e)) return;
    const n = Number(count);
    unread.bridge = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 999_999) : 0;
    updateBadge();
  });
  ipcMain.on("m5:lang", (e, lang: unknown) => {
    if (!isPageSender(e)) return;
    const code = String(lang ?? "").toLowerCase().split(/[-_]/)[0];
    if (!isLocale(code) || store.get().locale === code) return;
    store.update((s) => ({ ...s, locale: code }));
    refreshMenus();
    applySpellcheck();
  });
  ipcMain.handle("m5:open-external", async (e, url: unknown) => {
    if (!isPageSender(e) || typeof url !== "string") return false;
    const d = decideNavigation(url, current()!.origin);
    if (d !== "external") return false;
    await confirmExternal(url);
    return true;
  });
  ipcMain.handle("m5:auth-mode", (e) => (isPageSender(e) ? effectivePasskeyMode(store.get().passkeys, process.platform) : "app"));
  ipcMain.handle("m5:auth-offer-browser", async (e) => {
    if (!isPageSender(e)) return false;
    const r = await messageBox({ type: "question", message: L("dlg.prf.title"), detail: L("dlg.prf.body"), buttons: [L("btn.useBrowser"), L("btn.cancel")], defaultId: 0, cancelId: 1 });
    return r === 0;
  });
  ipcMain.handle("m5:auth-begin", async (e, url: unknown, code: unknown) => {
    if (!isPageSender(e) || typeof url !== "string") return "cancel";
    const tgt = current()!;
    let u: URL;
    try { u = new URL(url); } catch { return "cancel"; }
    // Only this server's own sign-in page for the app — nothing else is opened this way.
    if (u.origin !== tgt.origin || u.pathname !== "/desktop-signin" || !/^[A-Za-z0-9_-]{22,64}$/.test(u.searchParams.get("id") ?? "")) return "cancel";
    const shownCode = String(code ?? "").replace(/[^0-9 ]/g, "").slice(0, 12);
    authBox?.abort();
    const ctrl = new AbortController();
    authBox = ctrl;
    await shell.openExternal(u.toString());
    for (;;) {
      const parent = win && win.isVisible() ? win : undefined;
      const opts: Electron.MessageBoxOptions = {
        type: "info", message: L("dlg.signin.title"),
        detail: `${L("dlg.signin.body", { server: currentDisplay(), code: shownCode })}\n\n${L("dlg.signin.detail")}`,
        buttons: [L("btn.cancel"), L("btn.openAgain")], defaultId: 0, cancelId: 0, signal: ctrl.signal, noLink: true,
      };
      const r = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
      if (ctrl.signal.aborted) return "done";
      if (r.response === 1) { await shell.openExternal(u.toString()); continue; }
      if (authBox === ctrl) authBox = null;
      return "cancel";
    }
  });
  ipcMain.on("m5:auth-end", (e) => {
    if (!isPageSender(e)) return;
    authBox?.abort();
    authBox = null;
  });
}

/* ========================================================= menus, tray */

function menuContext(): MenuContext {
  const s = store.get();
  const tgt = current();
  return {
    locale: locale(), platform: process.platform, isPackaged: app.isPackaged,
    server: tgt?.origin ?? null, codeSource: tgt?.mode === "server" ? "server" : "app",
    passkeys: s.passkeys, startAtLogin: s.startAtLogin, closeToTray: s.closeToTray, unread: Math.max(unread.title, unread.bridge),
    actions: {
      about: () => {
        if (IS_MAC) { app.showAboutPanel(); return; }
        void messageBox({ type: "info", message: `M5cet Desktop ${app.getVersion()}`, detail: `build ${BUILD.build}${BUILD.signed ? "" : " · unsigned"}\nElectron ${process.versions.electron} · Chromium ${process.versions.chrome}`, buttons: [L("btn.ok")] });
      },
      checkUpdates: () => void updater.checkInteractive(),
      switchServer: () => showWelcome(),
      openInBrowser: () => { const o = current()?.origin; if (o) void shell.openExternal(o); },
      setCodeSource: (source) => void switchCodeSource(source),
      setPasskeys: (mode: PasskeyMode) => { store.update((x) => ({ ...x, passkeys: mode })); refreshMenus(); },
      setStartAtLogin: (on) => { setLoginItem(on); store.update((x) => ({ ...x, startAtLogin: on })); refreshMenus(); },
      setCloseToTray: (on) => { store.update((x) => ({ ...x, closeToTray: on })); refreshMenus(); },
      reload: () => { const tgt2 = current(); if (tgt2) void openServer(tgt2.origin); },
      show: () => showMain(),
      quit: () => { quitting = true; app.quit(); },
    },
  };
}

function refreshMenus(): void {
  const c = menuContext();
  Menu.setApplicationMenu(applicationMenu(c));
  if (tray) tray.setContextMenu(trayMenu(c));
  welcome?.webContents.send("ui:changed");
  banner?.webContents.send("ui:changed");
}

function createTray(): void {
  const file = IS_MAC ? "trayTemplate.png" : "tray.png";
  const p = join(__dirname, "icons", file);
  if (!existsSync(p)) return;
  const image = nativeImage.createFromPath(p);
  if (IS_MAC) image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip("M5cet");
  tray.setContextMenu(trayMenu(menuContext()));
  if (!IS_MAC) tray.on("click", () => showMain());
}

function setLoginItem(on: boolean): void {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: on, ...(IS_WIN ? { args: ["--hidden"] } : {}) });
}

function applySpellcheck(): void {
  if (IS_MAC) return; // the macOS system checker follows the system's languages
  try { pageSession.setSpellCheckerLanguages(spellcheckLanguages(locale(), pageSession.availableSpellCheckerLanguages)); } catch { /* none available */ }
}

/* ============================================================== startup */

const startHidden = process.argv.includes("--hidden") || (IS_MAC && app.getLoginItemSettings().wasOpenedAtLogin === true);

async function selfTest(): Promise<void> {
  // A smoke test of a built app (desktop/scripts/smoke.mjs): fixed checks, a report, then exit.
  if (!SMOKE_REPORT) return;
  const report: Record<string, unknown> = {
    version: app.getVersion(), packaged: app.isPackaged, electron: process.versions.electron, arch: process.arch,
    // Every served client file checked against the app.asar header (packaged builds).
    integrityChecked: Boolean(bundle.hashes),
  };
  try {
    const parsed = parseServerUrl(SMOKE_SERVER, { allowLoopbackHttp: ALLOW_LOOPBACK });
    if (!parsed.ok) throw new Error(`server: ${parsed.error}`);
    const added = addServer(store.get(), parsed.value.origin, Date.now(), { allowLoopbackHttp: ALLOW_LOOPBACK });
    if (!added.ok) throw new Error("add");
    store.set(added.settings);
    report.open = await openServer(parsed.value.origin);
    await new Promise<void>((resolve) => { page?.webContents.once("did-finish-load", () => resolve()); setTimeout(resolve, 20_000); });
    await new Promise((r) => setTimeout(r, 6000));
    report.title = page?.webContents.getTitle();
    report.url = page?.webContents.getURL();
    report.page = await page?.webContents.executeJavaScript(`(async () => ({
      root: document.getElementById("root")?.childElementCount ?? 0,
      bridge: typeof window.m5desktop === "object" && window.m5desktop.isDesktop === true,
      bridgeKeys: Object.keys(window.m5desktop || {}).sort(),
      node: typeof require !== "undefined" || typeof process !== "undefined",
      notification: Boolean(window.Notification && window.Notification.m5desktop === true),
      sw: await Promise.race([
        navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready).then((reg) => new Promise((done) => {
          const ch = new MessageChannel();
          ch.port1.onmessage = (e) => done(e.data && e.data.build);
          reg.active.postMessage({ type: "version" }, [ch.port2]);
          setTimeout(() => done(null), 4000);
        })).catch((e) => "error: " + e.message),
        new Promise((done) => setTimeout(() => done("timeout"), 8000)),
      ]),
      csp: await fetch("/").then((r) => r.headers.get("content-security-policy")),
      handoff: await fetch("/api/desktop-auth/start", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => r.status, () => 0),
      manifest: await fetch("/version-manifest.json").then((r) => r.json()).then((m) => m.build, () => null),
      health: await fetch("/api/health").then((r) => r.status, () => 0),
      foreignAsset: await fetch("/assets/not-in-the-bundle.js").then((r) => r.status, () => 0),
    }))()`, true);
    report.stats = { ...interceptor.stats };
    report.refused = interceptor.refused.slice(-10);
    report.ok = true;
  } catch (err) {
    report.ok = false;
    report.error = String((err as Error)?.message ?? err);
  }
  writeFileSync(SMOKE_REPORT, JSON.stringify(report, null, 2));
  quitting = true;
  app.exit(0);
}

app.whenReady().then(async () => {
  store = new SettingsStore({ allowLoopbackHttp: ALLOW_LOOPBACK });
  pageSession = session.fromPartition(PAGE_PARTITION);
  try {
    bundle = await loadBundle(join(__dirname, "..", "web"), app.isPackaged ? app.getAppPath() : "");
  } catch (err) {
    // The app's own client does not match its signed archive: refuse to run rather than serve it.
    if (SMOKE_REPORT) writeFileSync(SMOKE_REPORT, JSON.stringify({ ok: false, integrity: false, error: String((err as Error).message) }));
    if (!SMOKE_REPORT) dialog.showErrorBox("M5cet", `The app is damaged and will not start: ${(err as Error).message}. Reinstall it from a trusted source.`);
    app.exit(3);
    return;
  }
  interceptor = new Interceptor(pageSession, bundle, headersFor);
  interceptor.install();
  setupPageSession(pageSession);
  setupAppScheme();
  setupUiIpc();
  setupPageIpc();
  updater = new Updater({
    locale, window: () => win,
    onEvent: (ev) => {
      if (ev.kind === "error") console.warn("[m5cet] update:", ev.message);
      // The page hears only the kind and the version (never the error text or the feed).
      page?.webContents.send("m5:update", { kind: ev.kind, ...("version" in ev ? { version: ev.version } : {}) });
    },
  });
  app.setAboutPanelOptions({ applicationName: "M5cet", applicationVersion: app.getVersion(), version: `${BUILD.build}${BUILD.signed ? "" : " · unsigned"}`, copyright: "M5cet · MIT" });
  if (app.isPackaged) app.setAsDefaultProtocolClient("m5cet");
  applySpellcheck();
  refreshMenus();
  createTray();
  updater.start(store.get().autoUpdate);
  ready = true;

  if (SMOKE_REPORT) { await selfTest(); return; }

  const argLink = deepLinkFromArgv(process.argv);
  if (argLink) pendingLinks.push(argLink);
  const s = store.get();
  if (pendingLinks.length) {
    for (const link of pendingLinks.splice(0)) await handleDeepLink(link);
    if (!current()) showWelcome();
  } else if (s.current) {
    const r = await openServer(s.current);
    if (!r.ok) showWelcome(r.error ?? "");
  } else {
    showWelcome();
  }
});

app.on("activate", () => showMain());
app.on("before-quit", () => { quitting = true; saveWindowState(); store?.flush(); });
app.on("window-all-closed", () => {
  // macOS keeps the app in the dock; elsewhere the tray keeps it unless the user turned that off.
  if (!IS_MAC && !(store?.get().closeToTray && tray)) app.quit();
});

// Every WebContents: no <webview>, no windows unless a handler above allows them.
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (e) => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
});
app.on("certificate-error", (event, _wc, _url, _error, _cert, callback) => {
  event.preventDefault();
  callback(false);
});
