import { useCallback, useEffect, useState } from "react";
import { toast } from "react-hot-toast";
import { useOutletContext } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { adminAPI } from "../../services/api";
import { Panel, Spinner, ErrorState, Button, Toggle, relativeTime } from "../../components/admin/ui";

/**
 * Every flag here is enforced server-side — see middleware/featureGate.js and
 * middleware/maintenanceMiddleware.js. Nothing on this page is decorative.
 */
const TOGGLES = [
  {
    group: "Access",
    items: [
      {
        key: "registrationsOpen",
        label: "Open registrations",
        hint: "When off, new signups are rejected. Existing accounts are unaffected.",
      },
      {
        key: "maintenanceMode",
        label: "Maintenance mode",
        hint: "Blocks all writes across the app. Sign-in and this panel stay available.",
        danger: true,
      },
    ],
  },
  {
    group: "Content",
    items: [
      { key: "postingEnabled", label: "Posting", hint: "Allow new posts. Staff bypass this." },
      { key: "commentingEnabled", label: "Commenting", hint: "Allow replies to posts and comments." },
      { key: "mediaUploadsEnabled", label: "Media uploads", hint: "When off, posts go through as text only." },
      { key: "directMessagesEnabled", label: "Direct messages", hint: "Allow new DMs to be sent." },
    ],
  },
];

const NUMBERS = [
  {
    key: "maxPostLength",
    label: "Max post length",
    hint: "Characters. Capped at 500 by the database schema.",
    min: 1,
    max: 500,
  },
  {
    key: "maxCommentLength",
    label: "Max comment length",
    hint: "Characters. Capped at 500 by the database schema.",
    min: 1,
    max: 500,
  },
  {
    key: "autoFlagReportThreshold",
    label: "Urgent report threshold",
    hint: "Reports on one target above this are flagged urgent in the queue.",
    min: 1,
    max: 100,
  },
  {
    key: "minAccountAgeHoursToPost",
    label: "Min account age to post",
    hint: "Hours. A blunt brake on signup-and-spam. 0 disables it.",
    min: 0,
    max: 168,
  },
];

/*
 * The list is edited as free text rather than as chips: reserving names is a
 * paste-a-batch job, not a one-at-a-time one. Split on commas and newlines so
 * either shape works.
 */
const parseReserved = (text) =>
  [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((entry) => entry.trim().toLowerCase())
        // Same filter the server applies, so the count below and the list that
        // actually gets stored are the same list.
        .filter((entry) => /^[a-z0-9_]{3,30}$/.test(entry))
    ),
  ]
    .sort()
    .slice(0, 500);

const formatReserved = (list) => (Array.isArray(list) ? [...list].sort().join("\n") : "");

/*
 * Hashtags follow different rules from usernames: one character is fine, up to
 * a hundred, and a tag must contain a non-digit — `#2024` is a year. Mirrors
 * normalizeBlockedHashtags on the server so the counter below and the list
 * that actually gets stored are the same list.
 */
