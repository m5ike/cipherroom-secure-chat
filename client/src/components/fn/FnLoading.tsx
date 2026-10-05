// 6.5: a command call shows at once as the sender's own bubble; while the
// model works, this sits under the query — three bouncing dots and the
// model's name — and is replaced by the result or a short status when it
// answers. The bubble itself pulses (msg-bubble--fn-running, bubbles.css).
// 6.11: what the run says of itself (m5.run.progress) shows under it, and the
// status chip carries an icon (done ✓, error ⚠, cancelled ⊘, other ℹ).

import { Ban, CircleAlert, CircleCheck, Info } from "lucide-react";
import type { FnStatus } from "../../lib/message-kinds";

export function FnLoading({ label, progress }: { label: string; progress?: { p: number; text: string } }) {
  const p = progress && progress.p > 0 && progress.p <= 1 ? progress.p : null;
  return (
    <div className="fn-loading" role="status" aria-live="polite" data-testid="fn-loading">
      <span className="fn-loading__dots" aria-hidden="true"><i /><i /><i /></span>
      <span className="fn-loading__label">{label}</span>
      {progress && (progress.text || p !== null) ? (
        <span className="fn-loading__progress" data-testid="fn-progress">
          {p !== null ? <span className="fn-loading__bar" aria-hidden="true"><i style={{ width: `${Math.round(p * 100)}%` }} /></span> : null}
          {progress.text ? <span className="fn-loading__text">{progress.text}</span> : null}
        </span>
      ) : null}
    </div>
  );
}

/** The outcome under a call bubble when there is no inline result (a room answer that went out, or an error/status). */
export function FnStatusChip({ status }: { status: FnStatus }) {
  const Icon = status.kind === "ok" ? CircleCheck : status.kind === "error" ? CircleAlert : status.code === "cancelled" ? Ban : Info;
  return (
    <div className={`fn-status fn-status--${status.kind}`} role="status" data-testid="fn-status" data-code={status.code || undefined}>
      <Icon className="fn-status__icon" aria-hidden="true" />
      <span className="fn-status__label">{status.label}</span>
      {status.code && status.kind === "error" ? <span className="fn-status__code">{status.code}</span> : null}
    </div>
  );
}
