// 6.9: what the handlers of one provider webhook learned while answering it
// (which provider, was the signature verified, which call, the parsed event)
// — kept on the request so the webhook log (log.ts) can write one complete
// line when the response has gone. No I/O; a tiny module so webhooks.ts,
// tel-routes.ts and the control layer can all fill it without import cycles.

export type WhContext = {
  provider?: string;
  /** The webhook's type (/wh/<provider>/<type>) or kind (/wh/tel/<token>/<kind>). */
  type?: string;
  verified?: boolean | null;
  enforced?: boolean;
  /** tel-store TelCall.id (or a message id) the webhook belongs to. */
  callId?: string;
  tsaSession?: string;
  rule?: string;
  direction?: "inbound" | "outbound" | "";
  /** The older normalized event (webhooks.ts TelephonyEvent), when one was recorded. */
  event?: unknown;
  /** Anything else worth showing with the parsed data (a route decision, a TSA event…). */
  notes?: Record<string, unknown>;
  /** A line for the log list instead of the generic one. */
  summary?: string;
  /** A synthetic event of the console's webhook test. */
  test?: boolean;
};

const KEY = Symbol.for("m5.telephony.webhook-context");

/** The context of this request (created on first use). */
export function whContext(req: object): WhContext {
  const holder = req as Record<symbol, WhContext | undefined>;
  return (holder[KEY] ??= {});
}

/** Adds notes (shallow) to the request's context. */
export function whNote(req: object, notes: Record<string, unknown>): void {
  const ctx = whContext(req);
  ctx.notes = { ...(ctx.notes ?? {}), ...notes };
}
