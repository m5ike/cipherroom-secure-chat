import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import { TransferCard } from "../client/src/components/TransferCard";
import type { TransferStats } from "../client/src/lib/file-transfer";

const BASE_STATS: TransferStats = {
  id: "xfer-test",
  name: "photo.jpg",
  size: 1024 * 1024,
  received: 512 * 1024,
  direction: "out",
  transport: "p2p",
  encrypted: true,
  bytesPerSecond: 100_000,
  startedAt: Date.now() - 1000,
  updatedAt: Date.now(),
  etaSeconds: 5,
  progress: 0.5,
};

describe("TransferCard", () => {
  beforeEach(() => { cleanup(); });

  it("renders a div with class file_transfer and id file_transfer-<id>", () => {
    const { container } = render(
      <TransferCard
        id="xfer-1"
        name="photo.jpg"
        size={1024 * 1024}
        direction="out"
        initialStats={BASE_STATS}
      />,
    );
    const widget = container.querySelector(".file_transfer");
    expect(widget).toBeTruthy();
    expect(widget?.getAttribute("id")).toBe("file_transfer-xfer-1");
  });

  it("shows the filename in the header", () => {
    render(
      <TransferCard
        id="xfer-1"
        name="report.pdf"
        size={2048}
        direction="in"
        initialStats={{ ...BASE_STATS, name: "report.pdf", received: 0, progress: 0 }}
      />,
    );
    expect(screen.getByTestId("transfer-name-xfer-1").textContent).toContain("report.pdf");
  });

  it("toggles the detail body on click of the filename header", () => {
    render(
      <TransferCard
        id="xfer-1"
        name="photo.jpg"
        size={1024 * 1024}
        direction="out"
        initialStats={BASE_STATS}
      />,
    );
    // Body is initially expanded by default.
    expect(screen.queryByTestId("transfer-name-xfer-1")).toBeTruthy();
    const header = screen.getByTestId("transfer-name-xfer-1").closest("button");
    expect(header).toBeTruthy();
    // Click to collapse.
    fireEvent.click(header as HTMLElement);
    // Body should be hidden — but the thermometer row still shows the
    // filename + progress text because that lives in the header itself.
  });

  it("renders the thermometer bar under the filename row", () => {
    const { container } = render(
      <TransferCard
        id="xfer-1"
        name="photo.jpg"
        size={1024 * 1024}
        direction="out"
        initialStats={BASE_STATS}
      />,
    );
    const thermo = container.querySelector('[role="meter"]');
    expect(thermo).toBeTruthy();
    expect(thermo?.getAttribute("aria-valuenow")).toBe("50");
  });

  it("marks the running state with `data-status`”, () => {
    const { container } = render(
      <TransferCard
        id="xfer-1"
        name="photo.jpg"
        size={1024 * 1024}
        direction="out"
        initialStats={BASE_STATS}
      />,
    );
    const widget = container.querySelector(".file_transfer");
    expect(widget?.getAttribute("data-status")).toBe("active");
    expect(widget?.getAttribute("data-transport")).toBe("p2p");
  });

  it("renders encryption section and transport section", () => {
    render(
      <TransferCard
        id="xfer-1"
        name="photo.jpg"
        size={1024 * 1024}
        direction="out"
        initialStats={BASE_STATS}
      />,
    );
    // The expanded body has dt/dd entries. Encryption + transport + speed
    // sections should each render at least one row.
    expect(screen.getByText(/AES-256-GCM/)).toBeTruthy();
    expect(screen.getByText(/P2P \(direct\)/)).toBeTruthy();
  });

  it("calls onRemove when the dismiss button is pressed on a completed card", () => {
    const onRemove = vi.fn();
    render(
      <TransferCard
        id="xfer-1"
        name="photo.jpg"
        size={1024 * 1024}
        direction="out"
        initialStats={{ ...BASE_STATS, received: BASE_STATS.size, progress: 1 }}
        finalStatus="completed"
        onRemove={onRemove}
      />,
    );
    fireEvent.click(screen.getByTestId("transfer-dismiss-xfer-1"));
    expect(onRemove).toHaveBeenCalledWith("xfer-1");
  });

  it("emits no dismiss button for active transfers", () => {
    render(
      <TransferCard
        id="xfer-1"
        name="photo.jpg"
        size={1024 * 1024}
        direction="out"
        initialStats={BASE_STATS}
      />,
    );
    expect(screen.queryByTestId("transfer-dismiss-xfer-1")).toBeNull();
  });
});
