// The start screen (6.7): what the chat window shows while there is no
// message — the lock, the title, the text and Connect. The layout ("start",
// lib/layouts/start.ts) is the operator's to redesign in the console's
// Layout builder; App.tsx hands over the state and does the connecting.
// 6.13: with the language picker (the nine languages by their own names).

import type { ChangeEvent } from "react";
import { SUPPORTED_LANGS, langLabel, langTag, type Lang } from "../lib/i18n";
import { isLocale } from "../lib/locales";
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
  /** 6.13: another language picked (no picker without it). */
  onLang?: (lang: Lang) => void;
};

/** The picker's list: every language by its own name, with its tag (the option's lang attribute). */
export const LANGUAGE_CHOICES = SUPPORTED_LANGS.map((code) => ({ code, label: langLabel(code), tag: langTag(code) }));

export function StartScreen({ lang, title, body, status, connected, room, signedIn, username, serverMode, profiles, onOpenRoom, onConnectProfile, onSignIn, onLang }: StartScreenProps) {
  const { tree, base } = useLayoutBase("start", lang);
  return renderLayout(tree, {
    ...base,
    data: { title, body, status, connected, room, signedIn, username, serverMode, profiles, lang, langs: onLang ? LANGUAGE_CHOICES : [] },
    actions: {
      openRoom: () => onOpenRoom(),
      connectProfile: (_e, id) => { if (id !== undefined && id !== null && id !== "") onConnectProfile(String(id)); },
      signIn: () => onSignIn(),
      setLang: (e) => { const v = (e as ChangeEvent<HTMLSelectElement>)?.target?.value; if (isLocale(v)) onLang?.(v); },
    },
  });
}
