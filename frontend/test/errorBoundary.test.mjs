import assert from "node:assert/strict";
import test from "node:test";
import ErrorBoundary from "../src/components/ErrorBoundary.jsx";
import { mount, withQuietConsole } from "../test-support/helpers.mjs";

/**
 * The boundary exists so that a thrown render is never a blank page. Every
 * assertion here is a restatement of that.
 */

const Healthy = () => <p>healthy tree</p>;
const Throwing = ({ message }) => {
  throw new Error(message);
};

test("healthy children render untouched", async () => {
  const view = await mount(
    <ErrorBoundary>
      <Healthy />
    </ErrorBoundary>
  );
  assert.match(view.text(), /healthy tree/);
  await view.unmount();
});

test("a thrown render is replaced by the fallback, not by nothing", async () => {
  const view = await withQuietConsole(() =>
    mount(
      <ErrorBoundary>
        <Throwing message="kaboom" />
      </ErrorBoundary>
    )
  );

  assert.match(view.text(), /Something broke on our end/);
  // The specific failure this whole component exists to prevent.
  assert.ok(view.text().trim().length > 40, "fallback rendered no meaningful content");
  await view.unmount();
});

test("the fallback announces itself to assistive technology", async () => {
  const view = await withQuietConsole(() =>
    mount(
      <ErrorBoundary>
        <Throwing message="kaboom" />
      </ErrorBoundary>
    )
  );

  const alert = view.container.querySelector('[role="alert"]');
  assert.ok(alert, 'fallback has no role="alert"');
  assert.equal(alert.getAttribute("aria-live"), "assertive");
  await view.unmount();
});

test("the fallback offers a way out", async () => {
  const view = await withQuietConsole(() =>
    mount(
      <ErrorBoundary>
        <Throwing message="kaboom" />
      </ErrorBoundary>
    )
  );

  assert.ok(view.button("Try again"), "no retry action");
  assert.ok(view.button("Go home"), "no way back to the app");
  await view.unmount();
});

test("a chunk failure is reported as a new deploy, not as a crash", async () => {
  const view = await withQuietConsole(() =>
    mount(
      <ErrorBoundary>
        <Throwing message="Failed to fetch dynamically imported module: /assets/x-a1b2.js" />
      </ErrorBoundary>
    )
  );

  assert.match(view.text(), /Gossips just updated/);
  assert.ok(view.button("Reload"), "stale-bundle fallback should offer a reload");
  // Telling someone to come back later for something a reload fixes is the bug
  // this branch exists to avoid.
  assert.doesNotMatch(view.text(), /Something broke on our end/);
  await view.unmount();
});

test("retrying remounts the subtree and recovers once the cause is gone", async () => {
  let failing = true;
  const Flaky = () => {
    if (failing) throw new Error("transient");
    return <p>recovered</p>;
  };

  const view = await withQuietConsole(() =>
    mount(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>
    )
  );
  assert.match(view.text(), /Something broke on our end/);

  failing = false;
  await view.click(view.button("Try again"));

  assert.match(view.text(), /recovered/);
  await view.unmount();
});

test("onReset runs before the retry, so callers can clear the bad state", async () => {
  let resets = 0;
  let failing = true;
  const Flaky = () => {
    if (failing) throw new Error("transient");
    return <p>recovered</p>;
  };

  const view = await withQuietConsole(() =>
    mount(
      <ErrorBoundary
        onReset={() => {
          resets += 1;
          failing = false;
        }}
      >
        <Flaky />
      </ErrorBoundary>
    )
  );

  await view.click(view.button("Try again"));

  assert.equal(resets, 1);
  assert.match(view.text(), /recovered/);
  await view.unmount();
});

test("the error text is not shown in a production build", async () => {
  /*
   * The hooks define `import.meta.env.DEV` as false, matching a production
   * bundle. A stack trace names internal paths and a crash message can carry
   * whatever was being rendered, so neither should reach a user.
   */
  const view = await withQuietConsole(() =>
    mount(
      <ErrorBoundary>
        <Throwing message="SECRET_INTERNAL_DETAIL" />
      </ErrorBoundary>
    )
  );

  assert.doesNotMatch(view.text(), /SECRET_INTERNAL_DETAIL/);
  assert.equal(view.container.querySelector("details"), null);
  await view.unmount();
});
