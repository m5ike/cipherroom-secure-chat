// The "signed in" badge in the header. A file of its own: it is on screen
// whenever someone is signed in, while the account panel (AccountPanel.tsx)
// is loaded only when opened.

import { type Lang } from "../lib/i18n";
import type { AccountSummary } from "../lib/account";
import { renderLayout } from "./LayoutView";
import { useLayoutBase } from "./LayoutProvider";

export function SignedInBadge({ account, onClick, lang }: { account: AccountSummary; onClick: () => void; lang: Lang }) {
  // 4.13: a layout ("part.signedIn", lib/layouts/dialogs.ts).
  const { tree, base } = useLayoutBase("part.signedIn", lang);
  return renderLayout(tree, { ...base, data: { userName: account.userName, pending: account.mailbox.pending }, actions: { open: () => onClick() } });
}
