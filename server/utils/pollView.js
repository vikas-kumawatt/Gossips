/**
 * What a poll looks like to one particular reader.
 *
 * `poll.isAnonymous` was stored, and honoured nowhere. Every read path and
 * every `pollUpdated` broadcast shipped the whole `poll` object with
 * `options[].votes[].userId` intact, so an "anonymous" poll told the entire
 * room exactly who had voted for what — the one thing the setting exists to
 * prevent. The client didn't display it, which is not the same as it being
 * private: it was in the response body.
 *
 * The reader's *own* vote is always kept, anonymous or not. The UI has to show
 * you what you picked, and telling you your own vote leaks nothing.
 *
 * The vote *counts* stay either way. An anonymous poll hides who voted, not how
 * many did — `settings.showVoteCount` is the separate switch for that, and it's
 * a display preference rather than a privacy boundary, so it stays a client
 * concern.
 */

const sameId = (a, b) => a && b && a.toString() === b.toString();

/** One poll, viewed by `viewerId`. Returns a new object; never mutates. */
export const pollFor = (poll, viewerId) => {
  if (!poll) return poll;

  const options = (poll.options || []).map((option) => {
    const votes = option.votes || [];
    const mine = votes.some((v) => sameId(v.userId, viewerId));

    return {
      ...option,
      // Identities are dropped wholesale for an anonymous poll; the viewer's
      // own participation survives as a flag rather than as an id.
      votes: poll.isAnonymous
        ? votes.filter((v) => sameId(v.userId, viewerId))
        : votes,
      voteCount: option.voteCount ?? votes.length,
      votedByMe: mine,
    };
  });

  return { ...poll, options };
};

/**
 * Apply `pollFor` to a message, in place, if it carries a poll.
 *
 * Messages arrive here from `.lean()` reads and from `.toObject()`, so they're
 * plain objects in both cases.
 */
export const applyPollView = (message, viewerId) => {
  if (message?.poll) message.poll = pollFor(message.poll, viewerId);
  return message;
};

/** The list form, for a page of messages. */
export const applyPollViews = (messages, viewerId) => {
  if (Array.isArray(messages)) {
    for (const message of messages) applyPollView(message, viewerId);
  }
  return messages;
};
