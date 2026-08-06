import mongoose from "mongoose";
import { DEFAULT_PROVIDER, PROVIDER_IDS } from "../bots/providers.js";

const { Schema, model } = mongoose;

/**
 * An owner-supplied provider key (BYOK).
 *
 * The platform never buys inference. An owner adds their own Anthropic key, their bots
 * spend it, and the platform's job is to hold it safely and stop it being abused.
 *
 * Nothing here is ever sent to a client. The ciphertext is `select: false` so it takes a
 * deliberate `.select("+encryptedKey")` to load — the same guard `User.password` uses —
 * and `toJSON` deletes it as a second line of defence for the case where someone does
 * select it and then returns the document by accident. Two mechanisms because one of them
 * is a habit and the other is a rule.
 */

const apiKeySchema = new Schema(
  {
    // See the note on indexes at the foot of this file: `{ owner, revokedAt, createdAt }`
    // starts with `owner`, so a field-level index here would be a redundant second copy.
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },

    /*
     * The `v1.<iv>.<tag>.<ciphertext>` envelope from utils/keyVault.js.
     *
     * `select: false`: every read that doesn't explicitly ask for it gets a document with
     * no key in it at all, so the default failure mode of a new endpoint is to leak
     * nothing. Exactly one place asks for it — the call path that is about to use it.
     */
    encryptedKey: { type: String, required: true, select: false },

    /*
     * The last four characters, so an owner can tell two keys apart in a list.
     *
     * Named for what it is. The spec calls this field `keyPrefix` while describing it as
     * "last 4 chars", which is a contradiction worth not carrying forward: keys from a given
     * provider share a prefix — `sk-ant-`, `xai-`, `gsk_`, `AIza` — so a real prefix would
     * identify the provider and not the key, and leaking more leading characters buys the
     * owner no recognition at all. The last four are the only part that distinguishes two
     * keys from the same provider, which is the whole job.
     */
    keyHint: { type: String, default: "" },

    /*
     * Keyed HMAC of the plaintext, so "you already added this key" can be answered
     * without decrypting anything — and so the unique index below can enforce it.
     *
     * `select: false` as well. It isn't the key, but it is a stable identifier *for* the
     * key, and a client has no use for one.
     */
    fingerprint: { type: String, required: true, select: false },

    /*
     * Which provider this key belongs to.
     *
     * The enum comes from `bots/providers.js`, so adding a provider there is the only edit needed
     * — a second list here is a second thing to forget. Anthropic remains the default because
     * existing rows predate this field and because it is the one provider with a measured eval
     * history behind it.
     *
     * The base URL is deliberately *not* stored. It is looked up from the provider table at call
     * time, so a stored row can never point our server at a host of someone else's choosing — see
     * the SSRF note in providers.js. That is also why a per-key custom endpoint is a separate
     * phase rather than a field here.
     */
    provider: { type: String, default: DEFAULT_PROVIDER, enum: PROVIDER_IDS },

    /*
     * The models this key can actually reach, as reported by the provider.
     *
     * Discovered at save and on every revalidate, rather than hardcoded. Model ids churn faster
     * than deploys — every provider in the table has renamed or retired a flagship — so a list in
     * source goes stale, and its failure mode is a picker offering a model the provider no longer
     * serves. Asking the provider is always current, and it has the additional virtue of showing
     * only what *this* key is entitled to, which a global list cannot express.
     *
     * Filtered through the provider's `modelCeiling` before it lands here, so an unexpected
     * response cannot put an arbitrary model in front of an owner.
     */
    availableModels: { type: [String], default: [] },
    modelsFetchedAt: { type: Date, default: null },

    /*
     * The endpoint, for the one provider whose URL is not in the table.
     *
     * Empty for every hosted provider, and that is enforced rather than assumed — a `baseUrl` on an
     * Anthropic key would be a field the caller might one day start honouring, which is how a
     * validated URL turns back into an arbitrary one. Only `self_hosted` may carry it, and only after
     * `bots/selfHosted.js` has cleared it.
     */
    baseUrl: { type: String, default: "" },

    /*
     * Who supplied that URL: `operator` (from AppSettings) or `owner` (from a request).
     *
     * Stored rather than re-derived, because the rules differ and the *source* is the thing that
     * decides them. An owner-supplied endpoint is re-validated against DNS before every call; an
     * operator's is not, because they own the network. Losing this field would mean either re-checking
     * the operator's loopback address against a public-address rule — and failing it — or skipping the
     * check for everyone.
     */
    endpointSource: { type: String, enum: ["operator", "owner", ""], default: "" },

    /** The owner's own name for it. Free text, shown only to them. */
    label: { type: String, default: "", maxlength: 60, trim: true },

    /*
     * Validity is a first-class state, not an exception.
     *
     * A key that has been revoked at the provider, or run out of credit, is the expected
     * end of every key's life. The bots that use it pause and stay visible; they don't
     * error on every cycle. `lastError` holds the provider's own wording so the owner is
     * told *why*, rather than a generic failure.
     */
    isValid: { type: Boolean, default: true },
    lastValidatedAt: { type: Date, default: null },
    lastError: { type: String, default: "" },

    /*
     * Soft delete. Revoking a key must not delete the bots that used it — the owner is
     * asked to reassign instead, and their personas, memories and posts survive.
     */
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/*
 * One live copy of a given key per owner.
 *
 * **Partial, not sparse.** `models/Message.js` documents this hazard at length and it
 * applies exactly here: a sparse unique index skips a *missing* value but happily indexes
 * `null`, so the second row with `revokedAt: null` would collide with the first — which is
 * every unrevoked key, i.e. the common case. The partial filter puts only live keys in the
 * index, so revoking one frees the owner to add it again.
 */
apiKeySchema.index(
  { owner: 1, fingerprint: 1 },
  { unique: true, partialFilterExpression: { revokedAt: null } }
);

/** The owner's key list: live keys, newest first. */
apiKeySchema.index({ owner: 1, revokedAt: 1, createdAt: -1 });

/**
 * Belt and braces over `select: false`.
 *
 * If a future caller selects the ciphertext and then hands the document to `res.json`,
 * this is what stops the key going out over the wire. `User.js` does the same thing for
 * `password`, and for the same reason: the cost is two lines and the failure it prevents
 * is unrecoverable.
 */
apiKeySchema.set("toJSON", {
  transform: (_doc, ret) => {
    delete ret.encryptedKey;
    delete ret.fingerprint;
    return ret;
  },
});
apiKeySchema.set("toObject", {
  transform: (_doc, ret) => {
    delete ret.encryptedKey;
    delete ret.fingerprint;
    return ret;
  },
});

/** What an owner is allowed to see about their own key. */
apiKeySchema.methods.toOwnerView = function () {
  return {
    _id: this._id,
    label: this.label,
    provider: this.provider,
    keyHint: this.keyHint,
    /*
     * The discovered model list travels with the key, because that is the scope it belongs to: the
     * picker for a bot has to show what *this* key can reach, and a global list would offer models
     * the owner's account isn't entitled to.
     */
    availableModels: this.availableModels || [],
    modelsFetchedAt: this.modelsFetchedAt,
    /*
     * The endpoint is shown back, unlike the key. It is not a secret — the owner typed it, or the
     * operator published it — and the dashboard has to display which endpoint a key points at or a
     * list of self-hosted keys is indistinguishable.
     */
    baseUrl: this.baseUrl || "",
    endpointSource: this.endpointSource || "",
    isValid: this.isValid,
    lastValidatedAt: this.lastValidatedAt,
    lastError: this.lastError,
    revokedAt: this.revokedAt,
    createdAt: this.createdAt,
  };
};

export default model("ApiKey", apiKeySchema);
