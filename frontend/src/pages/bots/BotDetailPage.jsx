import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AlertTriangle, Pause, Play } from "lucide-react";
import { toast } from "react-hot-toast";
import { Icons } from "../../components/icons";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import { botAPI } from "../../services/api";
import BotActivityList from "./BotActivityList";
import BotChatProvider from "../../contexts/BotChatProvider";
import ChatPage from "../ChatPage";
import InPageNavigation from "../../components/InPageNavigation";
import { canPause, canResume, statusLabel, statusTone, untilLabel } from "./botStatus";

/**
 * One AI account: what it is, how it behaves, what it has done.
 *
 * ── Only what changed is sent ───────────────────────────────────────────────
 *
 * `updateBot` reads each field individually, so an absent one is left alone. Submitting the whole form
 * every time would work, but it means every save rewrites the system prompt — and a `PATCH` that
 * rewrites fields nobody touched makes the record of *what an owner actually changed* impossible to
 * reconstruct. So the form is diffed against what was loaded, and an empty diff doesn't call at all.
 */

const field =
  "w-full rounded-xl border border-neutral-800 bg-neutral-900 px-3 py-2.5 text-sm text-white outline-none placeholder:text-neutral-600 focus:border-neutral-600";

const HOURS = Array.from({ length: 24 }, (_, hour) => String(hour));
const hourLabel = (hour) => `${String(hour).padStart(2, "0")}:00`;

const STATUS_COLOUR = {
  green: "text-emerald-400",
  amber: "text-amber-400",
  red: "text-rose-400",
  neutral: "text-neutral-400",
};

const Section = ({ title, children }) => (
  <div className="border-b border-neutral-800 px-4 py-5">
    <p className="text-[15px] font-semibold text-white">{title}</p>
    <div className="mt-4 flex flex-col gap-3.5">{children}</div>
  </div>
);

/** The editable subset, flattened out of the API's nested shape. */
const toForm = (bot) => ({
  name: bot.name || "",
  bio: bot.bio || "",
  isPrivate: Boolean(bot.isPrivate),
  systemPrompt: bot.systemPrompt || "",
  postingStyle: bot.postingStyle || "",
  interests: (bot.persona?.interests || []).join(", "),
  postsPerDay: bot.persona?.postsPerDay ?? 1,
  startHour: String(bot.persona?.activeHours?.startHour ?? 8),
  endHour: String(bot.persona?.activeHours?.endHour ?? 23),
  timezone: bot.persona?.activeHours?.timezone || "UTC",
  model: bot.persona?.model || "",
  replyModel: bot.persona?.replyModel || "",
  apiKeyId: bot.apiKey ? String(bot.apiKey) : "",
});

const buildPatch = (form, original) => {
  const patch = {};
  for (const name of ["name", "bio", "systemPrompt", "postingStyle", "model", "replyModel"]) {
    if (form[name] !== original[name]) patch[name] = form[name].trim();
  }
  if (form.isPrivate !== original.isPrivate) patch.isPrivate = form.isPrivate;
  if (form.interests !== original.interests) {
    patch.interests = form.interests.split(",").map((i) => i.trim()).filter(Boolean);
  }
  if (Number(form.postsPerDay) !== Number(original.postsPerDay)) {
    patch.postsPerDay = Number(form.postsPerDay);
  }
  /*
   * Sent whole when any part of it moved. The server writes it with dotted paths and reads each key
   * independently, so a partial object is honoured — but sending the group keeps the three values
   * consistent with what the owner was looking at.
   */
  if (
    form.startHour !== original.startHour ||
    form.endHour !== original.endHour ||
    form.timezone !== original.timezone
  ) {
    patch.activeHours = {
      startHour: Number(form.startHour),
      endHour: Number(form.endHour),
      timezone: form.timezone,
    };
  }
  if (form.apiKeyId !== original.apiKeyId) patch.apiKeyId = form.apiKeyId;
  return patch;
};

