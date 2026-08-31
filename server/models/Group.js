import { Schema, model } from "mongoose";

/**
 * Group — core group/channel document. Members are in GroupMember.
 *
 * Why split members:
 *   The old schema embedded members[] with rich subdocs. At 1000 members a
 *   single doc could be hundreds of KB and rewrite on every membership change.
 *   GroupMember scales linearly and lets us index/query by user (cross-group
 *   lookups) and filter banned users without scanning the array.
 */
const groupSchema = new Schema(
  {
    // Identity
    name:        { type: String, required: true, trim: true, maxlength: 100 },
    description: { type: String, default: "", maxlength: 500 },
    avatar:      { type: String, default: "/default-group-avatar.png" },

    type: { type: String, enum: ["public", "private", "secret"], default: "private" },

    /*
     * Settings, and only the ones that are actually enforced.
     *
     * This block used to carry another eleven — approvalRequired,
     * membersCanInvite, maxMembers, messageHistory, antiSpam, maxFileSizeMB,
     * profilePhotosVisible, memberListVisible, linkedGroups, invite links — plus
     * a `features` block of six toggles and an embedded `pinnedMessages` array.
     * Not one of them was read or written anywhere. A schema that describes
     * behaviour the code doesn't have is worse than a smaller one: it reads as a
     * promise, and the next person wires a settings screen to fields that do
     * nothing. Add them back alongside the code that honours them.
     *
     * `messageHistory` came back that way: it is the one of the eleven with a
     * plausible use, and it arrived with the eight read paths that honour it.
     *
     * Enforced in utils/chatAccess.js → resolveGroupSend (send-side) and
     * historyFloors (read-side).
     */
    settings: {
      slowModeSeconds: { type: Number, default: 0 },
      mediaSharing:    { type: Boolean, default: true },

      /*
       * How much of the past a member may read.
       *
       *   visible — everything, whenever they joined. The default, and what every
       *             group written before this field existed means.
       *   hidden  — nothing from before their own GroupMember.joinedAt.
       *
       * Two values, not the three the old schema named (`visible`,
       * `visible_to_new`, `hidden`): the middle one described the same observable
       * behaviour as `visible`, so it could never be tested apart from it, and a
       * branch nothing can distinguish is a branch that gets enforced
       * inconsistently.
       *
       * The floor is `joinedAt`, and leaving deletes the GroupMember row — so
       * rejoining gives a *new* joinedAt and a tighter floor. That is the safe
       * direction: leaving and coming back cannot be used to reopen history.
       *
       * No role exemption. An admin added last week cannot read last year's
       * messages either, which is what "hidden" plainly says, and it keeps the
       * rule to one predicate with no role branch in any of the eight places
       * that apply it.
       */
      messageHistory: {
        type: String,
        enum: ["visible", "hidden"],
        default: "visible",
      },
    },

    /*
     * Cached counts, derived from GroupMember by utils/groupCounts.js on every
     * membership change rather than incremented from several places at once.
     *
     * `messagesTotal` is gone. It was incremented by two of the four paths that
     * create a group message — the socket send and /share, but never a group
     * forward or a group poll — and never decremented on unsend, so it was always
     * wrong. And nothing read it: a repo-wide grep returned the schema line and the
     * two writes. So it was an extra write to the Group document on every group
     * message, buying an inaccurate number nobody looked at.
     *
     * If a UI ever wants it, `Message.countDocuments({conversation})` gives the
     * true figure on demand, and the only place that would show it is the group
     * info page, which is not a hot path. A derived count that is right beats a
     * cached one that drifts.
     */
    counts: {
      members: { type: Number, default: 0, min: 0 },
      admins:  { type: Number, default: 0, min: 0 },
    },

    isActive:  { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },

    /*
     * ── Invite link ───────────────────────────────────────────────────────────
     *
     * The share token, not the whole URL. Storing a URL would bake the current
     * origin into every group row, so a domain change would orphan every link
     * ever sent; the client composes the URL from this.
     *
     * Absent until someone asks for a link — a group nobody has shared has no
     * token to leak, and the field's absence is what the partial index below
     * relies on. `rotatedAt` is for the UI to say when a link was last replaced,
     * since rotating is the only way to revoke one.
     */
    inviteToken:    { type: String },
    inviteRotatedAt: Date,

    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

// Search & discovery
/*
 * The text index is gone: `globalSearch` is the only group search and it uses
 * an unanchored $regex, never $text. Mongo allows one text index per collection
 * and charges the most to maintain it, so an unused one is the worst kind.
 *
 * {type, isActive, isDeleted} stays — it's what a public-group discovery query
 * would need and it's the only compound here.
 */
groupSchema.index({ type: 1, isActive: 1, isDeleted: 1 });

/*
 * One group per invite token — and **partial**, not sparse.
 *
 * This exact field has bitten this codebase before: Message.js documents
 * `Group.inviteLink` as a latent E11000 because a sparse unique index skips a
 * *missing* value but happily indexes `null`, so the second group written without
 * a link collided with the first. A partial filter on `$type: "string"` means only
 * rows that actually carry a token participate, and a group with no invite link is
 * simply not in the index.
 *
 * Unique because the token is the whole of the authorisation to join: two groups
 * sharing one would put a joiner in whichever the query happened to find.
 */
groupSchema.index(
  { inviteToken: 1 },
  { unique: true, partialFilterExpression: { inviteToken: { $type: "string" } } }
);

export default model("Group", groupSchema);
