// "Needs a passkey sign-in" (4.0): shown in place of anything that belongs
// to an account on the server — Server-enhanced, saved connections, the
// server's chat history, web push. Signing in happens in one place only, the
// Connection window; this card links there.

import { KeyRound } from "lucide-react";
import { t, type Lang } from "../lib/i18n";

export function NeedSignIn({ lang, onOpen, text, testId = "need-signin", compact }: {
  lang: Lang;
  /** Opens the Connection window. */
  onOpen?: () => void;
  /** What it would unlock (defaults to the general sentence). */
  text?: string;
  testId?: string;
  compact?: boolean;
}) {
  return (
    <div className={`id-need${compact ? " is-compact" : ""}`} data-testid={testId}>
      <span className="id-need__icon" aria-hidden="true"><KeyRound className="h-4 w-4" /></span>
      <div className="min-w-0">
        <strong>{t(lang, "id.need.title")}</strong>
        <p>{text ?? t(lang, "id.need.text")}</p>
        {onOpen ? (
          <button type="button" className="acc-btn" onClick={onOpen} data-testid={`${testId}-open`}>
            {t(lang, "id.need.open")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
