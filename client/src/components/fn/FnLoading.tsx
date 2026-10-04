// 6.5: a command call shows at once as the sender's own bubble; while the
// model works, this sits under the query — three bouncing dots and the
// model's name — and is replaced by the result or a short status when it
// answers. The bubble itself pulses (msg-bubble--fn-running, bubbles.css).

import type { FnStatus } from "../../lib/message-kinds";

export function FnLoading({ label }: { label: string }) {
  return (
    <div className="fn-loading" role="status" aria-live="polite" data-testid="fn-loading">
      <span className="fn-loading__dots" aria-hidden="true"><i /><i /><i /></span>
      <span className="fn-loading__label">{label}</span>
    </div>
  );
}

const STATUS_ICON: Record<FnStatus["kind"], string> = { ok: "✓", error: "⚠", info: "•" };

/** The outcome under a call bubble when there is no inline result (a room answer that went out, or an error/status). */
export function FnStatusChip({ status }: { status: FnStatus }) {
  return (
    <div className={`fn-status fn-status--${status.kind}`} role="status" data-testid="fn-status">
      <span className="fn-status__icon" aria-hidden="true">{STATUS_ICON[status.kind]}</span>
      <span className="fn-status__label">{status.label}</span>
      {status.code ? <span className="fn-status__code">{status.code}</span> : null}
    </div>
  );
}
