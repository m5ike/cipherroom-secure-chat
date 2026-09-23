// The notice that slides in at the top of the screen.
//
// One at a time (the queue lives in lib/flash.ts), at most two lines tall,
// as wide as its text needs and no wider than the screen allows. It fades
// in, stays for as long as the settings say, and fades out; a click takes
// it away and the next one comes up at once. Everything visual — position,
// colours, font, size, corner radius, icon, animation — comes from
// Preferences.flash.

import { useEffect, useState, type CSSProperties } from "react";
import { AlertTriangle, CheckCircle2, Info, OctagonAlert, Radio, X } from "lucide-react";
import type { FlashKind, FlashMessage } from "../lib/flash";
import type { FlashSettings } from "../lib/preferences";
import { fontStack } from "../lib/fonts";

const ICONS: Record<FlashKind, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: OctagonAlert,
  system: Radio,
};

export function FlashMessages({
  message,
  queued,
  settings,
  onDismiss,
  label,
}: {
  message: FlashMessage | null;
  queued: number;
  settings: FlashSettings;
  onDismiss: (id: string) => void;
  /** Accessible name for the dismiss action. */
  label: string;
}) {
  // Keep the outgoing message mounted for the length of the fade-out, so it
  // leaves the way it arrived instead of vanishing.
  const [shown, setShown] = useState<FlashMessage | null>(message);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (message) {
      setShown(message);
      setLeaving(false);
      return;
    }
    if (!shown) return;
    setLeaving(true);
    const timer = window.setTimeout(() => { setShown(null); setLeaving(false); }, 260);
    return () => window.clearTimeout(timer);
  }, [message, shown]);

  if (!settings.enabled || !shown) return null;

  const Icon = ICONS[shown.kind] ?? Info;
  const style: CSSProperties = {
    ...(settings.background ? { background: settings.background } : {}),
    ...(settings.color ? { color: settings.color } : {}),
    ...(settings.font ? { fontFamily: fontStack(settings.font) } : {}),
    fontSize: `${settings.size}px`,
    borderRadius: `${settings.radius}px`,
  };

  return (
    <div className={`flash-layer flash-at-${settings.position}`} aria-live="polite" data-testid="flash-layer">
      <button
        type="button"
        key={shown.id}
        className={`flash flash--${shown.kind} flash-anim-${settings.animation}${leaving ? " is-leaving" : ""}`}
        style={style}
        onClick={() => onDismiss(shown.id)}
        title={label}
        aria-label={`${shown.text}. ${label}`}
        data-testid="flash-message"
        data-flash-id={shown.id}
        data-kind={shown.kind}
      >
        {settings.icon ? <Icon className="flash__icon" aria-hidden="true" /> : null}
        <span className="flash__body">
          <span className="flash__text">{shown.text}</span>
          {shown.detail ? <span className="flash__detail">{shown.detail}</span> : null}
        </span>
        {queued > 0 ? <span className="flash__count" data-testid="flash-queued">+{queued}</span> : null}
        <X className="flash__close" aria-hidden="true" />
      </button>
    </div>
  );
}
