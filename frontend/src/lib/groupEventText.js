/**
 * Turn a stored group event into a sentence, from one viewer's point of view.
 *
 * The server stores `{kind, actor, targets, value}` rather than a finished string
 * precisely so this can exist: the same row has to read "You added Ben" to the actor and
 * "Ana added you" to Ben, and that is not a substitution you can perform on a sentence
 * someone else already wrote.
 *
 * Names, not handles. A system notice is prose, and "@ana_1994 added @b_cole" reads like
 * a log line — full names are what a person recognises. Falls back to the handle when
 * there is no name, and to "Someone" when the account is gone.
 *
 * Pure, so every kind and both perspectives are testable without rendering anything.
 */

const nameOf = (user, viewerId, { capitalise = false } = {}) => {
  if (!user) return "Someone";
  if (viewerId && String(user._id) === String(viewerId)) {
    return capitalise ? "You" : "you";
  }
  return user.name || user.username || "Someone";
};

/** "Ana", "Ana and Ben", "Ana, Ben and 2 others" — bounded, because a batch can be 25. */
const listNames = (users, viewerId) => {
  const names = (users || []).map((u) => nameOf(u, viewerId));
  if (names.length === 0) return "someone";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  const remaining = names.length - 2;
  return `${names[0]}, ${names[1]} and ${remaining} other${remaining === 1 ? "" : "s"}`;
};

const ROLE_LABEL = {
  admin: "an admin",
  member: "a member",
  restricted: "muted in this group",
};

/**
 * @param message A message with `messageType: "system"` and a populated `system` block.
 * @param viewerId The reader, so the sentence can address them directly.
 * @returns A string, or null when there's nothing sensible to say.
 */
export const groupEventText = (message, viewerId) => {
  const event = message?.system;
  if (!event?.kind) return null;

  const actor = nameOf(event.actor, viewerId, { capitalise: true });
  const targets = event.targets || [];

  switch (event.kind) {
    case "group_renamed":
      // The new name is quoted: group names contain spaces and ordinary words, and
      // without quotes "Ana changed the group name to weekend plans" runs together.
      return event.value
        ? `${actor} changed the group name to "${event.value}"`
        : `${actor} changed the group name`;

    case "group_avatar_changed":
      return `${actor} changed the group photo`;

    case "members_added":
      return `${actor} added ${listNames(targets, viewerId)}`;

    case "member_removed": {
      /*
       * An admin removing themselves is a leave, not a removal — the People page's
       * remove action can't target you, but `leaveGroup` and this share a socket event
       * and a stored kind is forever, so the copy handles it.
       */
      const target = targets[0];
      if (target && String(target._id) === String(event.actor?._id)) {
        return `${actor} left`;
      }
      return `${actor} removed ${listNames(targets, viewerId)}`;
    }

    case "member_left":
      return `${actor} left`;

    case "member_joined":
      // "joined", with no actor doing the adding: they followed an invite link.
      return `${actor} joined using an invite link`;

    case "role_changed": {
      const who = listNames(targets, viewerId);
      const label = ROLE_LABEL[event.value];
      if (!label) return `${actor} changed ${who}'s role`;
      if (event.value === "restricted") return `${actor} muted ${who} in this group`;
      return `${actor} made ${who} ${label}`;
    }

    default:
      // An unknown kind means this client is older than the server. Silence is the
      // right answer — better a missing line than "undefined".
      return null;
  }
};

/** The one-line form for a chat list row or a reply preview. */
export const groupEventPreview = (message, viewerId) =>
  groupEventText(message, viewerId) || "Group updated";
