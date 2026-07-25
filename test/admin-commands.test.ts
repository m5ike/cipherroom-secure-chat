import { describe, expect, it, vi } from "vitest";
import {
  ADMIN_COMMAND_ALLOWLIST,
  isAdminCommand,
  dispatchCommand,
  type AdminCommand,
} from "../client/src/lib/admin-commands";

describe("isAdminCommand", () => {
  it("accepts well-formed allowlisted commands", () => {
    for (const kind of ADMIN_COMMAND_ALLOWLIST) {
      expect(isAdminCommand({ id: "cmd-1", kind, createdAt: 1 })).toBe(true);
    }
  });

  it("rejects unknown kinds", () => {
    expect(isAdminCommand({ id: "cmd-1", kind: "rm-rf", createdAt: 1 })).toBe(false);
    expect(isAdminCommand({ id: "cmd-1", kind: "", createdAt: 1 })).toBe(false);
  });

  it("rejects payloads without an id", () => {
    expect(isAdminCommand({ kind: "purge-local", createdAt: 1 })).toBe(false);
  });

  it("rejects non-objects and primitives", () => {
    expect(isAdminCommand(null)).toBe(false);
    expect(isAdminCommand("purge-local")).toBe(false);
    expect(isAdminCommand(42)).toBe(false);
  });
});

describe("dispatchCommand", () => {
  it("calls the matching handler and reports ok", async () => {
    const handlers = {
      onReconnect: vi.fn(),
      onPurgeLocal: vi.fn().mockResolvedValue(undefined),
    };
    const cmd: AdminCommand = {
      id: "cmd-1",
      kind: "reconnect",
      createdAt: Date.now(),
    };
    const r = await dispatchCommand(cmd, handlers);
    expect(r.ok).toBe(true);
    expect(handlers.onReconnect).toHaveBeenCalledTimes(1);
  });

  it("rejects download URLs that are not http(s)", async () => {
    const handlers = { onDownloadFile: vi.fn() };
    const cmd: AdminCommand = {
      id: "cmd-2",
      kind: "download-file-from-admin",
      createdAt: Date.now(),
      payload: { url: "javascript:alert(1)", name: "evil.html" },
    };
    const r = await dispatchCommand(cmd, handlers);
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/invalid/);
    expect(handlers.onDownloadFile).not.toHaveBeenCalled();
  });

  it("rejects download names with path-traversal characters", async () => {
    const handlers = { onDownloadFile: vi.fn() };
    const cmd: AdminCommand = {
      id: "cmd-3",
      kind: "download-file-from-admin",
      createdAt: Date.now(),
      payload: { url: "https://example.com/file", name: "../../etc/passwd" },
    };
    const r = await dispatchCommand(cmd, handlers);
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/invalid/);
  });

  it("forwards a sanitized payload to onDownloadFile when valid", async () => {
    const handlers = { onDownloadFile: vi.fn() };
    const cmd: AdminCommand = {
      id: "cmd-4",
      kind: "download-file-from-admin",
      createdAt: Date.now(),
      payload: { url: "https://example.com/file.pdf", name: "report.pdf" },
    };
    const r = await dispatchCommand(cmd, handlers);
    expect(r.ok).toBe(true);
    expect(handlers.onDownloadFile).toHaveBeenCalledTimes(1);
    const received = handlers.onDownloadFile.mock.calls[0][0] as AdminCommand;
    expect(received.payload?.url).toBe("https://example.com/file.pdf");
    expect(received.payload?.name).toBe("report.pdf");
  });

  it("returns ok:false for an unknown kind even though allowlist is checked upstream", async () => {
    // We bypass isAdminCommand here to confirm dispatchCommand is safe by itself.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cmd = { id: "cmd-x", kind: "evil", createdAt: 1 } as any;
    const handlers = { onReconnect: vi.fn(), onPurgeLocal: vi.fn() };
    const r = await dispatchCommand(cmd, handlers);
    expect(r.ok).toBe(false);
    expect(handlers.onReconnect).not.toHaveBeenCalled();
    expect(handlers.onPurgeLocal).not.toHaveBeenCalled();
  });
});
