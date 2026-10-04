// The room key's strength under the key field (6.7, F-04): a meter, what
// makes it weak, a generated key on one click — and, after a Connect with a
// weak key for a room this browser does not know, why it was not sent.

import { t, tf, type Lang } from "../lib/i18n";
import { STRONG_BITS, type KeyEstimate } from "../lib/passphrase-strength";

export function KeyStrength({ lang, estimate, held, onGenerate }: { lang: Lang; estimate: KeyEstimate; held: boolean; onGenerate: () => void }) {
  const pct = Math.max(4, Math.min(100, Math.round((estimate.bits / STRONG_BITS) * 100)));
  return (
    <div className="rd-strength rd-field--wide" data-level={estimate.level} data-testid="key-strength">
      {estimate.level !== "empty" ? (
        <>
          <div className="rd-strength__bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>
          <div className="rd-strength__label" data-testid="key-strength-label">
            {tf(lang, "key.strength", { level: t(lang, `key.level.${estimate.level}`), bits: estimate.bits })}
          </div>
          {estimate.hints.length ? <ul className="rd-strength__hints">{estimate.hints.map((h) => <li key={h}>{t(lang, `key.hint.${h}`)}</li>)}</ul> : null}
        </>
      ) : null}
      {held ? <div className="rd-strength__held" role="alert" data-testid="key-weak-held">{t(lang, "key.weak.held")}</div> : null}
      <button type="button" className="rd-btn rd-btn--soft rd-strength__gen" data-testid="key-generate" onClick={onGenerate}>{t(lang, "key.generate")}</button>
    </div>
  );
}
