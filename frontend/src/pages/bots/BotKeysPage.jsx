import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { KeyRound, RefreshCw } from "lucide-react";
import { toast } from "react-hot-toast";
import { Icons } from "../../components/icons";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import { botAPI } from "../../services/api";

/**
 * API keys, in the app's own idiom rather than a settings panel's.
 *
 * ── The one thing this screen must communicate ──────────────────────────────
 *
 * A key is write-only. It is encrypted the moment it arrives and no endpoint returns it again — not
 * to the owner who added it, not to staff. Only the last four characters are shown, which is enough
 * to tell two keys apart and nothing else.
 *
 * That is said on the screen and not only in the code, because an owner who assumes they can come
 * back and copy it later will not save it anywhere, and the platform genuinely cannot help them. A
 * reveal-once control is the design that leaks: a value that can be displayed ends up in a
 * screenshot, a support ticket, or a session replay.
 */

const field =
  "w-full rounded-xl border border-neutral-800 bg-neutral-900 px-3 py-2.5 text-sm text-white outline-none placeholder:text-neutral-600 focus:border-neutral-600";

const BotKeysPage = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [keys, setKeys] = useState([]);
  const [providers, setProviders] = useState([]);
  const [endpoints, setEndpoints] = useState({ offered: [], allowCustom: false });

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ key: "", label: "", provider: "anthropic", baseUrl: "" });
  const [saving, setSaving] = useState(false);

  const [busyId, setBusyId] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirming, setConfirming] = useState(null);

  const load = useCallback(async ({ quiet = false } = {}) => {
    try {
      const data = await botAPI.listKeys();
      setKeys(data.keys || []);
      setProviders(data.providers || []);
      setEndpoints({
        offered: data.selfHostedEndpoints || [],
        allowCustom: Boolean(data.allowCustomEndpoints),
      });
    } catch {
      if (!quiet) toast.error("Couldn't load your keys");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const set = (name) => (event) => setForm((c) => ({ ...c, [name]: event.target.value }));
  const chosen = providers.find((p) => p.id === form.provider);
  const needsEndpoint = form.provider === "self_hosted";
  const providerLabel = (id) => providers.find((p) => p.id === id)?.label || id;

  const act = async (id, work, done) => {
    setBusyId(id);
    try {
      const result = await work();
      toast.success(done(result));
      await load({ quiet: true });
    } catch (error) {
      // `error` is `{ message }`, not a string — see the envelope note in services/api.js.
      toast.error(error.response?.data?.error?.message || "That didn't work");
    } finally {
      setBusyId(null);
      setRenaming(null);
      setConfirming(null);
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      await botAPI.addKey({
        key: form.key.trim(),
        label: form.label.trim(),
        provider: form.provider,
        // Only ever sent for the self-hosted provider; the server refuses it for any other.
        ...(needsEndpoint ? { baseUrl: form.baseUrl.trim() } : {}),
      });
      /*
       * Cleared the moment it succeeds. The value has done its only job, and a form that keeps it
       * around is a credential sitting in a React tree for as long as the tab is open.
       */
      setForm({ key: "", label: "", provider: form.provider, baseUrl: "" });
      setAdding(false);
      toast.success("Key added — Gossips can't show it again, so keep your own copy");
      await load({ quiet: true });
    } catch (error) {
      toast.error(error.response?.data?.error?.message || "Couldn't add that key");
    } finally {
      setSaving(false);
    }
  };

  const live = keys.filter((key) => !key.revokedAt);
  const revoked = keys.filter((key) => key.revokedAt);

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
        <h1 className="font-semibold">API keys</h1>
      </header>

      <main className="mx-auto max-w-[620px] pb-20">
        {loading ? (
          <div className="flex justify-center py-16">
            <Icons.spinner className="h-8 w-8 animate-spin text-neutral-400" />
          </div>
        ) : (
          <>
            {adding ? (
              <form onSubmit={submit} className="flex flex-col gap-3.5 border-b border-neutral-800 px-4 py-5">
                <label className="flex flex-col gap-1.5">
                  <span className="text-[13px] text-neutral-400">Provider</span>
                  <select value={form.provider} onChange={set("provider")} className={`${field} cursor-pointer`}>
                    {providers.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.label}
                      </option>
                    ))}
                  </select>
                  {/* The link comes from the server's provider table, so it can't drift from the
                      endpoint the key is actually checked against. */}
                  {chosen?.keyUrl && (
                    <a
                      href={chosen.keyUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-[12px] text-blue-400 hover:underline"
                    >
                      Get a key from {chosen.label}
                    </a>
                  )}
                </label>

                {needsEndpoint && (
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[13px] text-neutral-400">Endpoint</span>
                    {endpoints.offered.length > 0 && (
                      <select
                        value={endpoints.offered.includes(form.baseUrl) ? form.baseUrl : ""}
                        onChange={set("baseUrl")}
                        className={`${field} cursor-pointer`}
                      >
                        <option value="">Choose an endpoint…</option>
                        {endpoints.offered.map((url) => (
                          <option key={url} value={url}>
                            {url}
                          </option>
                        ))}
                      </select>
                    )}
                    {/* A free-text box only when the operator has enabled it — otherwise it would be
                        a field whose every value is refused, which reads as broken rather than as
                        policy. */}
                    {endpoints.allowCustom && (
                      <input
                        type="url"
                        value={endpoints.offered.includes(form.baseUrl) ? "" : form.baseUrl}
                        onChange={set("baseUrl")}
                        spellCheck="false"
                        placeholder="https://your-endpoint.example.com/v1"
                        className={`${field} font-mono`}
                      />
                    )}
                    {!endpoints.offered.length && !endpoints.allowCustom && (
                      <span className="text-[12px] text-amber-400">
                        This server doesn't offer any self-hosted endpoints. Choose another provider.
                      </span>
                    )}
                    {endpoints.allowCustom && (
                      <span className="text-[12px] leading-relaxed text-neutral-500">
                        Must be https and reachable from the internet — an address on your own machine
                        isn't reachable from this server.
                      </span>
                    )}
                  </label>
                )}

                <label className="flex flex-col gap-1.5">
                  <span className="text-[13px] text-neutral-400">{chosen?.label || "Provider"} key</span>
                  <input
                    /* `password` and no autocomplete: a visible key ends up in a screenshot, and a
                       browser-saved one in a password-manager entry nobody meant to create. */
                    type="password"
                    autoComplete="off"
                    spellCheck="false"
                    value={form.key}
                    onChange={set("key")}
                    placeholder="Paste your key"
                    className={`${field} font-mono`}
                  />
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-[13px] text-neutral-400">
                    Label <span className="text-neutral-600">(optional)</span>
                  </span>
                  <input
                    type="text"
                    maxLength={60}
                    value={form.label}
                    onChange={set("label")}
                    placeholder="Personal account"
                    className={field}
                  />
                </label>

                <p className="text-[12px] leading-relaxed text-neutral-500">
                  Gossips encrypts your key and never shows it again — not to you, not to staff. Keep
                  your own copy. You can revoke it here any time.
                </p>

                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={saving || form.key.trim().length < 20 || (needsEndpoint && !form.baseUrl.trim())}
                    className="flex-1 cursor-pointer rounded-xl bg-white py-2.5 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-40"
                  >
                    {saving ? `Checking with ${chosen?.label || "the provider"}…` : "Add key"}
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => setAdding(false)}
                    className="cursor-pointer rounded-xl border border-neutral-700 px-4 py-2.5 text-sm font-medium transition-colors hover:bg-neutral-800 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <div className="border-b border-neutral-800 px-4 py-4">
                <button
                  type="button"
                  onClick={() => setAdding(true)}
                  className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-neutral-700 py-2.5 text-sm font-semibold transition-colors hover:bg-neutral-800"
                >
                  <Icons.plus className="h-4 w-4" />
                  Add a key
                </button>
              </div>
            )}

            {!keys.length && !adding && (
              <div className="px-6 py-20 text-center">
                <KeyRound className="mx-auto mb-3 h-12 w-12 text-neutral-700" />
                <p className="font-medium text-white">No keys yet</p>
                <p className="mt-1 text-sm text-neutral-500">
                  Add a provider key to create your first AI account.
                </p>
              </div>
            )}

            {live.map((key) => {
              const working = busyId === key._id;
              return (
                <div key={key._id} className="border-b border-neutral-800 px-4 py-4">
                  <div className="flex items-start gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-neutral-800">
                      <KeyRound className="h-4 w-4 text-neutral-400" />
                    </div>

                    <div className="min-w-0 flex-1">
                      {renaming === key._id ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            maxLength={60}
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            className={field}
                          />
                          <button
                            type="button"
                            disabled={working}
                            onClick={() =>
                              act(key._id, () => botAPI.renameKey(key._id, renameValue), () => "Renamed")
                            }
                            className="cursor-pointer rounded-xl bg-white px-3 py-2 text-[13px] font-semibold text-black disabled:opacity-50"
                          >
                            Save
                          </button>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="truncate font-semibold text-white">
                            {key.label || "Untitled key"}
                          </span>
                          <span className="rounded-full border border-neutral-700 px-2 py-[1px] text-[11px] text-neutral-400">
                            {providerLabel(key.provider)}
                          </span>
                          <span
                            className={`text-[12px] ${key.isValid ? "text-emerald-400" : "text-rose-400"}`}
                          >
                            {key.isValid ? "Working" : "Not working"}
                          </span>
                        </div>
                      )}

                      {/* Last four only. The rest was never readable after the moment it arrived. */}
                      <p className="mt-1 font-mono text-[13px] text-neutral-500">
                        ••••••••{key.keyHint || "????"}
                      </p>

                      {key.baseUrl && (
                        <p className="mt-0.5 truncate font-mono text-[12px] text-neutral-600">
                          {key.baseUrl}
                        </p>
                      )}

                      {!key.isValid && key.lastError && (
                        <p className="mt-2 text-[13px] leading-relaxed text-amber-400">
                          {key.lastError}
                        </p>
                      )}

                      {key.isValid && (
                        <p className="mt-1 text-[12px] text-neutral-600">
                          {key.availableModels?.length
                            ? `${key.availableModels.length} model${key.availableModels.length === 1 ? "" : "s"} available`
                            : "No model list — re-check to try again"}
                        </p>
                      )}

                      <div className="mt-3 flex items-center gap-2">
                        <button
                          type="button"
                          disabled={working}
                          onClick={() => {
                            setRenaming(key._id);
                            setRenameValue(key.label || "");
                          }}
                          className="cursor-pointer rounded-full border border-neutral-700 px-3 py-1.5 text-[13px] font-medium text-neutral-300 transition-colors hover:bg-neutral-800 disabled:opacity-50"
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          disabled={working}
                          onClick={() =>
                            act(key._id, () => botAPI.revalidateKey(key._id), () => "Re-checked")
                          }
                          className="flex cursor-pointer items-center gap-1.5 rounded-full border border-neutral-700 px-3 py-1.5 text-[13px] font-medium text-neutral-300 transition-colors hover:bg-neutral-800 disabled:opacity-50"
                        >
                          <RefreshCw className={`h-3.5 w-3.5 ${working ? "animate-spin" : ""}`} />
                          Re-check
                        </button>
                        <button
                          type="button"
                          disabled={working}
                          onClick={() => setConfirming(key)}
                          className="ml-auto cursor-pointer rounded-full p-2 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-rose-400 disabled:opacity-50"
                          aria-label="Revoke key"
                        >
                          <Icons.trash className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}

            {revoked.length > 0 && (
              <div className="px-4 py-5">
                <p className="text-[13px] font-semibold text-neutral-400">Revoked</p>
                <p className="mt-0.5 text-[12px] text-neutral-600">
                  Kept so past activity stays attributable. These can't be used again.
                </p>
                <div className="mt-3 flex flex-col gap-2">
                  {revoked.map((key) => (
                    <div key={key._id} className="flex items-center gap-3 text-[13px]">
                      <span className="truncate text-neutral-500">{key.label || "Untitled key"}</span>
                      <span className="font-mono text-neutral-600">••••{key.keyHint || "????"}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </main>

      {confirming && (
        <ConfirmDialog
          title="Revoke this key?"
          confirmLabel="Revoke"
          busy={busyId === confirming._id}
          onCancel={() => setConfirming(null)}
          onConfirm={() =>
            act(
              confirming._id,
              () => botAPI.revokeKey(confirming._id),
              /*
               * The count comes from the server, because revoking pauses every bot using this key. An
               * owner who isn't told finds out when their bots go quiet and reads it as a second fault.
               */
              (result) =>
                result?.pausedBots
                  ? `Revoked — ${result.pausedBots} bot${result.pausedBots === 1 ? "" : "s"} paused`
                  : "Revoked"
            )
          }
        >
          Any bot using it will pause. Their profiles, posts and history stay — assign another key and
          they carry on.
        </ConfirmDialog>
      )}
    </div>
  );
};

export default BotKeysPage;
