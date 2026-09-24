// Every layout the Layout builder offers: its id, its default tree (the app
// as it always was) and the default's revision — so the builder can tell an
// operator that the app's own layout changed since they customised theirs.

import { sanitizeTree, treeRev, type LNode } from "../layout-tree";
import { messageTree } from "./message";
import { widgetFabTree, widgetTree } from "./widget";
import { chatTree, composerTree, headerTree } from "./app";
import { largeWindowTree, windowTree } from "./windows";
import { roomTabsTree, roomTree } from "./room";
import { integrityTree, messageInfoTree, needSignInTree, signedInTree, userInfoTree } from "./dialogs";

import { accessTree, accountInfoTree, retentionTree } from "./account";
import { analyticsTree, encryptionTree, notificationsTree, privacyTree, profileTree, roomSecurityTree, settingsTree, trustTree } from "./settings";
import { audioTree, connectionTree, filesTree, locationTree, peersTree, speechTree, videoTree } from "./tools";
import { inviteTree, shareConnectionTree, shareResultTree, shareTree } from "./share";
import { phoneTree } from "./phone";
import { connectionDetailTree, connectionEditTree, connectionSettingsTree, connectionsTree } from "./connections";
import { aiTree } from "./ai";
export const LAYOUT_IDS = [
  "header", "chat", "message.in", "message.out", "message.sys", "composer", "widget", "widget.fab",
  // 4.13: the windows, the Room window, dialogs and panels
  "window", "window.large", "room.tabs", "room",
  "part.needSignIn", "part.signedIn", "dialog.userInfo", "dialog.messageInfo", "dialog.integrity",
  "dialog.account", "panel.access", "panel.retention",
  "panel.profile", "panel.settings", "panel.privacy", "panel.encryption", "panel.notifications", "panel.analytics", "panel.roomSecurity", "panel.trust",
  "part.peers", "part.audio", "part.video", "panel.files", "panel.location", "panel.speech", "panel.connection",
  "part.shareResult", "panel.share", "panel.shareConnection", "part.invite",
  "panel.phone",
  "panel.connections", "part.connectionEdit", "part.connectionDetail", "part.connectionSettings",
  "panel.ai",
] as const;
export type LayoutId = (typeof LAYOUT_IDS)[number];

export const LAYOUT_LABELS: Readonly<Record<LayoutId, string>> = {
  header: "App bar",
  chat: "Chat window",
  "message.in": "Incoming message",
  "message.out": "Outgoing message",
  "message.sys": "System message",
  composer: "Composer (send panel)",
  widget: "Recipients widget",
  "widget.fab": "Recipients button (minimised)",
  window: "Window (panels, dialogs)",
  "window.large": "Large window (settings)",
  "room.tabs": "Room window — tabs",
  room: "Room window",
  "part.needSignIn": "“Sign in first”",
  "part.signedIn": "Signed-in badge",
  "dialog.userInfo": "A person's details",
  "dialog.messageInfo": "A message's details",
  "dialog.integrity": "Version check",
  "dialog.account": "Account window",
  "panel.access": "Passkey (Connection window)",
  "panel.retention": "Chat data and history",
  "panel.profile": "Profile",
  "panel.settings": "Settings",
  "panel.privacy": "Privacy",
  "panel.encryption": "Encryption",
  "panel.notifications": "Notifications",
  "panel.analytics": "Analytics",
  "panel.roomSecurity": "Room security",
  "panel.trust": "Trust (fingerprints)",
  "part.peers": "People in the room",
  "part.audio": "Voice call",
  "part.video": "Video call",
  "panel.files": "Files",
  "panel.location": "Location",
  "panel.speech": "Speech",
  "panel.connection": "Connection details",
  "part.shareResult": "A created invite",
  "panel.share": "Share this room",
  "panel.shareConnection": "Share a connection",
  "part.invite": "Join by invite",
  "panel.phone": "Telephony",
  "panel.connections": "My connections",
  "part.connectionEdit": "My connections \u2014 the editor",
  "part.connectionDetail": "My connections \u2014 statistics and log",
  "part.connectionSettings": "My connections \u2014 settings",
  "panel.ai": "AI assistant",
};

/** 4.13: how the builder groups the layouts. */
export type LayoutGroup = "app" | "room" | "windows" | "dialogs" | "panels";
export const LAYOUT_GROUP_LABELS: Readonly<Record<LayoutGroup, string>> = {
  app: "App", room: "Room window", windows: "Windows", dialogs: "Dialogs & parts", panels: "Panels",
};
export const LAYOUT_GROUP: Readonly<Record<LayoutId, LayoutGroup>> = {
  header: "app", chat: "app", "message.in": "app", "message.out": "app", "message.sys": "app", composer: "app", widget: "app", "widget.fab": "app",
  window: "windows", "window.large": "windows", "room.tabs": "room", room: "room",
  "part.needSignIn": "dialogs", "part.signedIn": "dialogs", "dialog.userInfo": "dialogs", "dialog.messageInfo": "dialogs", "dialog.integrity": "dialogs",
  "dialog.account": "panels", "panel.access": "panels", "panel.retention": "panels",
  "panel.profile": "panels", "panel.settings": "panels", "panel.privacy": "panels", "panel.encryption": "panels", "panel.notifications": "panels", "panel.analytics": "panels", "panel.roomSecurity": "panels", "panel.trust": "panels",
  "part.peers": "panels", "part.audio": "panels", "part.video": "panels", "panel.files": "panels", "panel.location": "panels", "panel.speech": "panels", "panel.connection": "panels",
  "part.shareResult": "dialogs", "panel.share": "dialogs", "panel.shareConnection": "dialogs", "part.invite": "dialogs",
  "panel.phone": "panels",
  "panel.connections": "panels", "part.connectionEdit": "panels", "part.connectionDetail": "panels", "part.connectionSettings": "panels",
  "panel.ai": "panels",
};

