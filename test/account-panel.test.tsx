// The signed-in user in the interface: the badge, the account window and the
// retention choice. What the server never gets to see must not appear here
// either — the window shows sizes and dates, not message contents.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";
import { AccountAccess, AccountInfoModal, ChatRetentionSection, SignedInBadge } from "../client/src/components/AccountPanel";
import type { AccountSummary } from "../client/src/lib/account";

afterEach(() => cleanup());

const ACCOUNT: AccountSummary = {
  id: "acc-1234567890abcdefghi",
  credentialId: "Y3JlZGVudGlhbC1pZC1oZXJl",
  alg: -7,
  userName: "Alice",
  createdAt: Date.UTC(2026, 0, 2, 10, 0),
  lastLoginAt: Date.UTC(2026, 8, 20, 18, 30),
  loginCount: 7,
  vault: { profileBytes: 1200, profileUpdatedAt: Date.UTC(2026, 8, 20, 18, 31), chatBytes: 48_000, chatUpdatedAt: Date.UTC(2026, 8, 21, 9, 0), messages: 124, messageBytes: 36_000, rooms: 2 },
  mailbox: { pending: 3, bytes: 2048 },
  away: [{ room: "brno-secure", name: "Alice", since: Date.UTC(2026, 8, 21, 8, 0) }],
  pushDevices: 2,
  audit: [
    { at: Date.UTC(2026, 8, 21, 9, 1), kind: "relay-stored", meta: { room: "brno-secure", bytes: 512 } },
    { at: Date.UTC(2026, 8, 21, 9, 0), kind: "sign-in", meta: { client: "Chrome/macOS" } },
  ],
};

describe("signed-in badge", () => {
  it("names the user, shows waiting messages and opens the window", () => {
    const onClick = vi.fn();
    render(<SignedInBadge account={ACCOUNT} onClick={onClick} lang="cs" />);
    const badge = screen.getByTestId("signed-in-badge");
    expect(badge.textContent).toContain("přihlášen");
    expect(badge.textContent).toContain("Alice");
    expect(badge.textContent).toContain("3"); // pending mailbox items
    fireEvent.click(badge);
    expect(onClick).toHaveBeenCalled();
  });

  it("stays quiet when nothing is waiting", () => {
    render(<SignedInBadge account={{ ...ACCOUNT, mailbox: { pending: 0, bytes: 0 } }} onClick={() => {}} lang="en" />);
    expect(screen.getByTestId("signed-in-badge").textContent).toContain("signed in");
    expect(screen.getByTestId("signed-in-badge").textContent).not.toMatch(/\d/);
  });
});

describe("account window", () => {
  function open(over: Partial<AccountSummary> = {}, handlers: Record<string, () => void> = {}) {
    const props = {
      account: { ...ACCOUNT, ...over },
      status: { available: true, persistent: true, rpId: "chat.example", accounts: 3, limits: { profileChars: 1, chatChars: 1, mailboxItems: 1 } },
      busy: false,
      message: "",
      lang: "cs" as const,
      onRefresh: vi.fn(), onSaveNow: vi.fn(), onSignOut: vi.fn(), onDelete: vi.fn(),
      ...handlers,
    };
    render(<AccountInfoModal {...props} />);
    return props;
  }

  it("shows the credentials, the sizes and the dates", () => {
    open();
    const panel = screen.getByTestId("account-info");
    expect(panel.textContent).toContain("acc-1234567890abcdefghi");
    expect(panel.textContent).toContain("ES256");
    expect(panel.textContent).toContain("124");           // messages
    expect(panel.textContent).toContain("48.0 kB");       // session size (profile + chat)
    expect(panel.textContent).toContain("brno-secure");   // away room
    expect(panel.textContent).toContain("2");             // push devices
  });

  it("lists the server-side activity in words", () => {
    open();
    const log = within(screen.getByTestId("account-audit"));
    expect(log.getByText("server převzal zprávu")).toBeTruthy();
    expect(log.getByText("přihlášení")).toBeTruthy();
    expect(log.getByText(/client: Chrome\/macOS/)).toBeTruthy();
  });

  it("warns when the server cannot keep the account across a restart", () => {
    render(
      <AccountInfoModal
        account={ACCOUNT}
        status={{ available: true, persistent: false, rpId: "chat.example", accounts: 1, limits: { profileChars: 1, chatChars: 1, mailboxItems: 1 } }}
        busy={false} message="" lang="en"
        onRefresh={() => {}} onSaveNow={() => {}} onSignOut={() => {}} onDelete={() => {}}
      />,
    );
    expect(screen.getByTestId("account-info").textContent).toMatch(/will not survive a restart/i);
  });

  it("wires up refresh, save, sign out and delete", () => {
    const props = open();
    fireEvent.click(screen.getByTestId("account-refresh"));
    fireEvent.click(screen.getByTestId("account-save"));
    fireEvent.click(screen.getByTestId("account-signout"));
    fireEvent.click(screen.getByTestId("account-delete"));
    expect(props.onRefresh).toHaveBeenCalledOnce();
    expect(props.onSaveNow).toHaveBeenCalledOnce();
    expect(props.onSignOut).toHaveBeenCalledOnce();
    expect(props.onDelete).toHaveBeenCalledOnce();
  });
});

