// The room key's strength under the key field (6.7, F-04): a meter, what
// makes it weak, a generated key on one click.
//
// 6.12 (F-04): a generated key is the primary path for a NEW room — with an
// empty field the big button is "Generate a strong key", and typing a key is
// for joining a room someone shared. A weak key is never used without an
// explicit "yes" right here, every time (Connect in the Room window, Save in
// My connections): the box says what the risk is — offline guessing by
// whoever holds the server's data — and offers a strong key instead. Joining
// a room that already uses a weak key is never blocked.

import { t, tf, type Lang } from "../lib/i18n";
import { STRONG_BITS, type KeyEstimate } from "../lib/passphrase-strength";
import "../room.css";

export type WeakKeyConfirm = {
  /** "connect": the Room window's Connect; "save": My connections' Save. */
  kind: "connect" | "save";
  onConfirm: () => void;
  onCancel: () => void;
};

export function KeyStrength({ lang, estimate, onGenerate, confirm, held }: {
  lang: Lang;
  estimate: KeyEstimate;
  onGenerate: () => void;
  /** A Connect / Save with this weak key is waiting for the user's answer. */
  confirm?: WeakKeyConfirm | null;
  /** @deprecated 6.7's "held once" flag — a confirmation box now (`confirm`). */
  held?: boolean;
}) {
  const pct = Math.max(4, Math.min(100, Math.round((estimate.bits / STRONG_BITS) * 100)));
  const empty = estimate.level === "empty";
  return (
    <div className="rd-strength rd-field--wide" data-level={estimate.level} data-testid="key-strength">
      {!empty ? (
        <>
          <div className="rd-strength__bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>
          <div className="rd-strength__label" data-testid="key-strength-label">
            {tf(lang, "key.strength", { level: t(lang, `key.level.${estimate.level}`), bits: estimate.bits })}
          </div>
          {estimate.hints.length ? <ul className="rd-strength__hints">{estimate.hints.map((h) => <li key={h}>{t(lang, `key.hint.${h}`)}</li>)}</ul> : null}
        </>
      ) : (
        <div className="rd-strength__new" data-testid="key-new-hint">{t(lang, "key.new.hint")}</div>
      )}
      {confirm || held ? (
        <div className="rd-strength__held" role="alertdialog" aria-labelledby="key-weak-title" data-testid="key-weak-held">
          <strong id="key-weak-title" className="rd-strength__held-title">{t(lang, "key.weak.title")}</strong>
          <p className="rd-strength__held-text">{t(lang, "key.weak.risk")}</p>
          {confirm ? (
            <div className="rd-strength__held-actions">
              <button type="button" className="rd-btn rd-btn--primary" data-testid="key-weak-generate" onClick={() => { onGenerate(); confirm.onCancel(); }}>{t(lang, "key.generate")}</button>
              <button type="button" className="rd-btn rd-btn--danger-soft" data-testid="key-weak-confirm" onClick={() => confirm.onConfirm()}>
                {t(lang, confirm.kind === "save" ? "key.weak.confirmSave" : "key.weak.confirmJoin")}
              </button>
              <button type="button" className="rd-btn rd-btn--soft" data-testid="key-weak-cancel" onClick={() => confirm.onCancel()}>{t(lang, "common.cancel")}</button>
            </div>
          ) : null}
        </div>
      ) : null}
      <button
        type="button"
        className={`rd-btn ${empty ? "rd-btn--primary" : "rd-btn--soft"} rd-strength__gen`}
        data-testid="key-generate"
        onClick={onGenerate}
      >{t(lang, empty ? "key.generate.new" : "key.generate")}</button>
    </div>
  );
}
