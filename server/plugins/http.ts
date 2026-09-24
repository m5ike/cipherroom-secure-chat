// HTTP for the connectors (4.0.6): a timeout on every call, errors that say
// what went wrong (the provider's own message, or why the connection
// failed — not just "fetch failed"), and one retry without a sampling
// parameter a model refuses (newer Claude and OpenAI reasoning models reject
// `temperature`; OpenAI's newer models want `max_completion_tokens`).

export const PROVIDER_TIMEOUT_MS = 60_000;

const CONNECT_ERRORS: Record<string, string> = {
  ENOTFOUND: "the host name does not resolve (DNS) — a wrong or retired address",
  EAI_AGAIN: "DNS lookup failed (temporary) — check the server's DNS",
  ECONNREFUSED: "the connection was refused — nothing listens at that address",
  ECONNRESET: "the connection was reset",
  ETIMEDOUT: "the connection timed out",
  EHOSTUNREACH: "the host is unreachable",
  ENETUNREACH: "the network is unreachable (no route — IPv6 only?)",
  UND_ERR_CONNECT_TIMEOUT: "the connection timed out",
  UND_ERR_HEADERS_TIMEOUT: "the server did not answer in time",
  UND_ERR_SOCKET: "the connection broke",
  CERT_HAS_EXPIRED: "the server's TLS certificate has expired",
  DEPTH_ZERO_SELF_SIGNED_CERT: "the server's TLS certificate is self-signed",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "the server's TLS certificate cannot be verified",
};

/** A failed fetch() in words: "fetch failed" plus the reason under it and the host. */
export function describeFetchError(err: unknown, url: string): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string; hostname?: string } };
  let host = url;
  try { host = new URL(url).host; } catch { /* keep the url */ }
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return `no answer from ${host} within ${PROVIDER_TIMEOUT_MS / 1000} s`;
  const code = e?.cause?.code ?? "";
  const why = CONNECT_ERRORS[code] ?? e?.cause?.message ?? "";
  return `${e?.message || "request failed"} (${host}${code ? `: ${code}` : ""}${why ? ` — ${why}` : ""})`;
}

/** The provider's own error message out of a response body (JSON or text). */
export function providerMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: unknown; message?: unknown; detail?: unknown };
    const err = j.error as { message?: unknown } | string | undefined;
    const msg = typeof err === "string" ? err : typeof err?.message === "string" ? err.message : typeof j.message === "string" ? j.message : typeof j.detail === "string" ? j.detail : "";
    if (msg) return msg.slice(0, 400);
  } catch { /* not JSON */ }
  return body.trim().slice(0, 400);
}

export class ProviderError extends Error {
  constructor(readonly provider: string, readonly status: number, readonly detail: string) {
    super(status ? `${provider} ${status}: ${detail}` : `${provider}: ${detail}`);
    this.name = "ProviderError";
  }
}

type Json = Record<string, unknown>;

/**
 * POSTs JSON; on a 400 that names a parameter the model does not take, the
 * `adjust` callback may return a body without it — tried once more.
 */
export async function postJson<T>(provider: string, url: string, headers: Record<string, string>, body: Json, adjust?: (body: Json, message: string) => Json | null): Promise<T> {
  let current = body;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(current), signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
    } catch (err) {
      throw new ProviderError(provider, 0, describeFetchError(err, url));
    }
    if (res.ok) return (await res.json()) as T;
    const detail = providerMessage(await res.text());
    const next = res.status === 400 && adjust ? adjust(current, detail) : null;
    if (!next) throw new ProviderError(provider, res.status, detail);
    current = next;
  }
  throw new ProviderError(provider, 400, "the request was refused");
}

/** POSTs raw bytes or a form; errors as postJson. */
export async function postRaw(provider: string, url: string, headers: Record<string, string>, body: BodyInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  } catch (err) {
    throw new ProviderError(provider, 0, describeFetchError(err, url));
  }
  if (!res.ok) throw new ProviderError(provider, res.status, providerMessage(await res.text()));
  return res;
}

/** Drops (or renames) the sampling parameter a model refused; null when the refusal was about something else. */
export function withoutRefusedParam(body: Json, message: string): Json | null {
  const m = message.toLowerCase();
  const next = { ...body };
  for (const p of ["temperature", "top_p", "top_k"]) {
    if (p in next && m.includes(p)) { delete next[p]; return next; }
  }
  if ("max_tokens" in next && m.includes("max_tokens") && m.includes("max_completion_tokens")) {
    next.max_completion_tokens = next.max_tokens;
    delete next.max_tokens;
    return next;
  }
  return null;
}
