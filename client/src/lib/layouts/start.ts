// The start screen (6.7): what the chat window shows while there is no
// message — when the app starts (not connected yet) and in a room before the
// first message: the lock, the title, the text and Connect (opens the Room
// window). Until 6.7 a part of the chat window's layout; now its own, drawn
// in the chat window's "start" part by components/StartScreen.tsx.

import { treeBuilder, type LNode } from "../layout-tree";
import type { LayoutContract } from "./contracts";

export function startTree(): LNode {
  const { n, text, icon } = treeBuilder("st");
  return n("panel", { id: "start", name: "Start screen", attrs: { class: "flex h-full min-h-[60dvh] items-center justify-center" } }, [
    n("panel", { id: "start-card", name: "Card", attrs: { class: "max-w-md rounded-3xl border border-border bg-card/90 p-6 text-center shadow-sm" } }, [
      n("panel", { id: "start-icon", name: "Icon", attrs: { class: "mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary" } }, [icon("lock", "h-6 w-6", {}, { id: "start-lock" })]),
      n("heading", { id: "start-title", name: "Title", tag: "h3", attrs: { class: "text-lg font-semibold" }, text: "{$title}" }),
      n("paragraph", { id: "start-body", name: "Text", attrs: { class: "mt-2 text-sm text-muted-foreground" }, text: "{$body}" }),
      n("button", {
        id: "start-connect", name: "Connect",
        attrs: { type: "button", class: "mt-4 inline-flex min-h-10 items-center gap-2 rounded-2xl bg-primary px-4 text-sm font-semibold text-primary-foreground", "data-testid": "button-open-join" },
        on: { click: { action: "openRoom" } },
      }, [icon("radio", "h-4 w-4", {}, { id: "start-connect-icon" }), text("{_'join.connect'}", { id: "start-connect-text" })]),
    ]),
  ]);
}

export const START_CONTRACT: LayoutContract = {
  description: "The start screen: what the chat window shows while there is no message — when the app starts (not connected yet), and in a room before the first message. The app's own: the lock, the title, the text and Connect (opens the Room window).",
  vars: [
    { path: "$title", type: "text", description: "The title (Texts & behaviour › Empty chat title)." },
    { path: "$body", type: "text", description: "The text (Texts & behaviour › Empty chat text)." },
    { path: "$status", type: "text", description: "idle, deriving, connecting, joined or offline." },
    { path: "$connected", type: "yes/no", description: "Connected to a room (or connecting)." },
    { path: "$room", type: "text", description: "The room (when connected)." },
    { path: "$signedIn", type: "yes/no", description: "Signed in with a passkey." },
    { path: "$username", type: "text", description: "The account's username." },
    { path: "$serverMode", type: "yes/no", description: "Server-enhanced picked (no: Light · P2P)." },
    { path: "$profiles", type: "list", description: "Saved connections to connect from here (signed in, Server-enhanced, My connections on): .id, .label." },
  ],
  actions: [
    { name: "openRoom", description: "Open the Room window (the Connect button)." },
    { name: "connectProfile", description: "Connect a saved connection.", arg: "its id ($p.id)" },
    { name: "signIn", description: "Open the Connection window (sign in with a passkey)." },
  ],
  slots: [],
  refs: [],
};

export const START_VARIANTS = [
  { id: "start", label: "The app just started" },
  { id: "connected", label: "In a room, no message yet" },
  { id: "signedin", label: "Signed in, saved connections" },
];
