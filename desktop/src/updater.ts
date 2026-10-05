// Updates (electron-updater) — only for a signed, packaged build that knows
// where its updates come from (electron-builder's `publish`: GitHub Releases
// or a generic https feed, written to app-update.yml at build time).
//
// electron-updater checks the SHA-512 of the download against the feed's
// latest*.yml and, before installing: on Windows the Authenticode signature of
// the new installer must name the same publisher as the running app; on macOS
// Squirrel.Mac requires the new app to carry a valid signature of the same
// team (the designated requirement). An unsigned build never updates itself.

import { app, dialog, type BaseWindow } from "electron";
import { autoUpdater } from "electron-updater";
import { BUILD } from "./config";
import { t } from "./i18n";
import type { Locale } from "../../client/src/lib/locales";

export type UpdateEvent =
  | { kind: "checking" }
  | { kind: "available"; version: string }
  | { kind: "none"; version: string }
  | { kind: "downloaded"; version: string }
  | { kind: "error"; message: string }
  | { kind: "off" };

export function updatesEnabled(): boolean {
  return app.isPackaged && BUILD.updates && BUILD.signed;
}

export class Updater {
  private started = false;
  private timer: NodeJS.Timeout | null = null;
  private downloaded: string | null = null;

  constructor(private readonly env: { locale: () => Locale; window: () => BaseWindow | null; onEvent: (e: UpdateEvent) => void }) {}

  start(auto: boolean): void {
    if (!updatesEnabled() || this.started) return;
    this.started = true;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.on("checking-for-update", () => this.env.onEvent({ kind: "checking" }));
    autoUpdater.on("update-available", (i) => this.env.onEvent({ kind: "available", version: i.version }));
    autoUpdater.on("update-not-available", (i) => this.env.onEvent({ kind: "none", version: i.version }));
    autoUpdater.on("error", (err) => this.env.onEvent({ kind: "error", message: String(err?.message ?? err).slice(0, 300) }));
    autoUpdater.on("update-downloaded", (i) => {
      this.downloaded = i.version;
      this.env.onEvent({ kind: "downloaded", version: i.version });
      void this.offerRestart(i.version);
    });
    if (auto) {
      setTimeout(() => void autoUpdater.checkForUpdates().catch(() => undefined), 15_000);
      this.timer = setInterval(() => void autoUpdater.checkForUpdates().catch(() => undefined), 6 * 60 * 60 * 1000);
      this.timer.unref();
    }
  }

  private async offerRestart(version: string): Promise<void> {
    const loc = this.env.locale();
    const win = this.env.window();
    const opts = {
      type: "info" as const,
      title: t(loc, "dlg.update.readyTitle"),
      message: t(loc, "dlg.update.readyTitle"),
      detail: t(loc, "dlg.update.ready", { version }),
      buttons: [t(loc, "btn.restart"), t(loc, "btn.later")],
      defaultId: 0,
      cancelId: 1,
    };
    const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    if (r.response === 0) setImmediate(() => autoUpdater.quitAndInstall());
  }

  /** "Check for Updates…" — with a dialog for every outcome. */
  async checkInteractive(): Promise<void> {
    const loc = this.env.locale();
    const win = this.env.window();
    const show = (message: string, type: "info" | "error" = "info") => {
      const o = { type, message, buttons: [t(loc, "btn.ok")] };
      return win ? dialog.showMessageBox(win, o) : dialog.showMessageBox(o);
    };
    if (!updatesEnabled()) { await show(t(loc, "dlg.update.off")); return; }
    if (this.downloaded) { await this.offerRestart(this.downloaded); return; }
    this.start(false);
    try {
      const r = await autoUpdater.checkForUpdates();
      const latest = r?.updateInfo?.version;
      if (!r || !latest || latest === app.getVersion()) await show(t(loc, "dlg.update.none", { version: app.getVersion() }));
      // An available update downloads in the background; "update-downloaded" asks to restart.
    } catch {
      await show(t(loc, "dlg.update.error"), "error");
    }
  }
}