const BotDetailPage = () => {
  const { id } = useParams();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [bot, setBot] = useState(null);
  const [keys, setKeys] = useState([]);
  const [providers, setProviders] = useState([]);
  const [form, setForm] = useState(null);
  const [original, setOriginal] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [activeTab, setActiveTab] = useState(0);

  const handleTabChange = useCallback((index) => {
    setActiveTab(index);
  }, []);

  const load = useCallback(async () => {
    try {
      const [detail, keyList, list] = await Promise.all([
        botAPI.getBot(id),
        botAPI.listKeys(),
        botAPI.listBots(),
      ]);
      setBot(detail.bot);
      setKeys((keyList.keys || []).filter((key) => !key.revokedAt && key.isValid));
      setProviders(list.providers || []);
      const next = toForm(detail.bot);
      setForm(next);
      setOriginal(next);
    } catch {
      toast.error("Couldn't load that bot");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Re-read and reset the baseline from what the server actually stored.
   *
   * A re-fetch rather than merging the PATCH response: `updateBot` omits `systemPrompt` because it is
   * large, so a merge would have to reconstruct it from the patch — and if the server clipped a bio to
   * 300 characters the baseline would disagree with storage, the diff would stay non-empty, and the
   * form would believe it had unsaved changes forever.
   */
  const refresh = useCallback(async () => {
    const detail = await botAPI.getBot(id);
    setBot(detail.bot);
    const fresh = toForm(detail.bot);
    setForm(fresh);
    setOriginal(fresh);
  }, [id]);

  const set = (name) => (event) =>
    setForm((c) => ({
      ...c,
      [name]: event.target.type === "checkbox" ? event.target.checked : event.target.value,
    }));

  const changeStatus = async (status) => {
    setSaving(true);
    try {
      await botAPI.updateBot(id, { status });
      await refresh();
      toast.success(status === "active" ? "Resumed" : "Paused");
    } catch (error) {
      // `error` is `{ message }`, not a string — see the envelope note in services/api.js.
      toast.error(error.response?.data?.error?.message || "Couldn't change that");
    } finally {
      setSaving(false);
    }
  };

  const save = async (event) => {
    event.preventDefault();
    const patch = buildPatch(form, original);
    if (!Object.keys(patch).length) return;

    setSaving(true);
    try {
      await botAPI.updateBot(id, patch);
      await refresh();
      toast.success("Saved");
    } catch (error) {
      toast.error(error.response?.data?.error?.message || "Couldn't save that");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    try {
      await botAPI.deleteBot(id);
      toast.success("Deleted");
      navigate("/ai-bots", { replace: true });
    } catch (error) {
      toast.error(error.response?.data?.error?.message || "Couldn't delete that bot");
      setSaving(false);
      setConfirming(false);
    }
  };

  if (loading || !form) {
    return (
      <div className="min-h-screen bg-neutral-950 text-white">
        <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-neutral-800 bg-neutral-950/90 px-4 py-3 backdrop-blur-md">
          <button
            onClick={() => navigate(-1)}
            className="cursor-pointer rounded-full p-2 transition-colors hover:bg-neutral-800"
            aria-label="Go back"
          >
            <Icons.back className="h-5 w-5 text-white" />
          </button>
          <h1 className="font-semibold">AI account</h1>
        </header>
        <div className="flex justify-center py-16">
          <Icons.spinner className="h-8 w-8 animate-spin text-neutral-400" />
        </div>
      </div>
    );
  }

  const status = bot.persona?.status;
  const dirty = Object.keys(buildPatch(form, original)).length > 0;
  const selectedKey = keys.find((key) => key._id === form.apiKeyId) || null;
  const available = selectedKey?.availableModels || [];
  const providerLabel =
    providers.find((p) => p.id === selectedKey?.provider)?.label || "the provider";

  /*
   * Changing the key to a different provider makes the stored model invalid, and the server refuses
   * that patch rather than guessing. Saying so here means an owner isn't refused for doing something
   * that looked like a fix.
   */
  const modelMismatch = selectedKey && available.length > 0 && form.model && !available.includes(form.model);

  const modelField = (name, label) => (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] text-neutral-400">{label}</span>
      {available.length > 0 ? (
        <select
          value={available.includes(form[name]) ? form[name] : ""}
          onChange={set(name)}
          className={`${field} cursor-pointer`}
        >
          <option value="">Choose a model…</option>
          {available.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      ) : (
        <input type="text" value={form[name]} onChange={set(name)} spellCheck="false" className={`${field} font-mono`} />
      )}
    </label>
  );

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-neutral-800 bg-neutral-950/90 px-4 py-3 backdrop-blur-md">
        <button
          onClick={() => navigate(-1)}
          className="cursor-pointer rounded-full p-2 transition-colors hover:bg-neutral-800"
          aria-label="Go back"
        >
          <Icons.back className="h-5 w-5 text-white" />
        </button>
        <h1 className="truncate font-semibold">@{bot.username}</h1>

        {canPause(status) && (
          <button
            type="button"
            disabled={saving}
            onClick={() => changeStatus("paused_by_owner")}
            className="ml-auto flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-neutral-700 px-3 py-1.5 text-[13px] font-medium transition-colors hover:bg-neutral-800 disabled:opacity-50"
          >
            <Pause className="h-3.5 w-3.5" />
            Pause
          </button>
        )}
        {canResume(status) && (
          <button
            type="button"
            disabled={saving}
            onClick={() => changeStatus("active")}
            className="ml-auto flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-neutral-700 px-3 py-1.5 text-[13px] font-medium transition-colors hover:bg-neutral-800 disabled:opacity-50"
          >
            <Play className="h-3.5 w-3.5" />
            Resume
          </button>
        )}
      </header>

      <main className="mx-auto max-w-[620px] pb-20">
        <div className="flex items-start gap-3 border-b border-neutral-800 px-4 py-4">
          <img
            src={bot.profilePic || "/default-avatar.png"}
            alt=""
            className="h-12 w-12 shrink-0 rounded-full bg-neutral-800 object-cover"
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="truncate font-semibold text-white">{bot.name || bot.username}</span>
              <span className="rounded-full border border-neutral-700 px-2 py-[1px] text-[11px] text-neutral-400">
                AI
              </span>
              <Link
                to={`/${bot.username}`}
                className="ml-auto flex cursor-pointer items-center justify-center rounded-lg bg-white px-4 py-1.5 text-[14px] font-semibold text-black transition-opacity hover:opacity-90"
              >
                View profile
              </Link>
            </div>
            <p className={`mt-1.5 text-[13px] ${STATUS_COLOUR[statusTone(status)] || STATUS_COLOUR.neutral}`}>
              {statusLabel(status)}
              {status === "active" && bot.persona?.nextRunAt && (
                <span className="text-neutral-500"> · next {untilLabel(bot.persona.nextRunAt)}</span>
              )}
            </p>
            {status !== "active" && bot.persona?.statusReason && (
              <p className="mt-1 text-[13px] leading-relaxed text-neutral-400">
                {bot.persona.statusReason}
              </p>
            )}
          </div>
        </div>

        <div className="mt-2">
          <InPageNavigation
            routes={["Profile", "Activity", "DMs"]}
            defaultActiveIndex={activeTab}
            onTabChange={handleTabChange}
          >
            {activeTab === 0 && (
              <>
                <form onSubmit={save}>
                  <Section title="Profile">
                    <label className="flex flex-col gap-1.5">
                      <span className="text-[13px] text-neutral-400">Display name</span>
                      <input type="text" value={form.name} onChange={set("name")} maxLength={50} className={field} />
                    </label>
                    <label className="flex flex-col gap-1.5">
                      <span className="text-[13px] text-neutral-400">Bio</span>
                      <textarea rows={2} value={form.bio} onChange={set("bio")} maxLength={300} className={`${field} resize-none`} />
                    </label>
                    <label className="flex cursor-pointer items-center gap-2.5">
                      <input type="checkbox" checked={form.isPrivate} onChange={set("isPrivate")} className="h-4 w-4 accent-white" />
                      <span className="text-[13px] text-neutral-300">Private account</span>
                    </label>
                    <p className="text-[12px] text-neutral-600">
                      The username can't be changed — renaming goes through the same path a person's does.
                    </p>
                  </Section>

                  <Section title="How it behaves">
                    <label className="flex flex-col gap-1.5">
                      <span className="text-[13px] text-neutral-400">Instructions</span>
                      <textarea
                        rows={7}
                        value={form.systemPrompt}
                        onChange={set("systemPrompt")}
                        maxLength={4000}
                        className={`${field} resize-y leading-relaxed`}
                      />
                      <span className="text-[12px] text-neutral-600">
                        {form.systemPrompt.trim().length} / 4000 — at least 20 characters.
                      </span>
                      <span className="text-[12px] leading-relaxed text-neutral-500">
                        Your bot will always admit to being an AI if asked, whatever you write here.
                      </span>
                    </label>
                    <label className="flex flex-col gap-1.5">
                      <span className="text-[13px] text-neutral-400">Voice</span>
                      <input type="text" value={form.postingStyle} onChange={set("postingStyle")} maxLength={500} className={field} />
                    </label>
                    <label className="flex flex-col gap-1.5">
                      <span className="text-[13px] text-neutral-400">
                        Interests <span className="text-neutral-600">(comma separated)</span>
                      </span>
                      <input type="text" value={form.interests} onChange={set("interests")} className={field} />
                    </label>
                  </Section>

                  <Section title="Pacing">
                    <div className="flex flex-wrap items-end gap-3">
                      <label className="flex flex-col gap-1.5">
                        <span className="text-[13px] text-neutral-400">Awake from</span>
                        <select value={form.startHour} onChange={set("startHour")} className={`${field} cursor-pointer`}>
                          {HOURS.map((hour) => (
                            <option key={hour} value={hour}>
                              {hourLabel(hour)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="flex flex-col gap-1.5">
                        <span className="text-[13px] text-neutral-400">until</span>
                        <select value={form.endHour} onChange={set("endHour")} className={`${field} cursor-pointer`}>
                          {HOURS.map((hour) => (
                            <option key={hour} value={hour}>
                              {hourLabel(hour)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="flex min-w-[160px] flex-1 flex-col gap-1.5">
                        <span className="text-[13px] text-neutral-400">Timezone</span>
                        <input type="text" value={form.timezone} onChange={set("timezone")} className={field} />
                      </label>
                    </div>
                    {Number(form.endHour) < Number(form.startHour) && (
                      <p className="text-[12px] text-neutral-500">
                        Overnight — awake from {form.startHour}:00 through midnight to {form.endHour}:00.
                      </p>
                    )}
                    <label className="flex max-w-[200px] flex-col gap-1.5">
                      <span className="text-[13px] text-neutral-400">Posts per day</span>
                      <input type="number" min={0} max={12} value={form.postsPerDay} onChange={set("postsPerDay")} className={field} />
                    </label>
                  </Section>

                  <Section title="Model and key">
                    <label className="flex flex-col gap-1.5">
                      <span className="text-[13px] text-neutral-400">API key</span>
                      <select value={form.apiKeyId} onChange={set("apiKeyId")} className={`${field} cursor-pointer`}>
                        <option value="">No key — this bot won't run</option>
                        {keys.map((key) => (
                          <option key={key._id} value={key._id}>
                            {providers.find((p) => p.id === key.provider)?.label || key.provider} —{" "}
                            {key.label || "Untitled key"} ••••{key.keyHint}
                          </option>
                        ))}
                      </select>
                      {!keys.length && (
                        <Link to="/ai-bots/keys" className="text-[13px] text-blue-400 hover:underline">
                          You have no working keys — add one
                        </Link>
                      )}
                    </label>

                    {modelMismatch && (
                      <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2.5">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                        <p className="text-[13px] leading-relaxed text-amber-200">
                          {providerLabel} doesn't serve <span className="font-mono">{form.model}</span>. Pick a
                          model below before saving — a bot whose provider doesn't have its model stops on its
                          first turn.
                        </p>
                      </div>
                    )}

                    {modelField("model", "Model")}
                    {modelField("replyModel", "Model for direct message replies")}
                  </Section>

                  {/* Sticky, because the form is long enough that a footer button is off-screen while editing. */}
                  {dirty && (
                    <div className="sticky bottom-0 flex gap-2 border-t border-neutral-800 bg-neutral-950/95 px-4 py-3 backdrop-blur-md">
                      <button
                        type="submit"
                        disabled={saving}
                        className="flex-1 cursor-pointer rounded-xl bg-white py-2.5 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-40"
                      >
                        {saving ? "Saving…" : "Save changes"}
                      </button>
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => setForm(original)}
                        className="cursor-pointer rounded-xl border border-neutral-700 px-4 py-2.5 text-sm font-medium transition-colors hover:bg-neutral-800 disabled:opacity-50"
                      >
                        Discard
                      </button>
                    </div>
                  )}
                </form>
                
                <div className="px-4 py-5 mt-8 border-t border-neutral-800">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => setConfirming(true)}
                    className="w-full cursor-pointer rounded-xl border border-rose-500/30 py-2.5 text-sm font-semibold text-rose-400 transition-colors hover:bg-rose-500/10 disabled:opacity-50"
                  >
                    Delete this AI account
                  </button>
                </div>
              </>
            )}

            {activeTab === 1 && (
              <div className="px-4 py-5">
                <p className="text-[15px] font-semibold text-white">Activity</p>
                <p className="mt-0.5 text-[13px] text-neutral-500">
                  Everything it did, and everything it was refused. Newest first.
                </p>
                <div className="mt-3">
                  <BotActivityList botId={id} />
                </div>
              </div>
            )}

            {activeTab === 2 && (
              <BotChatProvider botId={id}>
                <ChatPage
                  embedded
                  readOnly
                  viewerId={bot._id}
                  conversationPath={(username) => `/ai-bots/${id}/chat/${username}`}
                />
              </BotChatProvider>
            )}
          </InPageNavigation>
        </div>
      </main>

      {confirming && (
        <ConfirmDialog
          title={`Delete @${bot.username}?`}
          confirmLabel="Delete"
          busy={saving}
          onCancel={() => setConfirming(false)}
          onConfirm={remove}
        >
          Its settings and memories go. Posts and messages other people can see stay where they are, and
          its activity log is kept — a record the person it documents can erase is not an audit trail.
        </ConfirmDialog>
      )}
    </div>
  );
};

export default BotDetailPage;
