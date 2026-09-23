// The "signed in" badge in the header. A file of its own: it is on screen
// whenever someone is signed in, while the account panel (AccountPanel.tsx)
// is loaded only when opened.

import { LockKeyholeOpen } from "lucide-react";
import { t, type Lang } from "../lib/i18n";
import type { AccountSummary } from "../lib/account";

export function SignedInBadge({ account, onClick, lang }: { account: AccountSummary; onClick: () => void; lang: Lang }) {
  const pending = account.mailbox.pending;
  return (
    <button
      type="button"
      className="signed-badge"
      onClick={onClick}
      data-testid="signed-in-badge"
      title={t(lang, "acc.signedInAs").replace("{name}", account.userName)}
      aria-label={t(lang, "acc.signedInAs").replace("{name}", account.userName)}
    >
      <LockKeyholeOpen className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="signed-badge__label">{t(lang, "acc.signedIn")}</span>
      <span className="signed-badge__name">{account.userName}</span>
      {pending > 0 ? <span className="signed-badge__count" title={t(lang, "away.pending").replace("{n}", String(pending))}>{pending}</span> : null}
    </button>
  );
}
