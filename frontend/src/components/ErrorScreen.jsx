// Aliased to a capitalised name, as OtpInput.jsx does: ESLint here has no
// eslint-plugin-react, so it cannot see `<Motion.div>` as a use of `motion` and
// reports the import as unused. `varsIgnorePattern: '^[A-Z_]'` exempts `Motion`.
import { motion as Motion, useReducedMotion } from "framer-motion";
import { LOGO_PATHS, LOGO_VIEWBOX } from "../lib/brand";

/**
 * What a person sees when the app has crashed.
 *
 * Deliberately not a route and deliberately router-free: the outermost boundary
 * sits above `<BrowserRouter>` in main.jsx, so `useNavigate` is not available to
 * it. Navigation here is a full page load, which is the right behaviour anyway —
 * whatever state produced the crash is gone afterwards, which a client-side
 * transition would preserve.
 *
 * Two variants, because the two failures need different things from the reader:
 *
 *   crash — a render threw. Nothing the person did, nothing they can fix.
 *   stale — a chunk 404'd, which in practice means a deploy replaced the files
 *           this tab was built against. Reloading genuinely fixes it, and
 *           telling someone to "come back later" for a problem solved by a
 *           button they are already looking at would be a lie.
 */

const COPY = {
  crash: {
    title: "Something broke on our end",
    body: "This isn't anything you did. The problem has been logged and we're looking at it — try again, or come back in a little while.",
    primary: "Try again",
  },
  stale: {
    title: "Gossips just updated",
    body: "A new version shipped while this tab was open, so part of the app is missing. One reload picks it up.",
    primary: "Reload",
  },
};

/**
 * Three dots that pulse like a typing indicator and then stall.
 *
 * The stall is the point. A steady pulse reads as "working on it" and sets an
 * expectation this screen cannot meet; stopping for a beat every cycle reads as
 * something that has stopped, which is what has happened.
 */
const StalledDots = ({ animate }) => (
  <div className="flex items-center gap-1.5" aria-hidden="true">
    {[0, 1, 2].map((index) => (
      <Motion.span
        key={index}
        className="block h-1.5 w-1.5 rounded-full bg-neutral-600"
        animate={animate ? { opacity: [0.25, 1, 0.25, 0.25, 0.25] } : undefined}
        transition={
          animate
            ? {
                duration: 2.4,
                times: [0, 0.15, 0.3, 0.6, 1],
                repeat: Infinity,
                delay: index * 0.12,
                ease: "easeInOut",
              }
            : undefined
        }
      />
    ))}
  </div>
);

const ErrorScreen = ({ variant = "crash", error, onRetry }) => {
  /*
   * Honoured rather than assumed. Vestibular disorders make looping scale and
   * float animations genuinely unpleasant, and someone meeting this screen is
   * already having a bad time.
   */
  const reduceMotion = useReducedMotion();
  const animate = !reduceMotion;
  const copy = COPY[variant] ?? COPY.crash;

  const handlePrimary = () => {
    // A stale bundle can only be fixed by fetching the new one.
    if (variant === "stale") return window.location.reload();
    if (onRetry) return onRetry();
    window.location.reload();
  };

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex min-h-dvh flex-col items-center justify-center px-6 py-12 text-center"
    >
      <div className="relative mb-8 flex h-28 w-28 items-center justify-center">
        {/*
          Rings expanding out of the mark. They read as a signal being sent and
          not answered, which is the feeling wanted — and they sit behind the
          logo rather than around the whole card so the layout doesn't shift.
        */}
        {animate &&
          [0, 1, 2].map((index) => (
            <Motion.span
              key={index}
              className="absolute h-16 w-16 rounded-full border border-neutral-700"
              initial={{ scale: 0.7, opacity: 0 }}
              animate={{ scale: [0.7, 1.9], opacity: [0.5, 0] }}
              transition={{
                duration: 3,
                repeat: Infinity,
                delay: index * 1,
                ease: "easeOut",
              }}
            />
          ))}

        <Motion.div
          className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-neutral-800 bg-neutral-900"
          animate={animate ? { y: [0, -5, 0] } : undefined}
          transition={
            animate
              ? { duration: 4, repeat: Infinity, ease: "easeInOut" }
              : undefined
          }
        >
          <svg
            viewBox={`0 0 ${LOGO_VIEWBOX} ${LOGO_VIEWBOX}`}
            className="h-9 w-9 fill-neutral-500"
            aria-hidden="true"
          >
            {LOGO_PATHS.map((d, index) => (
              <path key={index} d={d} />
            ))}
          </svg>
        </Motion.div>
      </div>

      <h1 className="text-lg font-medium">{copy.title}</h1>
      <p className="max-w-sm pt-2 text-sm leading-relaxed text-neutral-500">
        {copy.body}
      </p>

      <div className="pt-6">
        <StalledDots animate={animate} />
      </div>

      <div className="flex flex-wrap items-center justify-center gap-3 pt-8">
        <button
          type="button"
          onClick={handlePrimary}
          className="cursor-pointer rounded-md bg-white px-4 py-1.5 font-medium text-black hover:bg-white/90"
        >
          {copy.primary}
        </button>
        <button
          type="button"
          onClick={() => window.location.assign("/")}
          className="cursor-pointer rounded-md border border-neutral-800 px-4 py-1.5 font-medium text-neutral-300 hover:bg-neutral-900"
        >
          Go home
        </button>
      </div>

      {/*
        The actual error, in development only.
        `import.meta.env.DEV` is replaced with a literal at build time, so this
        whole block — message and stack included — is dropped from the production
        bundle by dead-code elimination rather than merely hidden. A stack trace
        names internal file paths, and a crash message can carry whatever data
        was being rendered when it threw.
      */}
      {import.meta.env.DEV && error && (
        <details className="mt-10 w-full max-w-2xl text-left">
          <summary className="cursor-pointer text-xs text-neutral-600 hover:text-neutral-400">
            Error detail (development only)
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-neutral-800 bg-neutral-900 p-3 text-xs whitespace-pre-wrap text-neutral-400">
            {error.stack || String(error)}
          </pre>
        </details>
      )}
    </div>
  );
};

export default ErrorScreen;
