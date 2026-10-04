// The start screen (6.7): what the chat window shows while there is no
// message — the lock, the title, the text and Connect. The layout ("start",
// lib/layouts/start.ts) is the operator's to redesign in the console's
// Layout builder; App.tsx hands over the state and does the connecting.

import type { Lang } from "../lib/i18n";
import { renderLayout } from "./LayoutView";
import { useLayoutBase } from "./LayoutProvider";

export type StartScreenProps = {
  lang: Lang;
  /** The title and the text (the operator's "Empty chat" texts, rendered). */
  title: string;
  body: string;
  status: string;
  /** Connected to a room, or on the way. */
  connected: boolean;
  room: string;
  signedIn: boolean;
  username: string;
  /** Server-enhanced picked (else Light · P2P). */
  serverMode: boolean;
  /** Saved connections one may connect from here (none when My connections is not available). */
  profiles: Array<{ id: string; label: string }>;
  /** Connect: opens the Room window. */
  onOpenRoom: () => void;
  onConnectProfile: (id: string) => void;
  /** Opens the Connection window (passkey sign-in). */
  onSignIn: () => void;
};

export function StartScreen({ lang, title, body, status, connected, room, signedIn, username, serverMode, profiles, onOpenRoom, onConnectProfile, onSignIn }: StartScreenProps) {
  const { tree, base } = useLayoutBase("start", lang);
  return renderLayout(tree, {
    ...base,
    data: { title, body, status, connected, room, signedIn, username, serverMode, profiles },
    actions: {
      openRoom: () => onOpenRoom(),
      connectProfile: (_e, id) => { if (id !== undefined && id !== null && id !== "") onConnectProfile(String(id)); },
      signIn: () => onSignIn(),
    },
  });
}