const parseTags = (text) =>
  [
    ...new Set(
      text
        .split(/[\s,#]+/)
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => /^[a-z0-9_]{1,100}$/.test(entry) && !/^\d+$/.test(entry))
    ),
  ]
    .sort()
    .slice(0, 2000);

const AdminSettings = () => {
  const { session } = useOutletContext();
  const [settings, setSettings] = useState(null);
  const [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  // Held as text, not as the array: mid-typing, "foo,\nba" isn't a valid list
  // yet, and round-tripping through the array on every keystroke would eat
  // the separator the moment you type it.
  const [reservedText, setReservedText] = useState("");
  // Sent by the server from utils/reservedUsernames.js. Not editable — these
  // are tied to routes and to the platform's own identity, so removing one is
  // a code change with a code review, not a form submission.
  const [builtIn, setBuiltIn] = useState([]);
  const [showBuiltIn, setShowBuiltIn] = useState(false);
  const [tagText, setTagText] = useState("");
  const [builtInTags, setBuiltInTags] = useState([]);
  const [showBuiltInTags, setShowBuiltInTags] = useState(false);

  const readOnly = !session?.isSuperAdmin;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminAPI.getSettings();
      setSettings(res.settings);
      setDraft(res.settings);
      setReservedText(formatReserved(res.settings.reservedUsernames));
      setBuiltIn(res.builtInReservedUsernames || []);
      setTagText(formatReserved(res.settings.blockedHashtags));
      setBuiltInTags(res.builtInBlockedHashtags || []);
    } catch {
      setError("Couldn't load settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const reservedDirty =
    settings && formatReserved(parseReserved(reservedText)) !== formatReserved(settings.reservedUsernames);

  const tagsDirty =
    settings && formatReserved(parseTags(tagText)) !== formatReserved(settings.blockedHashtags);

  const dirty =
    (draft &&
      settings &&
      Object.keys(draft).some(
        (k) =>
          k !== "updatedAt" &&
          k !== "updatedBy" &&
          // Compared separately above; an array is never === its own copy.
          k !== "reservedUsernames" &&
          k !== "blockedHashtags" &&
          draft[k] !== settings[k]
      )) ||
    reservedDirty ||
    tagsDirty;

  const save = async () => {
    setSaving(true);
    try {
      const payload = {};
      for (const { items } of TOGGLES) {
        for (const { key } of items) payload[key] = !!draft[key];
      }
      for (const { key } of NUMBERS) payload[key] = Number(draft[key]);
      payload.maintenanceMessage = String(draft.maintenanceMessage || "");
      payload.reservedUsernames = parseReserved(reservedText);
      payload.blockedHashtags = parseTags(tagText);

      const res = await adminAPI.updateSettings(payload);
      setSettings(res.settings);
      setDraft(res.settings);
      // Echo back what the server kept — it drops anything that couldn't be a
      // username or a tag, so the boxes shouldn't keep showing the rejects.
      setReservedText(formatReserved(res.settings.reservedUsernames));
      setTagText(formatReserved(res.settings.blockedHashtags));
      toast.success(res.message);
    } catch (e) {
      toast.error(e.response?.data?.error || "Couldn't save settings");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!draft) return null;

  const set = (key, value) => setDraft((d) => ({ ...d, [key]: value }));

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Settings</h1>
          <p className="text-[13px] text-neutral-500 mt-1">
            {settings.updatedAt
              ? `Last changed ${relativeTime(settings.updatedAt)}`
              : "Runtime feature flags"}
          </p>
        </div>
        {!readOnly && (
          <div className="flex items-center gap-2">
            {dirty && (
              <Button
              onClick={() => {
                setDraft(settings);
                setReservedText(formatReserved(settings.reservedUsernames));
                setTagText(formatReserved(settings.blockedHashtags));
              }}
              disabled={saving}
            >
                Discard
              </Button>
            )}
            <Button variant="primary" onClick={save} disabled={!dirty || saving}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        )}
      </header>

      {readOnly && (
        <div className="flex items-start gap-2.5 rounded-2xl border border-amber-500/25 bg-amber-500/5 p-4">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <p className="text-[13px] text-amber-200">
            These flags change how the whole app behaves, so only a super admin can edit them.
            You can see the current values.
          </p>
        </div>
      )}

      {draft.maintenanceMode && (
        <div className="flex items-start gap-2.5 rounded-2xl border border-red-500/30 bg-red-500/10 p-4">
          <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <p className="text-[13px] text-red-200">
            Maintenance mode is on. Nobody can post, comment or message until it's turned off.
          </p>
        </div>
      )}

      {TOGGLES.map(({ group, items }) => (
        <Panel key={group} title={group}>
          <div className="flex flex-col divide-y divide-neutral-800 -my-1">
            {items.map(({ key, label, hint, danger }) => (
              <div key={key} className="py-3.5 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p
                    className={`text-[14px] font-medium ${
                      danger && draft[key] ? "text-red-300" : "text-white"
                    }`}
                  >
                    {label}
                  </p>
                  <p className="text-[12px] text-neutral-500 mt-0.5">{hint}</p>
                </div>
                <Toggle
                  checked={!!draft[key]}
                  disabled={readOnly}
                  onChange={(v) => set(key, v)}
                />
              </div>
            ))}
          </div>
        </Panel>
      ))}

      <Panel title="Maintenance message" subtitle="Shown when a write is blocked">
        <textarea
          value={draft.maintenanceMessage || ""}
          onChange={(e) => set("maintenanceMessage", e.target.value)}
          disabled={readOnly}
          maxLength={300}
          className="w-full h-20 bg-neutral-900 border border-neutral-800 rounded-xl p-3 text-[13px] text-white outline-none resize-none focus:border-neutral-600 disabled:opacity-60"
        />
      </Panel>

      <Panel
        title="Reserved usernames"
        subtitle="Extra handles nobody can register, on top of the built-in list"
      >
        <p className="text-[12px] text-neutral-500 mb-2">
          One per line, or comma-separated. Route names, platform handles and
          support-desk impersonations are already blocked in code — this is for
          names you need to hold back today. Reserving a name doesn't take it
          from anyone already using it.
        </p>
        <textarea
          value={reservedText}
          onChange={(e) => setReservedText(e.target.value)}
          disabled={readOnly}
          spellCheck={false}
          placeholder={"acmecorp\nnewbrand"}
          className="w-full h-32 bg-neutral-900 border border-neutral-800 rounded-xl p-3 text-[13px] text-white outline-none resize-y font-mono focus:border-neutral-600 disabled:opacity-60"
        />
        <p className="text-[12px] text-neutral-500 mt-2">
          {parseReserved(reservedText).length} reserved · 500 max
        </p>

        {builtIn.length > 0 && (
          <div className="mt-4 border-t border-neutral-800 pt-3">
            <button
              type="button"
              onClick={() => setShowBuiltIn((v) => !v)}
              className="flex w-full items-center justify-between text-left cursor-pointer"
            >
              <span className="text-[13px] font-medium text-white">
                Blocked in code ({builtIn.length})
              </span>
              <span className="text-[12px] text-neutral-500">
                {showBuiltIn ? "Hide" : "Show"}
              </span>
            </button>
            {showBuiltIn && (
              <>
                <p className="mt-2 text-[12px] text-neutral-500">
                  Read-only. Route names first — an account called “settings”
                  would shadow the settings page — then platform handles,
                  support-desk impersonations and infrastructure names.
                  Impersonation patterns like “gossips_support” are also
                  blocked and can’t be listed here.
                </p>
                <div className="mt-2 max-h-48 overflow-y-auto custom-scrollbar rounded-xl bg-neutral-900 p-3">
                  <div className="flex flex-wrap gap-1.5">
                    {builtIn.map((name) => (
                      <span
                        key={name}
                        className="rounded-md bg-neutral-800 px-1.5 py-0.5 font-mono text-[11px] text-neutral-400"
                      >
                        {name}
                      </span>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </Panel>

      <Panel
        title="Blocked hashtags"
        subtitle="Tags the app won't index or link, on top of the built-in list"
      >
        <p className="text-[12px] text-neutral-500 mb-2">
          One per line, or comma-separated; the # is optional. A blocked tag
          doesn't block the post — it publishes as normal, but the tag renders
          as plain text, isn't indexed, and its page says it's restricted.
          Losing someone's whole post over one word is worse than the word.
        </p>
        <textarea
          value={tagText}
          onChange={(e) => setTagText(e.target.value)}
          disabled={readOnly}
          spellCheck={false}
          placeholder={"somebrand\nsomecampaign"}
          className="w-full h-32 bg-neutral-900 border border-neutral-800 rounded-xl p-3 text-[13px] text-white outline-none resize-y font-mono focus:border-neutral-600 disabled:opacity-60"
        />
        <p className="text-[12px] text-neutral-500 mt-2">
          {parseTags(tagText).length} blocked · 2000 max
        </p>

        {builtInTags.length > 0 && (
          <div className="mt-4 border-t border-neutral-800 pt-3">
            <button
              type="button"
              onClick={() => setShowBuiltInTags((v) => !v)}
              className="flex w-full items-center justify-between text-left cursor-pointer"
            >
              <span className="text-[13px] font-medium text-white">
                Blocked in code ({builtInTags.length})
              </span>
              <span className="text-[12px] text-neutral-500">
                {showBuiltInTags ? "Hide" : "Show"}
              </span>
            </button>
            {showBuiltInTags && (
              <div className="mt-2 max-h-48 overflow-y-auto custom-scrollbar rounded-xl bg-neutral-900 p-3">
                <div className="flex flex-wrap gap-1.5">
                  {builtInTags.map((name) => (
                    <span
                      key={name}
                      className="rounded-md bg-neutral-800 px-1.5 py-0.5 font-mono text-[11px] text-neutral-400"
                    >
                      #{name}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Panel>

      <Panel title="Limits">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {NUMBERS.map(({ key, label, hint, min, max }) => (
            <div key={key}>
              <label className="text-[14px] font-medium text-white">{label}</label>
              <p className="text-[12px] text-neutral-500 mt-0.5 mb-2">{hint}</p>
              <input
                type="number"
                min={min}
                max={max}
                value={draft[key] ?? min}
                disabled={readOnly}
                onChange={(e) => {
                  // Clamp here so the server never has to reject the value.
                  const n = Number(e.target.value);
                  if (Number.isNaN(n)) return;
                  set(key, Math.min(Math.max(n, min), max));
                }}
                className="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-neutral-600 disabled:opacity-60"
              />
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
};

export default AdminSettings;