describe("chat retention choice", () => {
  function render_(over: Record<string, unknown> = {}) {
    const props = { value: "ephemeral" as const, onChange: vi.fn(), account: null as AccountSummary | null, lang: "cs" as const, ...over };
    render(<ChatRetentionSection {...props} />);
    return props;
  }

  it("offers the three modes and describes each", () => {
    render_();
    expect(screen.getByTestId("retention-ephemeral").textContent).toContain("Nové připojení smaže chat");
    expect(screen.getByTestId("retention-session").textContent).toContain("do konce sezení");
    expect(screen.getByTestId("retention-server").textContent).toContain("zůstávají na serveru");
  });

  it("keeps the server option locked until signed in with a passkey", () => {
    const props = render_();
    const server = screen.getByTestId("retention-server");
    expect(server.textContent).toContain("Vyžaduje přihlášení passkey");
    expect((within(server).getByRole("radio") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(within(screen.getByTestId("retention-session")).getByRole("radio"));
    expect(props.onChange).toHaveBeenCalledWith("session");
  });

  it("unlocks the server option once signed in", () => {
    render_({ account: ACCOUNT, value: "server" });
    expect((within(screen.getByTestId("retention-server")).getByRole("radio") as HTMLInputElement).disabled).toBe(false);
  });
});

describe("account access (the Connection window, 4.0)", () => {
  function render_(over: Record<string, unknown> = {}) {
    const props = {
      account: null as AccountSummary | null,
      status: null,
      supported: true,
      busy: false,
      message: "",
      lang: "cs" as const,
      nickname: "Alice",
      progress: null,
      onSignIn: vi.fn(), onRegister: vi.fn(), onSignOutAndWipe: vi.fn(),
      ...over,
    };
    render(<AccountAccess {...props} />);
    return props;
  }

  it("offers sign-in and registration, and says when the browser cannot", () => {
    const props = render_();
    fireEvent.click(screen.getByTestId("account-signin"));
    fireEvent.click(screen.getByTestId("account-register"));
    expect(props.onSignIn).toHaveBeenCalled();
    expect(props.onRegister).toHaveBeenCalled();

    render_({ supported: false });
    expect((screen.getAllByTestId("account-signin").at(-1) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/nepodporuje passkey/i)).toBeTruthy();
  });

  it("signed in: the username, the nickname as only an alias, and the wipe", () => {
    const props = render_({ account: { ...ACCOUNT, id: "bystry-sokol-7k3q", username: "bystry-sokol-7k3q", keyVerified: true } });
    expect(screen.getByTestId("account-username").textContent).toBe("bystry-sokol-7k3q");
    expect(screen.getByTestId("account-identity-card").textContent).toContain("Alice");
    expect(screen.queryByTestId("account-signin")).toBeNull();
    fireEvent.click(screen.getByTestId("account-signout-wipe"));
    expect(props.onSignOutAndWipe).toHaveBeenCalled();
    // Passkeys are added here, not in the account window.
    expect(screen.getByTestId("account-passkeys")).toBeTruthy();
  });

  it("lists the checked steps and, for an unknown passkey, recommends registering", () => {
    const props = render_({
      progress: {
        kind: "signin",
        steps: [{ id: "passkey", state: "fail", detail: "not registered" }],
        error: { code: "unknown-passkey", message: "This passkey is not registered on this server." },
      },
    });
    const steps = screen.getByTestId("signin-steps");
    expect(steps.querySelector('[data-step="passkey"]')?.getAttribute("data-state")).toBe("fail");
    const err = screen.getByTestId("signin-error");
    expect(err.getAttribute("data-code")).toBe("unknown-passkey");
    expect(err.textContent).toContain("registrovaný není");
    expect(err.textContent).toContain("Zapsáno do logu serveru");
    fireEvent.click(screen.getByTestId("signin-error-register"));
    expect(props.onRegister).toHaveBeenCalled();
  });

  it("says plainly when the key does not open the account's data", () => {
    render_({ progress: { kind: "signin", steps: [{ id: "passkey", state: "ok" }, { id: "key", state: "fail" }], error: { code: "wrong-key", message: "wrong key" } } });
    expect(screen.getByTestId("signin-error").textContent).toContain("neodemyká data účtu");
    expect(screen.queryByTestId("signin-error-register")).toBeNull();
  });
});