/** The old Layout builder's component styles each layout carries on (CSS variables --c-<id>-…). */
export const LAYOUT_STYLE_COMPONENT: Readonly<Record<LayoutId, string>> = {
  header: "",
  chat: "chat",
  "message.in": "in",
  "message.out": "out",
  "message.sys": "sys",
  composer: "composer",
  widget: "widget",
  "widget.fab": "widget",
  window: "",
  "window.large": "",
  "room.tabs": "",
  room: "",
  "part.needSignIn": "",
  "part.signedIn": "",
  "dialog.userInfo": "",
  "dialog.messageInfo": "",
  "dialog.integrity": "",
  "dialog.account": "",
  "panel.access": "",
  "panel.retention": "",
  "panel.profile": "",
  "panel.settings": "",
  "panel.privacy": "",
  "panel.encryption": "",
  "panel.notifications": "",
  "panel.analytics": "",
  "panel.roomSecurity": "",
  "panel.trust": "",
  "part.peers": "",
  "part.audio": "",
  "part.video": "",
  "panel.files": "",
  "panel.location": "",
  "panel.speech": "",
  "panel.connection": "",
  "part.shareResult": "",
  "panel.share": "",
  "panel.shareConnection": "",
  "part.invite": "",
  "panel.phone": "",
  "panel.connections": "",
  "part.connectionEdit": "",
  "part.connectionDetail": "",
  "part.connectionSettings": "",
  "panel.ai": "",
};

/** How each of the app's own layouts is built. */
const BUILDERS: Record<LayoutId, () => LNode> = {
  header: headerTree,
  chat: chatTree,
  "message.in": () => messageTree("in"),
  "message.out": () => messageTree("out"),
  "message.sys": () => messageTree("sys"),
  composer: composerTree,
  widget: widgetTree,
  "widget.fab": widgetFabTree,
  window: windowTree,
  "window.large": largeWindowTree,
  "room.tabs": roomTabsTree,
  room: roomTree,
  "part.needSignIn": needSignInTree,
  "part.signedIn": signedInTree,
  "dialog.userInfo": userInfoTree,
  "dialog.messageInfo": messageInfoTree,
  "dialog.integrity": integrityTree,
  "dialog.account": accountInfoTree,
  "panel.access": accessTree,
  "panel.retention": retentionTree,
  "panel.profile": profileTree,
  "panel.settings": settingsTree,
  "panel.privacy": privacyTree,
  "panel.encryption": encryptionTree,
  "panel.notifications": notificationsTree,
  "panel.analytics": analyticsTree,
  "panel.roomSecurity": roomSecurityTree,
  "panel.trust": trustTree,
  "part.peers": peersTree,
  "part.audio": audioTree,
  "part.video": videoTree,
  "panel.files": filesTree,
  "panel.location": locationTree,
  "panel.speech": speechTree,
  "panel.connection": connectionTree,
  "part.shareResult": shareResultTree,
  "panel.share": shareTree,
  "panel.shareConnection": shareConnectionTree,
  "part.invite": inviteTree,
  "panel.phone": phoneTree,
  "panel.connections": connectionsTree,
  "part.connectionEdit": connectionEditTree,
  "part.connectionDetail": connectionDetailTree,
  "part.connectionSettings": connectionSettingsTree,
  "panel.ai": aiTree,
};

/**
 * A record of every layout whose values are made on first use and kept (4.13:
 * a phone opening the app draws the main screen's eight, not every panel's).
 */
function lazy<T>(make: (id: LayoutId) => T): Readonly<Record<LayoutId, T>> {
  const out = {} as Record<LayoutId, T>;
  for (const id of LAYOUT_IDS) {
    Object.defineProperty(out, id, {
      enumerable: true,
      configurable: true,
      get() {
        const value = make(id);
        Object.defineProperty(out, id, { value, enumerable: true, writable: false, configurable: false });
        return value;
      },
    });
  }
  return out;
}

/**
 * The app's own layouts (each built once), in the sanitizer's own form (key
 * order, no empty maps): what the server stores looks exactly like this, so
 * "unchanged" compares equal.
 */
export const DEFAULT_LAYOUTS: Readonly<Record<LayoutId, LNode>> = lazy((id) => {
  const clean = sanitizeTree(BUILDERS[id]());
  if (!clean) throw new Error(`the default layout ${id} does not pass its own checks`);
  return clean;
});

/** Each default's revision (a fingerprint of its tree). */
export const DEFAULT_LAYOUT_REVS: Readonly<Record<LayoutId, string>> = lazy((id) => treeRev(DEFAULT_LAYOUTS[id]));

export function isLayoutId(v: unknown): v is LayoutId {
  return typeof v === "string" && (LAYOUT_IDS as readonly string[]).includes(v);
}
