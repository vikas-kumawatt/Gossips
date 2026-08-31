import React, { useContext, useEffect, useRef, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import axios from "axios";
import { AnimatePresence, motion as Motion, useReducedMotion } from "framer-motion";
import { Toaster, toast } from "react-hot-toast";
import { Loader2 } from "lucide-react";

import OtpInput from "../components/OtpInput";
import { Icons } from "../components/icons";
import { UserContext } from "../contexts/UserContext";
import { persistUser } from "../services/authSession";

/*
 * Where the in-progress signup lives across a reload.
 *
 * `sessionStorage`, not `localStorage`: the ticket is scoped to this signup and
 * this tab, and it should not outlive either. It is deliberately not a login —
 * the server refuses it on every route but the two below — but it is still the
 * thing that finishes creating an account, so it gets the shortest life that
 * keeps a refresh from stranding the user.
 */
const STORAGE_KEY = "gossips:pending-verification";

const readStored = () => {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    // Private mode, or a half-written value. Either way there is no session to
    // resume, and the guard below sends them back to signup.
    return null;
  }
};

const writeStored = (session) => {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Not fatal: the flow still works, a reload just loses it.
  }
};

const clearStored = () => {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
};

const mmss = (totalSeconds) => {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

const VerifyOtpPage = () => {
  const { setUserAuth } = useContext(UserContext);
  const navigate = useNavigate();
  const location = useLocation();
  const reduceMotion = useReducedMotion();

  /*
   * Navigation state on the way in, sessionStorage on a reload.
   *
   * Read once, in an initialiser, so a re-render can't reach back to a
   * `location.state` that React Router has already replaced.
   *
   * `verified` is the tombstone for a history entry whose signup is finished.
   * Success clears sessionStorage, but `location.state` lives in the history
   * entry and survives — so pressing Back would otherwise re-read the spent
   * ticket, write it to storage again, and show the OTP form for an account that
   * already exists.
   */
  const [session, setSession] = useState(() => {
    const incoming = location.state?.verificationToken ? location.state : null;
    if (incoming && !incoming.verified) return { ...incoming, sentAt: Date.now() };
    return readStored();
  });

  /*
   * Persisting is an effect, not part of the initialiser above: a render-phase
   * write runs twice under StrictMode and, worse, would run before the guard
   * that decides this page should not be shown at all.
   */
  useEffect(() => {
    if (session?.verificationToken) writeStored(session);
  }, [session]);

  const [code, setCode] = useState("");
  const [status, setStatus] = useState("idle"); // idle | error | success
  const [errorNonce, setErrorNonce] = useState(0);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [sentAt, setSentAt] = useState(session?.sentAt ?? Date.now());
  const [now, setNow] = useState(Date.now());

  /*
   * Every timeout this page starts, so unmounting cancels them. The success path
   * navigates on a delay to let the animation finish, and a user who hits Back
   * in that second must not be yanked forward again.
   */
  const timers = useRef(new Set());
  const later = (fn, ms) => {
    const id = setTimeout(() => {
      timers.current.delete(id);
      fn();
    }, ms);
    timers.current.add(id);
  };
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  /*
   * One ticking clock, and both countdowns derived from it against a fixed
   * origin. Decrementing two counters instead would drift, and would be wrong
   * outright after a background tab is throttled — this just catches up.
   */
  useEffect(() => {
    if (status === "success") return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status]);

  if (!session?.verificationToken) {
    return <Navigate to="/signup" replace />;
  }

  const {
    verificationToken,
    email,
    codeLength = 6,
    expiresInSeconds = 600,
    resendAfterSeconds = 60,
    addingAccount = false,
    // Where the person was headed before they were sent to sign in. Carried
    // through by UserAuthForm so a group-invite link still survives a signup
    // that now has an extra screen in the middle of it.
    from = null,
  } = session;

  const resendIn = Math.max(0, Math.ceil((sentAt + resendAfterSeconds * 1000 - now) / 1000));
  const codeExpiresIn = Math.max(0, Math.ceil((sentAt + expiresInSeconds * 1000 - now) / 1000));

  const abandon = (text, to) => {
    clearStored();
    toast.error(text);
    navigate(to, { replace: true });
  };

  const handleVerify = async (submitted) => {
    if (submitting || status === "success") return;
    if (submitted.length !== codeLength) {
      setStatus("error");
      setErrorNonce((n) => n + 1);
      setMessage(`Enter all ${codeLength} digits.`);
      return;
    }

    setSubmitting(true);
    setMessage("");

    try {
      const { data } = await axios.post(
        `${import.meta.env.VITE_SERVER}/auth/verify-otp`,
        { token: verificationToken, code: submitted },
        { withCredentials: true },
      );

      setStatus("success");
      setMessage("");
      clearStored();

      /*
       * Tombstone this history entry, so Back can't resurrect the spent ticket
       * out of `location.state`. `replace` rather than a push: the OTP screen
       * should not be somewhere you can return to at all.
       */
      navigate(location.pathname, { replace: true, state: { verified: true } });

      // Only now is there a token. Everything before this point deliberately
      // left the client signed out.
      persistUser(data);
      setUserAuth((previous) => ({ ...previous, ...data, token: data.token }));

      later(
        () => {
          /*
           * Adding a second account is a hard navigation, matching the switcher
           * and the login form: every provider, socket and cache in memory
           * belongs to the account we just left.
           */
          if (addingAccount) {
            window.location.assign(from || "/profile-setup");
            return;
          }
          // A brand-new account always goes to profile setup; `from` is where
          // they were originally headed and is honoured after that, the same way
          // the login form honours it.
          navigate("/profile-setup", {
            replace: true,
            state: { from: "email-verification", newUser: true, next: from },
          });
        },
        reduceMotion ? 250 : 1200,
      );
    } catch (error) {
      const data = error.response?.data;

      // The ticket is gone, or points at something that can no longer be
      // verified. Nothing on this page can recover from either.
      if (data?.expired) {
        abandon(data.error || "That verification link has expired.", "/signup");
        return;
      }
      if (data?.alreadyVerified) {
        abandon(data.error || "This email is already verified.", "/login");
        return;
      }

      setStatus("error");
      setErrorNonce((n) => n + 1);
      setMessage(data?.error || "Couldn't check that code. Please try again.");

      // Clear after the shake, not before it — emptying the boxes first makes
      // the animation land on a field that no longer shows what was wrong.
      later(() => setCode(""), reduceMotion ? 0 : 500);
    } finally {
      setSubmitting(false);
    }
  };

  const handleResend = async () => {
    if (resending || resendIn > 0 || status === "success") return;

    setResending(true);
    try {
      const { data } = await axios.post(
        `${import.meta.env.VITE_SERVER}/auth/resend-otp`,
        { token: verificationToken },
        { withCredentials: true },
      );

      const freshlySentAt = Date.now();
      setSentAt(freshlySentAt);
      const nextSession = {
        ...session,
        sentAt: freshlySentAt,
        ...(data?.verificationToken ? { verificationToken: data.verificationToken } : {}),
      };
      setSession(nextSession);
      writeStored(nextSession);
      setErrorNonce(0);
      setCode("");
      setStatus("idle");
      setMessage("");
      toast.success(data?.message || "A new code is on its way");
    } catch (error) {
      const data = error.response?.data;

      if (data?.expired) {
        abandon(data.error || "That verification link has expired.", "/signup");
        return;
      }
      if (data?.alreadyVerified) {
        abandon(data.error || "This email is already verified.", "/login");
        return;
      }

      /*
       * The server's cooldown is the real one — ours is a countdown drawn from
       * when *this tab* last sent. They disagree after a reload, or when the
       * same signup is open twice. Rewinding the origin so the button unlocks
       * exactly when the server says is simpler than tracking both, and it is
       * persisted so a reload doesn't restore the optimistic value and earn
       * another 429.
       */
      if (typeof data?.retryAfter === "number") {
        const corrected = Date.now() - (resendAfterSeconds - data.retryAfter) * 1000;
        setSentAt(corrected);
        const nextSession = { ...session, sentAt: corrected };
        setSession(nextSession);
        writeStored(nextSession);
      }

      toast.error(data?.error || "Couldn't send a new code. Please try again.");
    } finally {
      setResending(false);
    }
  };

  const codeHasExpired = codeExpiresIn === 0 && status !== "success";

  return (
    <section className="relative flex h-screen w-full items-center justify-center bg-neutral-950">
      <Toaster />

      <div className="flex w-[85%] max-w-[420px] flex-col items-center">
        <Icons.logo className="mx-auto mb-4 h-20 w-20" />

        <AnimatePresence mode="wait" initial={false}>
          {status === "success" ? (
            <Motion.div
              key="verified"
              className="flex flex-col items-center"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.3 }}
            >
              <Motion.svg
                viewBox="0 0 52 52"
                className="mb-4 h-20 w-20"
                initial={reduceMotion ? false : { scale: 0.6 }}
                animate={{ scale: 1 }}
                transition={{ type: "spring", stiffness: 260, damping: 16 }}
                aria-hidden="true"
              >
                <Motion.circle
                  cx="26"
                  cy="26"
                  r="23"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  className="text-emerald-500"
                  initial={reduceMotion ? false : { pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ duration: reduceMotion ? 0 : 0.45, ease: "easeOut" }}
                />
                <Motion.path
                  d="M15 27 L23 34 L38 19"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-emerald-400"
                  initial={reduceMotion ? false : { pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{
                    duration: reduceMotion ? 0 : 0.35,
                    delay: reduceMotion ? 0 : 0.4,
                    ease: "easeOut",
                  }}
                />
              </Motion.svg>

              <h1 className="mb-1 text-center font-bold text-white">Email confirmed</h1>
              <p className="text-center text-sm text-neutral-400">
                Taking you to your profile…
              </p>
            </Motion.div>
          ) : (
            <Motion.div
              key="entry"
              className="flex w-full flex-col items-center"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={{ duration: reduceMotion ? 0 : 0.25 }}
            >
              <h1 className="mb-2 text-center font-bold text-white">Confirm your email</h1>
              <p className="mb-6 text-center text-sm text-neutral-400">
                We sent a {codeLength}-digit code to{" "}
                <span className="text-white">{email}</span>
              </p>

              <OtpInput
                value={code}
                onChange={(next) => {
                  setCode(next);
                  // Any edit clears the last failure, so the red borders belong
                  // to the code on screen rather than to one already retyped.
                  if (status === "error") {
                    setStatus("idle");
                    setMessage("");
                  }
                }}
                onComplete={handleVerify}
                length={codeLength}
                disabled={submitting}
                status={status}
                errorNonce={errorNonce}
              />

              {/* Announced, because a wrong code is otherwise conveyed only by
                  a colour and a movement. */}
              <p
                role="status"
                aria-live="polite"
                className={`mt-4 min-h-[20px] text-center text-sm ${
                  status === "error" ? "text-red-400" : "text-neutral-500"
                }`}
              >
                {message ||
                  (codeHasExpired
                    ? "That code has expired — ask for a new one."
                    : `Code expires in ${mmss(codeExpiresIn)}`)}
              </p>

              <button
                type="button"
                onClick={() => handleVerify(code)}
                disabled={submitting || code.length !== codeLength}
                className="mt-4 flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-transparent bg-white p-4 font-medium text-black disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Verifying...
                  </>
                ) : (
                  "Verify email"
                )}
              </button>

              <button
                type="button"
                onClick={handleResend}
                disabled={resending || resendIn > 0}
                className="cursor-pointer pt-4 text-neutral-500 disabled:cursor-not-allowed hover:text-neutral-300 disabled:hover:text-neutral-500"
              >
                {resending
                  ? "Sending..."
                  : resendIn > 0
                    ? `Resend code in ${resendIn}s`
                    : "Resend code"}
              </button>

              <Link
                to="/signup"
                onClick={clearStored}
                className="pt-4 text-sm text-white"
              >
                Wrong email? Start over
              </Link>
            </Motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="absolute bottom-4 mx-6 flex flex-wrap items-center justify-center gap-4 text-nowrap text-sm text-neutral-500">
        <p>© {new Date().getFullYear()}</p>
        <Link to="/terms" className="transition-colors hover:text-white">
          Gossips Terms
        </Link>
        <Link to="/privacy" className="transition-colors hover:text-white">
          Privacy Policy
        </Link>
      </div>
    </section>
  );
};

export default VerifyOtpPage;
