// A person's profile in their details (6.7), a live part ("profile") of the
// details dialog: what they share with the room (their end-to-end encrypted
// "profile" frame), and — only when the viewer asks — the public profile of
// the username they give. That username is their own claim; the lookup says
// whether the account behind it is the one that signs their messages.

import { useEffect, useState } from "react";
import { ShieldCheck, ShieldQuestion } from "lucide-react";
import { t, tf, type Lang } from "../lib/i18n";
import { fetchPublicProfile, type PublicLookup } from "../lib/profile/client";
import type { SharedProfile } from "../lib/profile/model";
import { ProfileCardView } from "./ProfileCardView";
import "./profile.css";

export type PeerProfileInfo = {
  /** What they share with the room (null: nothing, or an app without profiles). */
  room: SharedProfile | null;
  /** The account key that signed their messages, when one did. */
  accountKey?: string;
  self?: boolean;
};

export function PeerProfile({ info, name, username, lang }: { info: PeerProfileInfo; name: string; username?: string; lang: Lang }) {
  const [state, setState] = useState<"idle" | "loading" | "none" | "error">("idle");
  const [lookup, setLookup] = useState<PublicLookup | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { setState("idle"); setLookup(null); }, [username]);

  const load = async () => {
    if (!username) return;
    setState("loading");
    try {
      const found = await fetchPublicProfile(username);
      setLookup(found);
      setState(found ? "idle" : "none");
    } catch (err) {
      setError((err as Error).message);
      setState("error");
    }
  };
  const verified = Boolean(lookup?.accountKey && info.accountKey && lookup.accountKey === info.accountKey);

  return (
    <div className="pf-peer" data-testid="peer-profile">
      {info.room || info.self ? (
        <>
          <span className="pf-peer__k">{info.self ? t(lang, "pf.view.mine") : t(lang, "pf.view.room")}</span>
          <ProfileCardView profile={info.room} fallbackName={name} lang={lang} testId="peer-profile-room" empty={t(lang, "pf.view.nothing")} />
        </>
      ) : null}
      {username && !info.self ? (
        lookup ? (
          <>
            <span className="pf-peer__k">{t(lang, "pf.view.public")} · @{lookup.username}</span>
            <span className={`pf-peer__trust ${verified ? "pf-peer__trust--ok" : "pf-peer__trust--no"}`} data-testid="peer-profile-trust" data-verified={verified}>
              {verified ? <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> : <ShieldQuestion className="h-3.5 w-3.5" aria-hidden />}
              {t(lang, verified ? "pf.view.verified" : "pf.view.unverified")}
            </span>
            <ProfileCardView profile={lookup.profile} fallbackName={name} lang={lang} testId="peer-profile-public" />
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="acc-btn acc-btn--small" disabled={state === "loading"} onClick={() => void load()} data-testid="peer-profile-load">
              {state === "loading" ? t(lang, "pf.view.loading") : tf(lang, "pf.view.loadPublic", { username })}
            </button>
            {state === "none" ? <span className="pf-edit__hint" data-testid="peer-profile-none">{t(lang, "pf.view.none")}</span> : null}
            {state === "error" ? <span className="pf-edit__hint text-destructive">{error}</span> : null}
          </div>
        )
      ) : null}
    </div>
  );
}
