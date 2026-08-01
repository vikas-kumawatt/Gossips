import { useContext, useEffect, useRef, useState } from "react";
import { toast } from "react-hot-toast";
import { Check, Loader2, X } from "lucide-react";
import { UserContext } from "../contexts/UserContext";
import ConfirmDialog from "./ui/ConfirmDialog";
import { userAPI } from "../services/api";
import {
  USERNAME_MAX,
  normalizeUsername,
  untilLabel,
  validateUsernameFormat,
} from "../lib/username";

/**
 * Changing your handle.
 *
 * Its own component and its own request rather than another field on the
 * profile form, because it isn't like the others: it's rate-limited, it can
 * fail for reasons only the server knows, and it breaks every link and mention
 * pointing at the old name. Folding it into "Update" would mean a save that
 * partially succeeds — bio written, username rejected — and no obvious way to
 * tell you which half happened.
 *
 * Availability is checked while you type, but that answer is only a hint: the
 * name can go in the seconds before you submit, so the server checks again and
 * the unique index has the last word.
 */

const DEBOUNCE_MS = 400;

const UsernameField = () => {
  const { userAuth, setUserAuth } = useContext(UserContext);

  const [status, setStatus] = useState(null);
  const [value, setValue] = useState("");
  const [check, setCheck] = useState(null);
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  // Cancels the reply to a keystroke that a later keystroke has replaced.
  const inflight = useRef(null);

  useEffect(() => {
    let cancelled = false;
    userAPI
      .getUsernameStatus()
      .then((data) => {
        if (cancelled) return;
        setStatus(data);
        setValue(data.username);
      })
      .catch(() => {
        // Non-fatal: the rest of the edit form still works, and the change
        // button stays hidden because there's no baseline to compare against.
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const current = status?.username || userAuth?.username || "";
  const changed = Boolean(status) && value !== current;
  const formatError = changed ? validateUsernameFormat(value) : null;
  const locked = Boolean(status) && status.remaining <= 0;

  useEffect(() => {
    inflight.current?.abort();

    // Nothing to ask about: unchanged, malformed, or out of allowance.
    if (!changed || formatError || locked) {
      setCheck(null);
      setChecking(false);
      return undefined;
    }

    // Clear the previous verdict first: it belongs to the name you *were*
    // typing, and leaving it up keeps the confirm button live for a name
    // nothing has checked yet.
    setCheck(null);
    setChecking(true);
    const controller = new AbortController();
    inflight.current = controller;

    const timer = setTimeout(() => {
      userAPI
        .checkUsername(value, controller.signal)
        .then((data) => {
          if (controller.signal.aborted) return;
          setCheck(data);
          setChecking(false);
        })
        .catch((error) => {
          if (controller.signal.aborted || error?.name === "CanceledError") return;
          setCheck({
            available: false,
            message: error?.response?.data?.error || "Couldn't check that name",
          });
          setChecking(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [value, changed, formatError, locked]);

  const handleChange = (event) => {
    // Normalising as you type rather than rejecting keystrokes: handles are
    // lowercase anyway, so silently downcasing a capital is kinder than an
    // error, while a space or a dot is a real mistake and should be visible.
    setValue(normalizeUsername(event.target.value).slice(0, USERNAME_MAX));
  };

  const handleConfirm = async () => {
    setSaving(true);
    try {
      const result = await userAPI.changeUsername(value);

      setStatus({
        username: result.username,
        changeCount: result.changeCount,
        lastChangedAt: result.lastChangedAt,
        used: result.used,
        remaining: result.remaining,
        limit: result.limit,
        nextAllowedAt: result.nextAllowedAt,
        windowDays: status?.windowDays,
      });
      setValue(result.username);
      setCheck(null);
      setConfirming(false);

      // Keeps the header, the "Edit profile" link and every /:username route
      // pointing at the account rather than at a name it no longer has.
      setUserAuth({ ...userAuth, username: result.username });
      toast.success("Username updated");
    } catch (error) {
      setConfirming(false);
      toast.error(error?.response?.data?.error || "Couldn't change your username");
    } finally {
      setSaving(false);
    }
  };

  const hint = (() => {
    if (locked)
      return `You've used all ${status.limit} changes for now. You can change it again ${
        untilLabel(status.nextAllowedAt) || "soon"
      }.`;
    if (formatError) return formatError;
    if (checking) return "Checking…";
    if (check) return check.message;
    if (status?.remaining === 1)
      return `1 more change available in this ${status.windowDays}-day window.`;
    return "Letters, numbers and underscores only.";
  })();

  const tone = formatError || (check && !check.available) || locked
    ? "text-red-400"
    : check?.available
      ? "text-green-400"
      : "text-neutral-400";

  return (
    <div className="mb-5">
      <h2 className="text-white text-sm font-medium mb-2">Username</h2>

      <div
        className={`flex items-center gap-2 rounded-xl border px-3 py-2 ${
          formatError || (check && !check.available)
            ? "border-red-500/50"
            : "border-neutral-800 focus-within:border-neutral-600"
        }`}
      >
        <span className="text-neutral-500 text-sm">@</span>
        <input
          value={value}
          onChange={handleChange}
          disabled={!status || locked || saving}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          aria-label="Username"
          className="min-w-0 flex-1 bg-transparent text-white text-sm outline-none disabled:opacity-60"
          placeholder={current || "username"}
        />
        {changed && !formatError && !locked && (
          <span className="shrink-0">
            {checking ? (
              <Loader2 className="h-4 w-4 animate-spin text-neutral-500" />
            ) : check?.available ? (
              <Check className="h-4 w-4 text-green-400" />
            ) : check ? (
              <X className="h-4 w-4 text-red-400" />
            ) : null}
          </span>
        )}
      </div>

      <p className={`mt-1.5 text-xs ${tone}`}>{hint}</p>

      {status?.changeCount > 0 && (
        <p className="mt-1 text-xs text-neutral-500">
          Changed {status.changeCount} time{status.changeCount === 1 ? "" : "s"}. Anyone can
          see this on your profile.
        </p>
      )}

      {changed && check?.available && (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => setValue(current)}
            className="rounded-lg bg-neutral-800 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black hover:bg-neutral-200 cursor-pointer"
          >
            Change username
          </button>
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          title={`Change to @${value}?`}
          confirmLabel="Change username"
          tone="default"
          busy={saving}
          onConfirm={handleConfirm}
          onCancel={() => !saving && setConfirming(false)}
        >
          {/* The consequences, before rather than after. The held-handle rule
              is the part nobody expects, and it's the reassuring half. */}
          <span className="block">
            Links and mentions using <span className="text-white">@{current}</span> will stop
            working.
          </span>
          <span className="mt-2 block">
            You can go back to it for the next {status?.windowDays || 14} days — nobody else
            can take it in the meantime.
          </span>
          {status?.remaining === 1 && (
            <span className="mt-2 block">
              This is your last change for this {status.windowDays}-day window.
            </span>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
};

export default UsernameField;
