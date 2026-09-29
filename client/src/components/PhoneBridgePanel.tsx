// The phone bridge panel (6.0): the calls offered to this member (layout
// "phone.bridge", lib/layouts/phonebridge.ts — the operator's to redesign).
// App.tsx keeps the calls from the "phone-bridge" frames; this component
// takes them (lib/phone-bridge.ts) and draws them.

import type { FormEvent } from "react";
import type { Lang } from "../lib/i18n";
import type { PhoneCall } from "../lib/phone-bridge";
import { renderLayout } from "./LayoutView";
import { useLayoutBase } from "./LayoutProvider";

export type PhoneBridgePanelProps = {
  lang: Lang;
  calls: PhoneCall[];
  onTakeAudio: (session: string) => void;
  onTakeText: (session: string) => void;
  onReply: (session: string, text: string) => void;
  onMute: (session: string) => void;
  onHangup: (session: string) => void;
  onDismiss: (session: string) => void;
};

export function PhoneBridgePanel({ lang, calls, onTakeAudio, onTakeText, onReply, onMute, onHangup, onDismiss }: PhoneBridgePanelProps) {
  const { tree, base } = useLayoutBase("phone.bridge", lang);
  if (!calls.length) return null;
  return (
    <div className="pb-stack" data-testid="phone-bridge-stack">
      {renderLayout(tree, {
        ...base,
        data: { calls },
        actions: {
          takeAudio: (_e, s) => onTakeAudio(String(s)),
          takeText: (_e, s) => onTakeText(String(s)),
          reply: (event, s) => {
            const e = event as FormEvent<HTMLFormElement>;
            e.preventDefault();
            const input = e.currentTarget.querySelector<HTMLInputElement>("input");
            const text = input?.value.trim() ?? "";
            if (!text) return;
            onReply(String(s), text);
            if (input) input.value = "";
          },
          mute: (_e, s) => onMute(String(s)),
          hangup: (_e, s) => onHangup(String(s)),
          dismiss: (_e, s) => onDismiss(String(s)),
        },
      })}
    </div>
  );
}
