// The Room window (RoomDialog.tsx): the connection type as tabs, the typed-in
// room on Light · P2P, the saved connections to pick on Server-enhanced (no
// buttons on them), nothing switchable while connected, the gear to My
// connections — and dialogs stacked on top of each other (SimpleModal).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { RoomDialog, RoomTabs, type RoomDialogProps } from "../client/src/components/RoomDialog";
import { SimpleModal } from "../client/src/components/SimpleModal";
import { emptyState, saveProfile, type ConnectionsState } from "../client/src/lib/connections";
import { DEFAULT_CLIENT_CONFIG } from "../client/src/lib/client-config";

const policy = DEFAULT_CLIENT_CONFIG.connections;

function stateWith(...rooms: string[]): ConnectionsState {
  let s = emptyState();
  rooms.forEach((room, i) => {
    const r = saveProfile(s, { label: room.toUpperCase(), room, passphrase: `key-${room}`, userName: "Alice" }, policy, 1_000 + i);
    if (!r.ok) throw new Error(r.error);
    s = r.state;
  });
  return s;
}

function props(over: Partial<RoomDialogProps> = {}): RoomDialogProps {
  return {
    lang: "en",
    tab: "server",
    locked: false,
    joined: false,
    busy: false,
    fields: { name: "Alice", room: "", passphrase: "" },
    onField: vi.fn(),
    saved: { enabled: true, signedIn: true, ready: true, state: stateWith("alpha", "beta"), activeId: null },
    onConnect: vi.fn(),
    onReconnect: vi.fn(),
    onDisconnect: vi.fn(),
    onManage: vi.fn(),
    onCreate: vi.fn(),
    onSignIn: vi.fn(),
    share: <div data-testid="share-slot" />,
    ...over,
  };
}

const items = () => screen.getAllByTestId("room-item");
const itemFor = (label: string) => items().find((el) => el.textContent?.includes(label))!;

beforeEach(() => cleanup());

