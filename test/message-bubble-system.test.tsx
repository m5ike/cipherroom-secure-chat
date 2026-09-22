import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { MessageBubble } from "../client/src/components/MessageBubble";

// System notices: fold to the first line after `systemCollapseAfterSec`, unfold
// on hover/click for `systemExpandForSec`, then fold again.

function renderSystem(collapseAfter: number, expandFor: number) {
  return render(
    <MessageBubble
      id="sys-1"
      senderId="system"
      senderName="M5cet"
      mine={false}
      isSystem
      secure={false}
      createdAt={Date.now()}
      timeLabel=""
      text={"Joined room brno-secure.\nSecond line with more detail."}
      onVanish={() => undefined}
      badge={<span>M5cet · 22. září 2026, 14:05</span>}
      lang="cs"
      renderText={(s) => s}
      formatSize={(n) => `${n} B`}
      systemCollapseAfterSec={collapseAfter}
      systemExpandForSec={expandFor}
    />,
  );
}

const bubble = () => screen.getByTestId("message-sys-1").querySelector(".msg-bubble") as HTMLElement;

describe("system message folding", () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("shows everything first, folds after the delay, unfolds on hover, folds back after the expand window", () => {
    vi.useFakeTimers();
    renderSystem(60, 20);
    expect(bubble().dataset.collapsed).toBeUndefined();
    expect(bubble().querySelector(".msg-sys__body")).not.toBeNull();

    act(() => { vi.advanceTimersByTime(60_000); });
    expect(bubble().dataset.collapsed).toBe("1");
    expect(bubble().classList.contains("msg-bubble--sys-collapsed")).toBe(true);

    act(() => { fireEvent.mouseEnter(bubble()); });
    expect(bubble().dataset.collapsed).toBeUndefined();

    act(() => { vi.advanceTimersByTime(19_000); });
    expect(bubble().dataset.collapsed).toBeUndefined(); // still open inside the window
    act(() => { vi.advanceTimersByTime(1_500); });
    expect(bubble().dataset.collapsed).toBe("1"); // faded back

    act(() => { fireEvent.click(bubble()); }); // click unfolds too
    expect(bubble().dataset.collapsed).toBeUndefined();
  });

  it("never folds when the delay is 0 and does not react to hover before folding is armed", () => {
    vi.useFakeTimers();
    renderSystem(0, 20);
    act(() => { vi.advanceTimersByTime(600_000); });
    expect(bubble().dataset.collapsed).toBeUndefined();
    act(() => { fireEvent.mouseEnter(bubble()); vi.advanceTimersByTime(30_000); });
    expect(bubble().dataset.collapsed).toBeUndefined();
  });

  it("does not apply folding to ordinary messages", () => {
    vi.useFakeTimers();
    render(
      <MessageBubble id="m-1" senderId="p1" senderName="Alice" mine={false} isSystem={false} secure createdAt={Date.now()} timeLabel="10:00"
        text="hello" onVanish={() => undefined} badge={<span>Alice</span>} lang="cs" renderText={(s) => s} formatSize={(n) => `${n} B`}
        systemCollapseAfterSec={1} systemExpandForSec={5} />,
    );
    act(() => { vi.advanceTimersByTime(5_000); });
    const b = screen.getByTestId("message-m-1").querySelector(".msg-bubble") as HTMLElement;
    expect(b.dataset.collapsed).toBeUndefined();
    expect(b.querySelector(".msg-sys__body")).toBeNull();
  });
});
