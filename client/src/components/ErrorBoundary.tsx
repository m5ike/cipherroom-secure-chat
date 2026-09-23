// When a component throws while rendering, React unmounts the whole tree —
// a blank page, and the conversation with it. The boundary keeps what it
// can: around the app it offers a reload (and says so plainly when the
// cause is a deploy that removed the old code chunks); around a dialog it
// replaces only the dialog's content.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { detectLang, t } from "../lib/i18n";
import { loadPreferences } from "../lib/preferences";

type Props = {
  children: ReactNode;
  /** "app": the whole page; "panel": one dialog or panel. */
  scope?: "app" | "panel";
};
type State = { error: Error | null };

/** A chunk of the previous build is gone after a deploy. */
export function isStaleChunk(error: unknown): boolean {
  const msg = String((error as Error)?.message ?? error);
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported|Loading chunk .* failed/i.test(msg);
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[m5cet] render failed:", error, info.componentStack);
  }

  private lang() {
    try { return detectLang(loadPreferences().lang); } catch { return detectLang(undefined); }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const lang = this.lang();
    const stale = isStaleChunk(error);
    const reload = () => window.location.reload();
    const retry = () => this.setState({ error: null });

    if (this.props.scope === "panel") {
      return (
        <div role="alert" className="error-panel" data-testid="error-panel">
          <p>{t(lang, stale ? "error.newVersion" : "error.panel")}</p>
          <div className="error-actions">
            {stale ? <button type="button" onClick={reload}>{t(lang, "error.reload")}</button> : <button type="button" onClick={retry}>{t(lang, "error.retry")}</button>}
          </div>
        </div>
      );
    }
    return (
      <main role="alert" className="error-page" data-testid="error-page">
        <h1>{t(lang, stale ? "error.newVersion" : "error.title")}</h1>
        {!stale ? <p>{t(lang, "error.body")}</p> : null}
        <div className="error-actions">
          <button type="button" onClick={reload}>{t(lang, "error.reload")}</button>
          {!stale ? <button type="button" onClick={retry}>{t(lang, "error.retry")}</button> : null}
        </div>
        <details>
          <summary>{t(lang, "error.details")}</summary>
          <pre>{error.message}</pre>
        </details>
      </main>
    );
  }
}
