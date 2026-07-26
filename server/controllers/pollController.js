import Post from "../models/Post.js";
import Comment from "../models/Comment.js";
import PollVote from "../models/PollVote.js";
import { ok, fail, serverError } from "../utils/respond.js";
import { isPollClosed, projectPoll } from "../utils/attachments.js";
import { canViewAuthorContent } from "../utils/contentVisibility.js";

const MODELS = { post: Post, comment: Comment };

/**
 * Poll routes are separate from normal content routes, so they must repeat
 * the visibility check here rather than treating a known poll id as access.
 * A reply's own author can be public while the post it sits under is private.
 */
const canViewPollTarget = async (viewerId, type, doc) => {
  const canView = async (author) => {
    if (!author?._id) return false;
    // An unauthenticated reader can only see public content. `canViewAuthorContent`
    // intentionally expects an identity because it also evaluates blocks.
    if (!viewerId) return !author.isPrivate;
    return canViewAuthorContent(viewerId, author);
  };

  if (!(await canView(doc.author))) return false;
  if (type !== "comment") return true;

  const parentPost = await Post.findOne({ _id: doc.post, isDeleted: { $ne: true } })
    .select("author")
    .populate("author", "isPrivate")
    .lean();
  return Boolean(parentPost && (await canView(parentPost.author)));
};

/**
 * Voting in a poll attached to a post or a reply.
 *
 * The one-vote-per-person rule is enforced by the unique index on PollVote,
 * not by a read-then-write check here — two requests arriving together would
 * both pass a check and both increment. Insert first, let the index reject the
 * duplicate, and only bump the counter if the insert actually happened.
 */
export const voteInPoll = async (req, res) => {
  try {
    const { type, id } = req.params;
    const { optionId } = req.body;
    const userId = req.user._id;

    const Model = MODELS[type];
    if (!Model) return fail(res, "Unknown item type");
    if (typeof optionId !== "string" || !optionId) return fail(res, "Pick an option");

    const targetType = type === "comment" ? "Comment" : "Post";

    const doc = await Model.findOne({
      _id: id,
      isDeleted: { $ne: true },
      // Not yet public — you can't vote in a poll that hasn't been posted.
      ...(type === "comment" ? { isScheduled: { $ne: true } } : { isDraft: { $ne: true } }),
    })
      .select("author post poll")
      .populate("author", "username isPrivate accountStatus")
      .lean();

    if (!doc?.poll?.question) return fail(res, "That poll no longer exists", 404);

    // Same visibility rule as reading it: if you can't see the post, you can't
    // vote in its poll. A private account's poll isn't a public ballot.
    if (!(await canViewPollTarget(userId, type, doc))) {
      return fail(res, "That poll no longer exists", 404);
    }

    // Blocking cuts both ways — neither side should be able to affect the
    // other's numbers.
    if (isPollClosed(doc.poll)) return fail(res, "This poll has closed", 409);
    if (!doc.poll.closesAt) return fail(res, "This poll hasn't started yet", 409);

    const option = doc.poll.options.find((o) => o.id === optionId);
    if (!option) return fail(res, "That isn't one of the options");

    let vote;
    try {
      vote = await PollVote.create({ targetType, target: id, user: userId, optionId });
    } catch (error) {
      // E11000: the unique index caught a second vote from the same person.
      if (error?.code === 11000) {
        const existing = await PollVote.findOne({ targetType, target: id, user: userId }).lean();
        const fresh = await Model.findById(id).select("poll").lean();
        if (!fresh?.poll) return fail(res, "That poll no longer exists", 404);
        // The poll rides along so the client can correct itself — this is the
        // case where two tabs voted, and the loser needs the real state.
        return res.status(409).json({
          success: false,
          error: { message: "You've already voted in this poll" },
          data: { poll: projectPoll(fresh.poll, existing) },
        });
      }
      throw error;
    }

    /*
     * Bump the tally.
     *
     * Positional `$` matches the option by its id, so a concurrent edit that
     * reordered the array couldn't send the vote to the wrong row. The filter
     * repeats the closed check as a date comparison, so a vote that arrives in
     * the same instant the poll expires is counted consistently with what the
     * next reader sees — the row is already written either way, which keeps
     * "have I voted" honest even if the count didn't move.
     */
    const increment = await Model.updateOne(
      {
        _id: id,
        "poll.options.id": optionId,
        // The pre-insert read is only a fast rejection. This write is the
        // authoritative expiry check, closing the race at the poll deadline.
        "poll.closesAt": { $gt: new Date() },
      },
      { $inc: { "poll.options.$.votes": 1, "poll.totalVotes": 1 } }
    );

    if (increment.modifiedCount !== 1) {
      // Never leave a vote that did not make it into the visible tally. This
      // also lets a user retry safely when the deadline won the race.
      await PollVote.deleteOne({ _id: vote._id });
      return fail(res, "This poll has closed", 409);
    }

    const fresh = await Model.findById(id).select("poll").lean();
    return ok(res, { poll: projectPoll(fresh.poll, vote) });
  } catch (error) {
    return serverError(res, error, "Couldn't record your vote");
  }
};

/**
 * The current state of one poll, for a reader who wants it refreshed without
 * reloading the feed — a countdown hitting zero, mainly.
 */
export const getPoll = async (req, res) => {
  try {
    const { type, id } = req.params;
    const Model = MODELS[type];
    if (!Model) return fail(res, "Unknown item type");

    const doc = await Model.findOne({
      _id: id,
      isDeleted: { $ne: true },
      ...(type === "comment" ? { isScheduled: { $ne: true } } : { isDraft: { $ne: true } }),
    })
      .select("author post poll")
      .populate("author", "username isPrivate accountStatus")
      .lean();

    if (!doc?.poll?.question) return fail(res, "That poll no longer exists", 404);
    if (!(await canViewPollTarget(req.user?._id, type, doc))) {
      return fail(res, "That poll no longer exists", 404);
    }

    const targetType = type === "comment" ? "Comment" : "Post";
    const myVote = req.user?._id
      ? await PollVote.findOne({ targetType, target: id, user: req.user._id }).lean()
      : null;

    return ok(res, { poll: projectPoll(doc.poll, myVote) });
  } catch (error) {
    return serverError(res, error, "Couldn't load that poll");
  }
};
