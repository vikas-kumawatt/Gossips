import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import InputBox from "../src/components/InputBox.jsx";
import { mount } from "../test-support/helpers.mjs";

/**
 * The show/hide password control, and the two adjacent fields on the reset
 * screen where a mismatch is the common mistake.
 *
 * The reveal toggle used to be an `<i onClick>`: no role, no accessible name,
 * not focusable, no keyboard activation. So the one control whose entire job is
 * "let me check what I typed" worked only for people using a mouse.
 */

/** The reveal control, found the way an assistive technology would. */
const toggle = (container) =>
  Array.from(container.querySelectorAll("button")).find((element) =>
    /password/i.test(element.getAttribute("aria-label") || "")
  );

const field = (container) => container.querySelector("input");

test("reveal: the toggle is a real button, not a decorative element", async () => {
  const view = await mount(
    <InputBox name="password" type="password" placeholder="Password" icon="fi-rr-key" />
  );

  const control = toggle(view.container);
  assert.ok(control, "there must be a button a keyboard can reach");
  assert.equal(control.tagName, "BUTTON");
  assert.equal(
    control.getAttribute("type"),
    "button",
    "a bare button inside a form defaults to submit — revealing your password would submit it",
  );
  assert.notEqual(control.tabIndex, -1, "and it must be in the tab order");

  await view.unmount();
});

test("reveal: the toggle announces what it does and what state it is in", async () => {
  const view = await mount(
    <InputBox name="password" type="password" placeholder="Password" icon="fi-rr-key" />
  );

  const control = toggle(view.container);
  assert.match(control.getAttribute("aria-label"), /show password/i);
  assert.equal(control.getAttribute("aria-pressed"), "false");

  await view.click(control);

  assert.match(toggle(view.container).getAttribute("aria-label"), /hide password/i);
  assert.equal(toggle(view.container).getAttribute("aria-pressed"), "true");

  await view.unmount();
});

test("reveal: clicking it actually unmasks the value, and again re-masks it", async () => {
  const view = await mount(
    <InputBox name="password" type="password" placeholder="Password" icon="fi-rr-key" />
  );

  assert.equal(field(view.container).type, "password");
  await view.click(toggle(view.container));
  assert.equal(field(view.container).type, "text");
  await view.click(toggle(view.container));
  assert.equal(field(view.container).type, "password");

  await view.unmount();
});

test("reveal: the eye glyph is hidden from assistive technology", async () => {
  // The button carries the name; the icon repeating it would be read twice.
  const view = await mount(
    <InputBox name="password" type="password" placeholder="Password" icon="fi-rr-key" />
  );

  const glyph = toggle(view.container).querySelector("i");
  assert.equal(glyph.getAttribute("aria-hidden"), "true");

  await view.unmount();
});

test("reveal: non-password fields get no toggle", async () => {
  const view = await mount(
    <InputBox name="email" type="email" placeholder="Email" icon="fi-rr-envelope" />
  );

  assert.equal(toggle(view.container), undefined);
  await view.unmount();
});

test("uncontrolled by default, so callers reading FormData still work", async () => {
  /*
   * `UserAuthForm` passes `value` purely to prefill and reads the field back
   * through `FormData`. Supplying both `value` and `defaultValue` is a React
   * error, so the two modes have to stay exclusive.
   */
  const view = await mount(
    <InputBox name="loginmethod" type="text" placeholder="Username" value="alex" />
  );

  const input = field(view.container);
  assert.equal(input.value, "alex", "prefilled");

  await act(async () => {
    input.value = "alex_edited";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.equal(input.value, "alex_edited", "and still typeable without an onChange");

  await view.unmount();
});

test("error: marks the field, names the message, and announces it", async () => {
  const view = await mount(
    <InputBox
      name="confirmPassword"
      type="password"
      placeholder="Confirm Password"
      icon="fi-rr-key"
      value="typo"
      onChange={() => {}}
      error="Passwords do not match"
    />
  );

  const input = field(view.container);
  assert.equal(input.getAttribute("aria-invalid"), "true");

  const described = input.getAttribute("aria-describedby");
  assert.ok(described, "the message must be tied to the field, not just near it");

  const message = view.container.querySelector(`#${described}`);
  assert.ok(message, "and the id must resolve");
  assert.match(message.textContent, /do not match/i);
  assert.equal(message.getAttribute("role"), "alert");
  assert.match(input.className, /border-red-500/, "and be visible without a screen reader");

  await view.unmount();
});

test("error: absent by default, so an untouched field is not red", async () => {
  const view = await mount(
    <InputBox name="password" type="password" placeholder="Password" icon="fi-rr-key" />
  );

  const input = field(view.container);
  assert.equal(input.getAttribute("aria-invalid"), null);
  assert.equal(input.getAttribute("aria-describedby"), null);
  assert.equal(view.container.querySelector('[role="alert"]'), null);

  await view.unmount();
});

test("error: two fields on one screen get distinct message ids", async () => {
  // Otherwise `aria-describedby` on the second field points at the first one's
  // message, which is worse than having none.
  const view = await mount(
    <form>
      <InputBox name="password" type="password" placeholder="New" error="first problem" />
      <InputBox name="confirmPassword" type="password" placeholder="Confirm" error="second problem" />
    </form>
  );

  const [first, second] = Array.from(view.container.querySelectorAll("input"));
  const firstId = first.getAttribute("aria-describedby");
  const secondId = second.getAttribute("aria-describedby");

  assert.ok(firstId && secondId);
  assert.notEqual(firstId, secondId);
  assert.match(view.container.querySelector(`#${firstId}`).textContent, /first problem/);
  assert.match(view.container.querySelector(`#${secondId}`).textContent, /second problem/);

  await view.unmount();
});
