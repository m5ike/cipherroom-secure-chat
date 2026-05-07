// Admin command channel — strictly allowlisted.
// Server pushes commands over the existing signaling WebSocket; the client
// matches the kind against ADMIN_COMMAND_ALLOWLIST and dispatches to a
// callback. Any unknown kind is dropped.
//
// "download-file-from-admin" requires explicit user consent — we never
// auto-download anything without a UI confirmation.

export const ADMIN_COMMAND_ALLOWLIST = [
  "refresh-settings",
  "reconnect",
  "purge-local",
  "show-notification",
  "run-diagnostic",
  "download-file-from-admin",
] as const;

export type AdminCommandKind = typeof ADMIN_COMMAND_ALLOWLIST[number];

export type AdminCommand = {
  id: string;
  kind: AdminCommandKind;
  createdAt: number;
  payload?: Record<string, unknown>;
};

export function isAdminCommand(value: unknown): value is AdminCommand {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string"
    && typeof v.kind === "string"
    && (ADMIN_COMMAND_ALLOWLIST as readonly string[]).includes(v.kind as string);
}

export type AdminCommandHandlers = {
  onRefreshSettings?: () => void;
  onReconnect?: () => void;
  onPurgeLocal?: () => Promise<void> | void;
  onShowNotification?: (title: string, body: string) => void;
  onRunDiagnostic?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  onDownloadFile?: (cmd: AdminCommand) => Promise<void> | void;
};

export async function dispatchCommand(
  cmd: AdminCommand,
  handlers: AdminCommandHandlers,
): Promise<{ ok: boolean; result?: string }> {
  switch (cmd.kind) {
    case "refresh-settings":
      handlers.onRefreshSettings?.();
      return { ok: true };
    case "reconnect":
      handlers.onReconnect?.();
      return { ok: true };
    case "purge-local":
      await handlers.onPurgeLocal?.();
      return { ok: true };
    case "show-notification": {
      const title = String(cmd.payload?.title || "Admin");
      const body = String(cmd.payload?.body || "");
      handlers.onShowNotification?.(title, body);
      return { ok: true };
    }
    case "run-diagnostic": {
      const out = handlers.onRunDiagnostic ? await handlers.onRunDiagnostic() : {};
      return { ok: true, result: JSON.stringify(out).slice(0, 200) };
    }
    case "download-file-from-admin":
      // Awaits explicit user consent inside the handler.
      await handlers.onDownloadFile?.(cmd);
      return { ok: true };
    default:
      return { ok: false, result: "unknown-kind" };
  }
}
