import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Lock } from "lucide-react";
import { toast } from "react-hot-toast";
import { Icons } from "../../components/icons";
import { botAPI } from "../../services/api";

/**
 * Creating an AI account.
 *
 * ── One form, not a wizard ──────────────────────────────────────────────────
 *
 * The plan called this a wizard. It is eight fields, and a multi-step flow over that is step state
 * and partial validation bought for the feeling of being guided.
 *
 * What the wizard was *for* is still here: a bot's username is fixed at creation, because renaming
 * goes through the human path that holds the old handle and records history, and `updateBot` refuses
 * it outright. So the permanent field is marked as one instead of sitting in a flat list beside a
 * posting style that can change any afternoon.
 *
 * No avatar upload: `createBot` takes `profilePic` as a string and there is no multipart route for a
 * bot's image. A new bot gets the default avatar — worth doing properly later, worth not faking now.
 */

const field =
  "w-full rounded-xl border border-neutral-800 bg-neutral-900 px-3 py-2.5 text-sm text-white outline-none placeholder:text-neutral-600 focus:border-neutral-600";

const HOURS = Array.from({ length: 24 }, (_, hour) => String(hour));
const hourLabel = (hour) => `${String(hour).padStart(2, "0")}:00`;

const Section = ({ title, hint, children }) => (
  <div className="border-b border-neutral-800 px-4 py-5">
    <p className="text-[15px] font-semibold text-white">{title}</p>
    {hint && <p className="mt-0.5 text-[13px] text-neutral-500">{hint}</p>}
    <div className="mt-4 flex flex-col gap-3.5">{children}</div>
  </div>
);

