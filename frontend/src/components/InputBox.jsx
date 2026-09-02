import React, { useId, useState } from "react";

const InputBox = ({
  name,
  type,
  placeholder,
  value,
  id,
  icon,
  disable = false,
  autoComplete,
  onChange,
  error,
}) => {
  const [passwordVisible, setPasswordVisible] = useState(false);
  const generatedId = useId();
  const errorId = `${id || name || generatedId}-error`;

  /*
   * Uncontrolled unless a caller passes `onChange`.
   *
   * Most callers read these through `FormData` on submit and pass `value` only
   * to prefill, which is `defaultValue`. Supplying both `value` and
   * `defaultValue` is a React error, so the two modes have to be exclusive
   * rather than merged.
   */
  const isControlled = typeof onChange === "function";

  return (
    <div className="relative w-[100%] mb-4">
      <input
        name={name}
        type={
          type === "password" ? passwordVisible ? "text" : "password" : type
        }
        placeholder={placeholder}
        {...(isControlled ? { value: value ?? "", onChange } : { defaultValue: value })}
        id={id}
        disabled={disable}
        autoComplete={autoComplete || (type === "password" ? "current-password" : "on")}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={`input-box ${error ? "border-red-500 focus:border-red-500" : ""}`}
      />
      <i className={"fi " + icon + " input-icon"}></i>

      {type === "password" ? (
        /*
         * A real button, not an `<i onClick>`.
         *
         * It was an `<i>`: not focusable, no role, no accessible name and no
         * keyboard activation — so on every password field in the app the
         * reveal control existed only for people using a mouse, which is
         * roughly the population least likely to need it. Anyone tabbing
         * through a login form could not reach it at all.
         *
         * `type="button"` is load-bearing: these sit inside forms, and a bare
         * `<button>` defaults to `type="submit"`, so revealing your password
         * would submit the form.
         *
         * `aria-pressed` rather than a label that changes: the control is a
         * toggle, and its state is the thing a screen reader should announce.
         */
        <button
          type="button"
          onClick={() => setPasswordVisible((currentVal) => !currentVal)}
          aria-label={passwordVisible ? "Hide password" : "Show password"}
          aria-pressed={passwordVisible}
          tabIndex={disable ? -1 : 0}
          className="input-icon left-[auto] right-4 cursor-pointer bg-transparent border-none p-0 flex"
        >
          <i
            className={"fi fi-rr-eye" + (!passwordVisible ? "-crossed" : "")}
            aria-hidden="true"
          ></i>
        </button>
      ) : (
        ""
      )}

      {/* Announced, because a field that is only outlined in red tells a
          screen reader nothing. */}
      {error ? (
        <p id={errorId} role="alert" className="mt-1.5 text-sm text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
};

export default InputBox;
