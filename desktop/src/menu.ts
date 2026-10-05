// The native menus: the application menu (menu bar on macOS, the window's
// menu on Windows — hidden until Alt), the tray / menu-bar icon's menu and
// the page's context menu (spelling suggestions, clipboard). All localized.

import { Menu, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from "electron";
import { t } from "./i18n";
import type { Locale } from "../../client/src/lib/locales";
import type { CodeSource, PasskeyMode } from "./settings";

export type MenuContext = {
  locale: Locale;
  platform: NodeJS.Platform;
  isPackaged: boolean;
  server: string | null;
  codeSource: CodeSource;
  passkeys: PasskeyMode;
  startAtLogin: boolean;
  closeToTray: boolean;
  unread: number;
  actions: {
    about(): void;
    checkUpdates(): void;
    switchServer(): void;
    openInBrowser(): void;
    setCodeSource(source: CodeSource): void;
    setPasskeys(mode: PasskeyMode): void;
    setStartAtLogin(on: boolean): void;
    setCloseToTray(on: boolean): void;
    reload(): void;
    show(): void;
    quit(): void;
  };
};

export function applicationMenu(c: MenuContext): Menu {
  const L = (k: Parameters<typeof t>[1]) => t(c.locale, k);
  const mac = c.platform === "darwin";
  const serverMenu: MenuItemConstructorOptions = {
    label: L("menu.server"),
    submenu: [
      { label: L("menu.switchServer"), accelerator: "CmdOrCtrl+Shift+S", click: () => c.actions.switchServer() },
      { label: L("menu.openInBrowser"), enabled: Boolean(c.server), click: () => c.actions.openInBrowser() },
      { type: "separator" },
      {
        label: L("menu.codeSource"),
        enabled: Boolean(c.server),
        submenu: [
          { label: L("menu.codeApp"), type: "radio", checked: c.codeSource === "app", click: () => c.actions.setCodeSource("app") },
          { label: L("menu.codeServer"), type: "radio", checked: c.codeSource === "server", click: () => c.actions.setCodeSource("server") },
        ],
      },
      {
        label: L("menu.passkeys"),
        submenu: [
          { label: L("menu.passkeysAuto"), type: "radio", checked: c.passkeys === "auto", click: () => c.actions.setPasskeys("auto") },
          { label: L("menu.passkeysApp"), type: "radio", checked: c.passkeys === "app", click: () => c.actions.setPasskeys("app") },
          { label: L("menu.passkeysBrowser"), type: "radio", checked: c.passkeys === "browser", click: () => c.actions.setPasskeys("browser") },
        ],
      },
      { type: "separator" },
      { label: L("menu.startAtLogin"), type: "checkbox", checked: c.startAtLogin, click: (item) => c.actions.setStartAtLogin(item.checked) },
      { label: L("menu.closeToTray"), type: "checkbox", checked: c.closeToTray, click: (item) => c.actions.setCloseToTray(item.checked) },
    ],
  };
  const template: MenuItemConstructorOptions[] = [];
  if (mac) {
    template.push({
      label: "M5cet",
      submenu: [
        { label: L("menu.about"), click: () => c.actions.about() },
        { label: L("menu.checkUpdates"), click: () => c.actions.checkUpdates() },
        { type: "separator" },
        { role: "services", label: L("menu.services") },
        { type: "separator" },
        { role: "hide", label: L("menu.hide") },
        { role: "hideOthers", label: L("menu.hideOthers") },
        { role: "unhide", label: L("menu.showAll") },
        { type: "separator" },
        { label: L("menu.quit"), accelerator: "Cmd+Q", click: () => c.actions.quit() },
      ],
    });
  } else {
    template.push({
      label: L("menu.file"),
      submenu: [
        { label: L("menu.switchServer"), click: () => c.actions.switchServer() },
        { type: "separator" },
        { label: L("menu.quit"), accelerator: "Ctrl+Q", click: () => c.actions.quit() },
      ],
    });
  }
  template.push({
    label: L("menu.edit"),
    submenu: [
      { role: "undo", label: L("menu.undo") },
      { role: "redo", label: L("menu.redo") },
      { type: "separator" },
      { role: "cut", label: L("menu.cut") },
      { role: "copy", label: L("menu.copy") },
      { role: "paste", label: L("menu.paste") },
      { role: "selectAll", label: L("menu.selectAll") },
    ],
  });
  template.push({
    label: L("menu.view"),
    submenu: [
      { label: L("menu.reload"), accelerator: "CmdOrCtrl+R", click: () => c.actions.reload() },
      { type: "separator" },
      { role: "resetZoom", label: L("menu.resetZoom") },
      { role: "zoomIn", label: L("menu.zoomIn") },
      { role: "zoomOut", label: L("menu.zoomOut") },
      { type: "separator" },
      { role: "togglefullscreen", label: L("menu.fullscreen") },
      ...(c.isPackaged ? [] : [{ type: "separator" as const }, { role: "toggleDevTools" as const }]),
    ],
  });
  template.push(serverMenu);
  template.push({
    label: L("menu.window"),
    role: "windowMenu",
    submenu: [
      { role: "minimize", label: L("menu.minimize") },
      { role: "close", label: L("menu.close") },
    ],
  });
  if (!mac) {
    template.push({
      label: L("menu.help"),
      submenu: [
        { label: L("menu.checkUpdates"), click: () => c.actions.checkUpdates() },
        { label: L("menu.about"), click: () => c.actions.about() },
      ],
    });
  }
  return Menu.buildFromTemplate(template);
}

export function trayMenu(c: MenuContext): Menu {
  const L = (k: Parameters<typeof t>[1], v?: Record<string, string | number>) => t(c.locale, k, v);
  const items: MenuItemConstructorOptions[] = [
    { label: L("menu.show"), click: () => c.actions.show() },
  ];
  if (c.unread > 0) items.push({ label: L("tray.unread", { count: c.unread }), enabled: false });
  items.push(
    { type: "separator" },
    { label: L("menu.switchServer"), click: () => c.actions.switchServer() },
    { label: L("menu.checkUpdates"), click: () => c.actions.checkUpdates() },
    { label: L("menu.startAtLogin"), type: "checkbox", checked: c.startAtLogin, click: (item) => c.actions.setStartAtLogin(item.checked) },
    { type: "separator" },
    { label: L("menu.quit"), click: () => c.actions.quit() },
  );
  return Menu.buildFromTemplate(items);
}

/** Spelling suggestions and the clipboard for editable fields and selections; nothing elsewhere. */
export function contextMenu(locale: Locale, params: ContextMenuParams, wc: WebContents): Menu | null {
  const L = (k: Parameters<typeof t>[1]) => t(locale, k);
  const items: MenuItemConstructorOptions[] = [];
  if (params.misspelledWord) {
    for (const s of params.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
    items.push({ label: L("ctx.addToDictionary"), click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
    items.push({ type: "separator" });
  }
  if (params.isEditable) {
    items.push(
      { role: "cut", label: L("menu.cut"), enabled: params.editFlags.canCut },
      { role: "copy", label: L("menu.copy"), enabled: params.editFlags.canCopy },
      { role: "paste", label: L("menu.paste"), enabled: params.editFlags.canPaste },
      { type: "separator" },
      { role: "selectAll", label: L("menu.selectAll"), enabled: params.editFlags.canSelectAll },
    );
  } else if (params.selectionText.trim()) {
    items.push({ role: "copy", label: L("menu.copy") });
  }
  return items.length ? Menu.buildFromTemplate(items) : null;
}
