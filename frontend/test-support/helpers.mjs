import { act } from "react";
import { createRoot } from "react-dom/client";

/**
 * Mount a tree into a detached container and return it plus a few queries.
 *
 * `act` wraps both the initial render and every interaction, which is what makes
 * assertions safe to write synchronously: without it React may not have
 * committed by the time the next line runs, and the failure looks like a missing
 * element rather than a timing problem.
 */
export const mount = async (node) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(node);
  });

  return {
    container,
    text: () => container.textContent ?? "",
    /** Buttons are matched on their visible label, as a person would find them. */
    button: (label) =>
      Array.from(container.querySelectorAll("button")).find(
        (element) => element.textContent?.trim() === label
      ),
    click: async (element) => {
      await act(async () => {
        element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
};

/**
 * Silence expected console noise for the duration of a callback.
 *
 * An error boundary test *causes* React to log the error it caught — that is the
 * boundary working. Without this the output is dominated by stack traces from
 * passing tests, which trains everyone to ignore the output.
 */
export const withQuietConsole = async (fn) => {
  const { error, warn } = console;
  console.error = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.error = error;
    console.warn = warn;
  }
};