describe("Room window", () => {
  it("Light · P2P: name, room ID and key typed in; Connect joins them", () => {
    const p = props({ tab: "light" });
    render(<RoomDialog {...p} />);
    expect(screen.getByTestId("input-name")).toBeTruthy();
    expect(screen.getByTestId("input-room")).toBeTruthy();
    expect((screen.getByTestId("input-passphrase") as HTMLInputElement).type).toBe("password");
    fireEvent.click(screen.getByTestId("room-key-toggle"));
    expect((screen.getByTestId("input-passphrase") as HTMLInputElement).type).toBe("text");
    expect(screen.queryByTestId("room-list")).toBeNull();
    fireEvent.click(screen.getByTestId("button-connect"));
    expect(p.onConnect).toHaveBeenCalledWith({ kind: "manual" });
    // Connect / Disconnect / Share are there on either tab.
    expect(screen.getByTestId("share-slot")).toBeTruthy();
  });

  it("Server-enhanced: the saved connections to pick, without buttons of their own", () => {
    const p = props();
    render(<RoomDialog {...p} />);
    expect(items()).toHaveLength(2);
    for (const el of items()) expect(within(el).queryAllByRole("button")).toHaveLength(0);
    for (const id of ["cx-connect", "cx-edit", "cx-delete", "cx-share"]) expect(screen.queryByTestId(id)).toBeNull();
    // The first one saved is the default, and it is picked.
    expect(itemFor("ALPHA").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(itemFor("BETA"));
    expect(itemFor("BETA").getAttribute("aria-checked")).toBe("true");
    expect(itemFor("ALPHA").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("button-connect").textContent).toContain("BETA");
    fireEvent.click(screen.getByTestId("button-connect"));
    const id = p.saved.state.profiles.find((x) => x.room === "beta")!.id;
    expect(p.onConnect).toHaveBeenCalledWith({ kind: "profile", id });
  });

  it("\"another room\" shows the fields and connects them in server mode", () => {
    const p = props();
    render(<RoomDialog {...p} />);
    expect(screen.queryByTestId("room-manual-fields")).toBeNull();
    fireEvent.click(screen.getByTestId("room-item-manual"));
    expect(screen.getByTestId("room-manual-fields")).toBeTruthy();
    fireEvent.click(screen.getByTestId("button-connect"));
    expect(p.onConnect).toHaveBeenCalledWith({ kind: "manual" });
  });

  it("while connected nothing switches; Disconnect frees it; the main button reconnects", () => {
    const state = stateWith("alpha", "beta");
    const active = state.profiles.find((x) => x.room === "beta")!.id;
    const p = props({ locked: true, joined: true, saved: { enabled: true, signedIn: true, ready: true, state, activeId: active } });
    const { rerender } = render(<RoomDialog {...p} />);
    expect(itemFor("BETA").getAttribute("aria-checked")).toBe("true");
    expect(within(itemFor("BETA")).getByTestId("room-item-live")).toBeTruthy();
    expect((itemFor("ALPHA") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("room-item-manual") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(itemFor("ALPHA"));
    expect(itemFor("ALPHA").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("room-locked")).toBeTruthy();

    fireEvent.click(screen.getByTestId("button-connect"));
    expect(p.onReconnect).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("button-disconnect"));
    expect(p.onDisconnect).toHaveBeenCalled();

    rerender(<RoomDialog {...p} locked={false} joined={false} />);
    expect((itemFor("ALPHA") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId("button-disconnect")).toBeNull();
    fireEvent.click(itemFor("ALPHA"));
    expect(itemFor("ALPHA").getAttribute("aria-checked")).toBe("true");
  });

  it("the gear opens My connections; a connection made there comes back picked", () => {
    const p = props();
    const { rerender } = render(<RoomDialog {...p} />);
    fireEvent.click(screen.getByTestId("room-manage"));
    expect(p.onManage).toHaveBeenCalled();
    const r = saveProfile(p.saved.state, { label: "Gamma", room: "gamma", passphrase: "k", userName: "A" }, policy, 5_000);
    if (!r.ok) throw new Error(r.error);
    rerender(<RoomDialog {...p} saved={{ ...p.saved, state: r.state }} />);
    expect(itemFor("Gamma").getAttribute("aria-checked")).toBe("true");
  });

  it("no saved connection yet: an invitation to create one; signed out: only the way to sign in", () => {
    const p = props({ saved: { enabled: true, signedIn: true, ready: true, state: emptyState(), activeId: null } });
    const { rerender } = render(<RoomDialog {...p} />);
    fireEvent.click(screen.getByTestId("room-create"));
    expect(p.onCreate).toHaveBeenCalled();
    // Nothing saved: "another room" is the pick, so the fields are there.
    expect(screen.getByTestId("room-manual-fields")).toBeTruthy();

    // Signed out, Server-enhanced needs a passkey sign-in: no fields, no
    // Connect — only the way to the Connection window (4.0).
    rerender(<RoomDialog {...p} saved={{ ...p.saved, signedIn: false }} />);
    fireEvent.click(screen.getByTestId("room-need-open"));
    expect(p.onSignIn).toHaveBeenCalled();
    expect(screen.queryByTestId("room-manual-fields")).toBeNull();
    expect((screen.getByTestId("button-connect") as HTMLButtonElement).disabled).toBe(true);
  });

  it("the tabs: arrow keys switch, and the other tab is disabled while connected", () => {
    const onTab = vi.fn();
    const { rerender } = render(<RoomTabs lang="en" tab="light" locked={false} onTab={onTab} />);
    fireEvent.keyDown(screen.getByTestId("room-tabs"), { key: "ArrowRight" });
    expect(onTab).toHaveBeenCalledWith("server");
    rerender(<RoomTabs lang="en" tab="light" locked onTab={onTab} />);
    expect((screen.getByTestId("room-tab-server") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("room-tab-light").getAttribute("aria-selected")).toBe("true");
  });
});

describe("stacked dialogs", () => {
  it("Escape closes only the one on top; the one above dims the screen less", () => {
    const closeRoom = vi.fn();
    const closeManage = vi.fn();
    render(
      <>
        <SimpleModal title="Room" onClose={closeRoom} testId="m-room"><p>room</p></SimpleModal>
        <SimpleModal title="My connections" onClose={closeManage} testId="m-manage"><p>list</p></SimpleModal>
      </>,
    );
    expect(screen.getByTestId("m-manage").className).toContain("modal-root--stacked");
    expect(screen.getByTestId("m-room").className).not.toContain("modal-root--stacked");
    // Rendered into <body>, not inside whatever opened them.
    expect(screen.getByTestId("m-manage").parentElement).toBe(document.body);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(closeManage).toHaveBeenCalledTimes(1);
    expect(closeRoom).not.toHaveBeenCalled();
  });

  it("a custom header takes the title's place and the title stays the dialog's name", () => {
    render(<SimpleModal title="Room" onClose={() => {}} header={<span data-testid="custom-head" />}><p>x</p></SimpleModal>);
    expect(screen.getByTestId("custom-head")).toBeTruthy();
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("Room");
    expect(screen.queryByRole("heading", { name: "Room" })).toBeNull();
  });
});
