// 6.12 (F-02): is the code in this tab what the developer signed? The state
// comes from lib/integrity.ts › runReleaseCheck (a signed release manifest, a
// pinned release key, the loaded scripts and styles hashed). Two views:
//
//   ReleaseBanner      a red bar that stays while the loaded code does not
//                      match a signed manifest, or the server presents
//                      another release key than the pinned one
//   ReleaseStatusCard  the security (Trust) panel's line: signed by key X /
//                      unsigned / MODIFIED / key changed — with what differs
//
// Honest limits (see integrity.ts): a first visit has no pin, and a server that
// replaces the whole bundle can remove this check with it.

import { useEffect, useState } from "react";
import { t, tf, type Lang } from "../lib/i18n";
import { acceptServedReleaseKey, currentReleaseState, onReleaseState, runReleaseCheck, type ReleaseState } from "../lib/integrity";
import "../release.css";

const RECHECK_MS = 10 * 60 * 1000;

/** The page's release state; the first user starts the check, a visible tab repeats it now and then. */
export function useReleaseState(): ReleaseState | null {
  const [state, setState] = useState<ReleaseState | null>(() => currentReleaseState());
  useEffect(() => {
    const off = onReleaseState(setState);
    const first = window.setTimeout(() => { void runReleaseCheck(); }, 3000);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void runReleaseCheck(); }, RECHECK_MS);
    return () => { off(); window.clearTimeout(first); window.clearInterval(timer); };
  }, []);
  return state;
}

/** Does this state call for the red banner? */
export function releaseAlarm(state: ReleaseState | null): boolean {
  return state?.state === "modified" || state?.state === "key-changed";
}

export function ReleaseBanner({ lang, onDetails }: { lang: Lang; onDetails?: () => void }) {
  const state = useReleaseState();
  if (!releaseAlarm(state) || !state) return null;
  const text = state.state === "key-changed" ? tf(lang, "release.banner.key", { pinned: state.pinnedId, served: state.servedId }) : t(lang, `release.banner.${state.state === "modified" ? state.reason : "assets"}`);
  return (
    <div className="release-banner" role="alert" data-testid="release-banner">
      <strong className="release-banner__title">{t(lang, "release.banner.title")}</strong>
      <span className="release-banner__text">{text}</span>
      {onDetails ? <button type="button" className="release-banner__btn" onClick={onDetails}>{t(lang, "release.details")}</button> : null}
    </div>
  );
}

export function ReleaseStatusCard({ lang }: { lang: Lang }) {
  const state = useReleaseState();
  const [busy, setBusy] = useState(false);
  const recheck = () => { setBusy(true); void runReleaseCheck(true).finally(() => setBusy(false)); };
  let tone: "ok" | "warn" | "bad" | "muted" = "muted";
  let text = t(lang, "release.state.checking");
  let detail: string[] = [];
  if (state) {
    switch (state.state) {
      case "unavailable": text = t(lang, "release.state.unavailable"); break;
      case "unsigned":
        tone = "warn"; text = t(lang, "release.state.unsigned");
        detail = state.mismatches.map((m) => `${m.kind === "changed" ? "≠" : "+"} ${m.path}`);
        break;
      case "unverifiable": tone = "warn"; text = t(lang, "release.state.unverifiable"); break;
      case "signed":
        tone = "ok";
        text = tf(lang, state.pin.source === "build" ? "release.state.signedBuild" : "release.state.signed", { key: state.keyId, version: state.manifest.version || "?" });
        if (state.firstUse) detail = [t(lang, "release.state.firstUse")];
        break;
      case "modified":
        tone = "bad"; text = tf(lang, `release.state.modified.${state.reason}`, { key: state.keyId });
        detail = state.mismatches.map((m) => `${m.kind === "changed" ? "≠" : "+"} ${m.path}`);
        break;
      case "key-changed":
        tone = "bad"; text = tf(lang, "release.state.keyChanged", { pinned: state.pinnedId, served: state.servedId });
        break;
    }
  }
  return (
    <section className="release-card" data-tone={tone} data-state={state?.state ?? "checking"} data-testid="release-status">
      <h3 className="release-card__title">{t(lang, "release.title")}</h3>
      <p className="release-card__text" data-testid="release-status-text">{text}</p>
      {detail.length ? <ul className="release-card__list">{detail.slice(0, 12).map((d) => <li key={d}>{d}</li>)}</ul> : null}
      <p className="release-card__note">{t(lang, "release.note")}</p>
      <div className="release-card__actions">
        <button type="button" className="release-card__btn" onClick={recheck} disabled={busy}>{t(lang, "release.recheck")}</button>
        {state?.state === "key-changed" ? (
          <button
            type="button"
            className="release-card__btn release-card__btn--danger"
            data-testid="release-accept-key"
            onClick={() => {
              if (!window.confirm(tf(lang, "release.acceptKey.confirm", { served: state.servedId }))) return;
              acceptServedReleaseKey(state.served);
              recheck();
            }}
          >{t(lang, "release.acceptKey")}</button>
        ) : null}
      </div>
    </section>
  );
}
