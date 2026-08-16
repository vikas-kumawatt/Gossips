import React from "react";
import ErrorScreen from "./ErrorScreen";

/**
 * The only thing standing between a thrown render and a blank page.
 *
 * React unmounts the whole tree when a render, lifecycle or constructor throws
 * and no boundary catches it. There were none, so any such error — a null
 * dereference on a field an endpoint stopped returning, say — replaced the
 * entire app with an empty `<div id="root">`, with nothing on screen to explain
 * it and no way back except the browser's reload button.
 *
 * A boundary has to be a class. Hooks have no equivalent of
 * `getDerivedStateFromError`, in React 19 as in every version before it, and the
 * `onCaughtError` root option added in 19 is a reporting hook rather than a way
 * to render a fallback.
 *
 * ── What this does not catch ────────────────────────────────────────────────
 *
 * Errors thrown in event handlers, in `setTimeout`, in promises, and during
 * server rendering. React does not route those here, deliberately: they do not
 * corrupt the rendered tree, so tearing it down would be an overreaction. Those
 * surface as toasts from the calling code, which is where the context is. Also
 * not caught: a failure to load the bundle at all, since no React runs — see the
 * static fallback inside `#root` in index.html.
 */

/*
 * A chunk that 404s almost always means a deploy replaced the files this tab was
 * built against, not that anything is broken. Every bundler and browser words it
 * differently, hence the list. Reloading fixes it, so it gets its own copy.
 */
const STALE_BUNDLE = new RegExp(
  [
    "loading chunk",
    "loading css chunk",
    "failed to fetch dynamically imported module",
    "error loading dynamically imported module",
    "importing a module script failed",
    "'text/html' is not a valid javascript mime type",
  ].join("|"),
  "i"
);

const isStaleBundle = (error) =>
  Boolean(error?.message && STALE_BUNDLE.test(error.message));

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.handleRetry = this.handleRetry.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    /*
     * Logged with the component stack, which is the part that actually locates
     * the fault — an error's own stack points into the bundled React internals
     * that called the component, not at the component.
     *
     * This is the seam for a reporting service. If one is ever added, it goes
     * here, and it should send `error` and `info.componentStack` and nothing
     * else: props and state on this app routinely hold message bodies and
     * profile data.
     */
    console.error(
      `[ErrorBoundary${this.props.label ? `: ${this.props.label}` : ""}]`,
      error,
      info?.componentStack
    );
  }

  handleRetry() {
    /*
     * Clearing the error remounts the subtree. Worth trying first — a crash
     * caused by one bad response often survives a re-render — and if it throws
     * again the boundary simply catches it again and the person can reload
     * instead. `onReset` lets a caller drop whatever state caused it.
     */
    this.props.onReset?.();
    this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <ErrorScreen
        variant={isStaleBundle(error) ? "stale" : "crash"}
        error={error}
        onRetry={this.handleRetry}
      />
    );
  }
}

export default ErrorBoundary;
