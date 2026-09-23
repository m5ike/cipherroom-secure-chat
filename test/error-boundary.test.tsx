// A component that throws while rendering must not take the page (and the
// conversation) with it: the boundary shows what happened and a way back.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { useState } from "react";
import { ErrorBoundary, isStaleChunk } from "../client/src/components/ErrorBoundary";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Bomb({ error }: { error: Error | null }) {
  if (error) throw error;
  return <p>all good</p>;
}

describe("the error boundary", () => {
  it("replaces a crashed dialog only, and lets it try again", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    function Harness() {
      const [error, setError] = useState<Error | null>(new Error("boom"));
      return (
        <div>
          <p>chat stays</p>
          <button type="button" onClick={() => setError(null)}>fix</button>
          <ErrorBoundary scope="panel"><Bomb error={error} /></ErrorBoundary>
        </div>
      );
    }
    render(<Harness />);
    expect(screen.getByTestId("error-panel")).toBeTruthy();
    expect(screen.getByText("chat stays")).toBeTruthy();
    fireEvent.click(screen.getByText("fix"));
    fireEvent.click(screen.getByRole("button", { name: /znovu|again|erneut/i }));
    expect(screen.getByText("all good")).toBeTruthy();
  });

  it("offers a reload for the whole page, and names a deploy as the cause", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<ErrorBoundary scope="app"><Bomb error={new TypeError("Failed to fetch dynamically imported module: /assets/AccountPanel.x.js")} /></ErrorBoundary>);
    expect(screen.getByTestId("error-page").textContent).toMatch(/nová verze|new version|neue Version/);
    expect(isStaleChunk(new Error("Importing a module script failed."))).toBe(true);
    expect(isStaleChunk(new Error("x is undefined"))).toBe(false);
  });
});
