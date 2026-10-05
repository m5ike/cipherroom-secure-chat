// Renders the app's icons from client/public/icon-512.svg with Electron's
// own Chromium (offscreen, transparent) — run by scripts/icons.mjs:
//
//   build/icon.png             1024 × 1024, full bleed (Windows / Linux; electron-builder makes the .ico)
//   build/icon-mac.png         1024 × 1024, the macOS grid (824 px tile, transparent margin; → .icns)
//   build/icons/icon.png       512 × 512 (the window icon at run time)
//   build/icons/tray.png       16 × 16 and tray@2x.png 32 × 32 (Windows tray, colour)
//   build/icons/trayTemplate.png  16 × 16 and @2x (macOS menu bar, black template)

const { app, BrowserWindow } = require("electron");
const { mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.disableHardwareAcceleration();
// Each render closes its window; the script quits itself when done.
app.on("window-all-closed", () => {});

const desktop = resolve(__dirname, "..");
const svg = readFileSync(resolve(desktop, "../client/public/icon-512.svg"), "utf8");
// The menu-bar glyph: the hexagon and the "M", black on transparent (macOS tints a template image).
const glyph = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <path d="M32 4 L58 17.5 L58 46.5 L32 60 L6 46.5 L6 17.5 Z" fill="none" stroke="#000" stroke-width="5" stroke-linejoin="round"/>
  <path d="M15 42 L23.5 20 L32 42 L40.5 20 L49 42" fill="none" stroke="#000" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

async function render(source, size, inner = size) {
  const win = new BrowserWindow({ width: size, height: size, show: false, frame: false, transparent: true, backgroundColor: "#00000000", webPreferences: { offscreen: true, sandbox: true, contextIsolation: true } });
  const pad = Math.round((size - inner) / 2);
  const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">
    <img src="data:image/svg+xml;base64,${Buffer.from(source).toString("base64")}" style="position:absolute;left:${pad}px;top:${pad}px;width:${inner}px;height:${inner}px"></body></html>`;
  const file = join(tmpdir(), `m5cet-icon-${process.pid}-${size}-${inner}-${Math.random().toString(36).slice(2)}.html`);
  writeFileSync(file, html);
  await win.loadFile(file);
  await win.webContents.executeJavaScript("Promise.all([...document.images].map((i) => i.decode()))");
  await new Promise((r) => setTimeout(r, 150));
  rmSync(file, { force: true });
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  win.destroy();
  return image.resize({ width: size, height: size, quality: "best" }).toPNG();
}

app.whenReady().then(async () => {
  const build = join(desktop, "build");
  mkdirSync(join(build, "icons"), { recursive: true });
  writeFileSync(join(build, "icon.png"), await render(svg, 1024));
  writeFileSync(join(build, "icon-mac.png"), await render(svg, 1024, 824));
  writeFileSync(join(build, "icons", "icon.png"), await render(svg, 512));
  writeFileSync(join(build, "icons", "tray.png"), await render(svg, 16));
  writeFileSync(join(build, "icons", "tray@2x.png"), await render(svg, 32));
  writeFileSync(join(build, "icons", "trayTemplate.png"), await render(glyph, 16, 16));
  writeFileSync(join(build, "icons", "trayTemplate@2x.png"), await render(glyph, 32, 32));
  console.log("icons rendered");
  app.quit();
}).catch((err) => { console.error(err); app.exit(1); });
