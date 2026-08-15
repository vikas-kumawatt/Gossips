import React, { useEffect, useRef } from "react";
import { motion as Motion, useAnimationControls, useReducedMotion } from "framer-motion";

/**
 * A row of single-character boxes that behaves like one field.
 *
 * The value is a single string and stays *dense* — no gaps. That is the invariant
 * everything else here protects, because the alternative (an array of per-box
 * values) means "1_3" has to be joined into something, and every join either
 * silently shifts the 3 left or submits a code with a hole in it. So a click on a
 * box beyond the end of the code is redirected to the first empty one, and a
 * backspace only ever removes from the end.
 *
 * @param {string}   value       current code, 0..length digits
 * @param {Function} onChange    called with the next value
 * @param {Function} onComplete  called with the value once it reaches `length`
 * @param {"idle"|"error"|"success"} status  drives the border colour
 * @param {number}   errorNonce  bump to replay the shake; see the effect below
 */
const OtpInput = ({
  value = "",
  onChange,
  onComplete,
  length = 6,
  disabled = false,
  status = "idle",
  errorNonce = 0,
  autoFocus = true,
  label = "Verification code",
}) => {
  const inputsRef = useRef([]);
  const reduceMotion = useReducedMotion();
  const shake = useAnimationControls();

  const digits = Array.from({ length }, (_, i) => value[i] ?? "");

  const focusAt = (index) => {
    const target = inputsRef.current[Math.max(0, Math.min(index, length - 1))];
    target?.focus();
    // Chrome puts the caret before the existing character, so a keystroke meant
    // to replace a digit inserts alongside it instead.
    target?.select?.();
  };

  useEffect(() => {
    if (autoFocus && !disabled) focusAt(value.length);
    // Mount only. Re-running this per keystroke would fight the caret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * Driven imperatively off a counter rather than declaratively off `status`.
   *
   * A second wrong code leaves `status` at "error", so a declarative `animate`
   * would not re-fire and the field would look dead on exactly the attempt the
   * user most needs feedback for. Remounting via `key` replays it but destroys
   * focus and the refs on every render, which is worse.
   */
  useEffect(() => {
    if (!errorNonce || reduceMotion) return;
    shake.start({
      x: [0, -9, 9, -7, 7, -3, 3, 0],
      transition: { duration: 0.45, ease: "easeInOut" },
    });
  }, [errorNonce, reduceMotion, shake]);

  /** Writes `chars` starting at `index`, keeping the value dense. */
  const write = (index, chars) => {
    const clean = String(chars).replace(/\D/g, "");
    if (!clean) return;

    const next = digits.slice();
    for (let i = 0; i < clean.length && index + i < length; i += 1) {
      next[index + i] = clean[i];
    }

    // Safe to join: the value had no gaps before this, and the write fills a
    // contiguous run starting at a position that was already reachable.
    const joined = next.join("").slice(0, length);
    onChange(joined);
    focusAt(index + clean.length);

    if (joined.length === length) onComplete?.(joined);
  };

  const handleChange = (index) => (event) => {
    const raw = event.target.value.replace(/\D/g, "");

    /*
     * Typing into a box that already holds a digit hands back both of them, and
     * which side the new one lands on depends on where the caret was. Only the
     * new character is meant — writing both would overwrite the next box.
     *
     * Pastes never reach here (onPaste preempts them) and an OS autofill lands
     * in an empty first box, so neither is affected by this.
     */
    let chars = raw;
    if (raw.length > 1 && digits[index]) {
      if (raw[0] === digits[index]) chars = raw.slice(1);
      else if (raw[raw.length - 1] === digits[index]) chars = raw.slice(0, -1);
    }

    write(index, chars);
  };

  const handleKeyDown = (index) => (event) => {
    if (event.key === "Backspace") {
      event.preventDefault();
      if (digits[index]) {
        onChange(value.slice(0, index) + value.slice(index + 1));
        focusAt(index);
      } else if (index > 0) {
        // Empty box: eat the previous digit and step back, which is what every
        // OTP field does and what a plain input would not.
        onChange(value.slice(0, index - 1) + value.slice(index));
        focusAt(index - 1);
      }
      return;
    }

    if (event.key === "Delete") {
      event.preventDefault();
      onChange(value.slice(0, index) + value.slice(index + 1));
      return;
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      focusAt(index - 1);
      return;
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      focusAt(index + 1);
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      focusAt(0);
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      focusAt(value.length);
      return;
    }

    // Not inside a <form>, so Enter has no default to rely on — and pressing it
    // is what anyone who typed the last digit and saw nothing happen will try.
    if (event.key === "Enter" && value.length === length) {
      event.preventDefault();
      onComplete?.(value);
    }
  };

  const handlePaste = (event) => {
    const pasted = event.clipboardData?.getData("text") ?? "";
    if (!/\d/.test(pasted)) return;
    // Always from the start. Someone pasting a whole code has not thought about
    // which box the caret was in, and honouring it would truncate the code.
    event.preventDefault();
    write(0, pasted);
  };

  const handleFocus = (index) => () => {
    if (index > value.length) focusAt(value.length);
  };

  const borderFor = (index) => {
    if (status === "error") return "border-red-500";
    if (status === "success") return "border-emerald-500";
    return digits[index] ? "border-neutral-500" : "border-neutral-700";
  };

  return (
    <Motion.div
      role="group"
      aria-label={label}
      className="flex justify-center gap-2 sm:gap-3"
      animate={shake}
    >
      {digits.map((digit, index) => (
        <Motion.input
          key={index}
          ref={(element) => {
            inputsRef.current[index] = element;
          }}
          value={digit}
          onChange={handleChange(index)}
          onKeyDown={handleKeyDown(index)}
          onPaste={handlePaste}
          onFocus={handleFocus(index)}
          disabled={disabled}
          type="text"
          /*
           * `inputMode` rather than `type="number"`: a number input raises the
           * right keypad but also accepts "e", "+" and "-", and its spinners
           * overlap a box this narrow.
           */
          inputMode="numeric"
          pattern="[0-9]*"
          /*
           * iOS and Android offer the emailed code above the keyboard from this
           * alone. Only the first box gets it — on all six, the OS fills each
           * one with the whole code.
           */
          autoComplete={index === 0 ? "one-time-code" : "off"}
          // Not 1: an autofilled six-digit code arrives as one change event on
          // the first box, and a maxLength of 1 would truncate it to "1".
          maxLength={length}
          aria-label={`Digit ${index + 1} of ${length}`}
          animate={status === "success" && !reduceMotion ? { scale: [1, 1.08, 1] } : { scale: 1 }}
          transition={{ duration: 0.3, delay: reduceMotion ? 0 : index * 0.04 }}
          className={`h-14 w-11 rounded-xl border bg-neutral-800 text-center text-2xl font-semibold text-white caret-white outline-0 transition-colors focus:border-neutral-400 disabled:opacity-50 sm:h-16 sm:w-14 ${borderFor(index)}`}
        />
      ))}
    </Motion.div>
  );
};

export default OtpInput;
