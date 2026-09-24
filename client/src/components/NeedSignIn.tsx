// "Needs a passkey sign-in" (4.0): shown in place of anything that belongs
// to an account on the server — Server-enhanced, saved connections, the
// server's chat history, web push. Signing in happens in one place only, the
// Connection window; this card links there.

import { type Lang } from "../lib/i18n";
import { renderLayout } from "./LayoutView";
import { useLayoutBase } from "./LayoutProvider";

export function NeedSignIn({ lang, onOpen, text, testId = "need-signin", compact }: {
  lang: Lang;
  /** Opens the Connection window. */
  onOpen?: () => void;
  /** What it would unlock (defaults to the general sentence). */
  text?: string;
  testId?: string;
  compact?: boolean;
}) {
  // 4.13: a layout ("part.needSignIn", lib/layouts/dialogs.ts).
  const { tree, base } = useLayoutBase("part.needSignIn", lang);
  return renderLayout(tree, {
    ...base,
    data: { text, testId, compact: Boolean(compact), canOpen: Boolean(onOpen) },
    actions: { open: () => onOpen?.() },
  });
}