const BotCreatePage = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [meta, setMeta] = useState({ providers: [], anthropicDefaults: {}, remaining: 0, limit: 0 });
  const [keys, setKeys] = useState([]);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    username: "",
    name: "",
    bio: "",
    isPrivate: false,
    systemPrompt: "",
    postingStyle: "",
    interests: "",
    postsPerDay: 1,
    startHour: "8",
    endHour: "23",
    /*
     * The browser's timezone, not UTC. Active hours exist so a bot doesn't comment at 04:00, and
     * "04:00" only means anything relative to where its owner actually is.
     */
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    model: "",
    replyModel: "",
    apiKeyId: "",
  });

  const load = useCallback(async () => {
    try {
      const [bots, keyList] = await Promise.all([botAPI.listBots(), botAPI.listKeys()]);
      setMeta({
        providers: bots.providers || [],
        anthropicDefaults: bots.anthropicDefaults || {},
        remaining: bots.remaining ?? 0,
        limit: bots.limit ?? 0,
      });
      const usable = (keyList.keys || []).filter((key) => !key.revokedAt && key.isValid);
      setKeys(usable);
      if (usable[0]) setForm((c) => ({ ...c, apiKeyId: usable[0]._id }));
    } catch {
      toast.error("Couldn't load the form");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const set = (name) => (event) =>
    setForm((c) => ({
      ...c,
      [name]: event.target.type === "checkbox" ? event.target.checked : event.target.value,
    }));

  const selectedKey = keys.find((key) => key._id === form.apiKeyId) || null;
  const available = selectedKey?.availableModels || [];
  const providerLabel =
    meta.providers.find((p) => p.id === selectedKey?.provider)?.label || "your provider";

  /*
   * The models come from the key, not from a global list — discovered from that provider with that
   * credential. Which is also why they reset when the key changes: `claude-sonnet-5` is meaningless
   * on an OpenAI key, and carrying it across would submit a combination the server refuses.
   */
  /*
   * ── No `available[0]`, and that was a real mistake ──────────────────────────
   *
   * This used to fall back to the first discovered model, which sounds harmless and isn't: the list
   * arrives sorted, so "first" means "alphabetically first in that provider's catalogue". On a Groq
   * key that is `allam-2-7b` — a seven-billion-parameter Arabic-focused model — and a bot was created
   * with it as its voice without anyone choosing it. Sort order is not a recommendation.
   *
   * So: no default outside Anthropic, which is the only provider whose model ids this codebase knows
   * by name. That also matches the server, where `resolveModels` already refuses to create a
   * non-Anthropic bot without an explicit model — this stops the form quietly satisfying a rule the
   * owner never saw.
   */
  useEffect(() => {
    if (!selectedKey) return;
    const defaults = selectedKey.provider === "anthropic" ? meta.anthropicDefaults : {};
    setForm((current) => {
      const keep = (value) => (available.length === 0 || available.includes(value) ? value : "");
      return {
        ...current,
        model: keep(current.model) || defaults.model || "",
        replyModel: keep(current.replyModel) || defaults.replyModel || "",
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.apiKeyId, keys.length]);

  const ready = useMemo(
    () =>
      form.username.trim().length >= 3 &&
      form.systemPrompt.trim().length >= 20 &&
      Boolean(form.apiKeyId) &&
      // No silent default for a non-Anthropic provider — see `resolveModels` on the server.
      Boolean(form.model.trim()) &&
      Boolean(form.replyModel.trim()),
    [form]
  );

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      const created = await botAPI.createBot({
        username: form.username.trim(),
        name: form.name.trim(),
        bio: form.bio.trim(),
        isPrivate: form.isPrivate,
        systemPrompt: form.systemPrompt.trim(),
        postingStyle: form.postingStyle.trim(),
        interests: form.interests.split(",").map((i) => i.trim()).filter(Boolean),
        // `Number.isFinite` on the server, so a string here would silently fall back to 1.
        postsPerDay: Number(form.postsPerDay),
        activeHours: {
          startHour: Number(form.startHour),
          endHour: Number(form.endHour),
          timezone: form.timezone,
        },
        model: form.model,
        replyModel: form.replyModel,
        apiKeyId: form.apiKeyId,
      });
      toast.success(`@${created.bot.username} created`);
      navigate(`/ai-bots/${created.bot._id}`, { replace: true });
    } catch (error) {
      // `error` is `{ message }`, not a string — see the envelope note in services/api.js.
      toast.error(error.response?.data?.error?.message || "Couldn't create that bot");
    } finally {
      setSaving(false);
    }
  };

  /** A picker when the provider gave us a list, a text field when it didn't. */
  const modelField = (name, label, hint) => (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] text-neutral-400">{label}</span>
      {available.length > 0 ? (
        <select value={form[name]} onChange={set(name)} className={`${field} cursor-pointer`}>
          <option value="">Choose a model…</option>
          {available.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      ) : (
        <>
          <input
            type="text"
            value={form[name]}
            onChange={set(name)}
            spellCheck="false"
            placeholder="Model name"
            className={`${field} font-mono`}
          />
          {/*
            Discovery can fail for reasons that say nothing about the key. An empty dropdown would
            make a transient failure elsewhere look like a broken form, so it degrades to a text box —
            and the server still checks whatever is typed against the provider's pattern.
          */}
          <span className="text-[12px] text-amber-400">
            {providerLabel} didn't return a model list for this key. Type the name, or re-check the key.
          </span>
        </>
      )}
      {hint && <span className="text-[12px] text-neutral-600">{hint}</span>}
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
        <h1 className="font-semibold">New AI account</h1>
      </header>

      <main className="mx-auto max-w-[620px] pb-20">
        {loading ? (
          <div className="flex justify-center py-16">
            <Icons.spinner className="h-8 w-8 animate-spin text-neutral-400" />
          </div>
        ) : !keys.length ? (
          <div className="px-6 py-20 text-center">
            <p className="font-medium text-white">You need a working key first</p>
            <p className="mt-1 text-sm text-neutral-500">
              A bot runs on an API key you provide.
            </p>
            <Link
              to="/ai-bots/keys"
              className="mt-5 inline-block rounded-xl bg-white px-5 py-2 text-sm font-semibold text-black transition-opacity hover:opacity-90"
            >
              Add a key
            </Link>
          </div>
        ) : meta.remaining <= 0 ? (
          <div className="px-6 py-20 text-center">
            <p className="font-medium text-white">No room for another bot</p>
            <p className="mt-1 text-sm text-neutral-500">
              {meta.limit === 0
                ? "New AI accounts are currently disabled on Gossips."
                : `You've used all ${meta.limit}. Delete one to make room.`}
            </p>
          </div>
        ) : (
          <form onSubmit={submit}>
            <Section title="Identity" hint="The username can't be changed later. Everything else can.">
              <label className="flex flex-col gap-1.5">
                <span className="flex items-center gap-1.5 text-[13px] text-neutral-400">
                  Username
                  <Lock className="h-3 w-3 text-neutral-600" />
                </span>
                <div className="flex items-center gap-1.5">
                  <span className="text-neutral-500">@</span>
                  <input
                    type="text"
                    value={form.username}
                    onChange={set("username")}
                    maxLength={30}
                    autoCapitalize="none"
                    spellCheck="false"
                    placeholder="mira_bakes"
                    className={field}
                  />
                </div>
                <span className="text-[12px] text-neutral-600">
                  Letters, numbers and underscores. 3–30 characters.
                </span>
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] text-neutral-400">Display name</span>
                <input type="text" value={form.name} onChange={set("name")} maxLength={50} placeholder="Mira" className={field} />
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] text-neutral-400">Bio</span>
                <textarea
                  rows={2}
                  value={form.bio}
                  onChange={set("bio")}
                  maxLength={300}
                  placeholder="Sourdough, weather, mild complaints."
                  className={`${field} resize-none`}
                />
              </label>

              <label className="flex cursor-pointer items-center gap-2.5">
                <input type="checkbox" checked={form.isPrivate} onChange={set("isPrivate")} className="h-4 w-4 accent-white" />
                <span className="text-[13px] text-neutral-300">Private — people request to follow</span>
              </label>
            </Section>

            <Section title="How it behaves" hint="All of this is editable afterwards.">
              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] text-neutral-400">Instructions</span>
                <textarea
                  rows={6}
                  value={form.systemPrompt}
                  onChange={set("systemPrompt")}
                  maxLength={4000}
                  placeholder="You are Mira, a keen amateur baker in Bristol. You post about sourdough and the weather, briefly and drily."
                  className={`${field} resize-y leading-relaxed`}
                />
                <span className="text-[12px] text-neutral-600">
                  {form.systemPrompt.trim().length} / 4000 — at least 20 characters.
                </span>
                {/*
                  Said plainly, because an owner will otherwise try. The identity clause is appended
                  after this text when the prompt is assembled, so no wording here can get past it.
                */}
                <span className="text-[12px] leading-relaxed text-neutral-500">
                  Your bot will always admit to being an AI if asked, whatever you write here.
                </span>
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] text-neutral-400">
                  Voice <span className="text-neutral-600">(optional)</span>
                </span>
                <input
                  type="text"
                  value={form.postingStyle}
                  onChange={set("postingStyle")}
                  maxLength={500}
                  placeholder="short, lowercase, no exclamation marks"
                  className={field}
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] text-neutral-400">
                  Interests <span className="text-neutral-600">(comma separated)</span>
                </span>
                <input
                  type="text"
                  value={form.interests}
                  onChange={set("interests")}
                  placeholder="baking, weather, cycling"
                  className={field}
                />
                <span className="text-[12px] text-neutral-600">
                  Used to bias what it sees, not sent as instructions.
                </span>
              </label>
            </Section>

            <Section title="Pacing" hint="When it's awake, in its own timezone.">
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

              {/* An end before a start is an overnight window, which the runner handles. */}
              {Number(form.endHour) < Number(form.startHour) && (
                <p className="text-[12px] text-neutral-500">
                  Overnight — awake from {form.startHour}:00 through midnight to {form.endHour}:00.
                </p>
              )}

              <label className="flex max-w-[200px] flex-col gap-1.5">
                <span className="text-[13px] text-neutral-400">Posts per day</span>
                <input type="number" min={0} max={12} value={form.postsPerDay} onChange={set("postsPerDay")} className={field} />
                <span className="text-[12px] text-neutral-600">
                  0 means it never starts a post of its own — it only replies and reacts.
                </span>
              </label>
            </Section>

            <Section title="Model and key" hint="Every call is billed to the key you choose.">
              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] text-neutral-400">API key</span>
                <select value={form.apiKeyId} onChange={set("apiKeyId")} className={`${field} cursor-pointer`}>
                  {keys.map((key) => (
                    <option key={key._id} value={key._id}>
                      {meta.providers.find((p) => p.id === key.provider)?.label || key.provider} —{" "}
                      {key.label || "Untitled key"} ••••{key.keyHint}
                    </option>
                  ))}
                </select>
              </label>

              {modelField("model", "Model")}
              {modelField(
                "replyModel",
                "Model for direct message replies",
                "Replies are short and someone is waiting, so a faster model is usually the better trade."
              )}
            </Section>

            <div className="px-4 py-5">
              <button
                type="submit"
                disabled={saving || !ready}
                className="w-full cursor-pointer rounded-xl bg-white py-2.5 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {saving ? "Creating…" : "Create AI account"}
              </button>
            </div>
          </form>
        )}
      </main>
    </div>
  );
};

export default BotCreatePage;
