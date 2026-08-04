import React from "react";
import { groupEventText } from "../../lib/groupEventText";

/**
 * A group event, as a quiet line across the thread.
 *
 * Not a bubble: it isn't from anyone, so giving it a sender's side, a tail and a
 * gradient would make "Ana changed the group photo" look like something Ana said.
 * Centred, dimmed and full width — the same treatment a date divider gets, because it
 * is the same kind of thing.
 *
 * Renders nothing for an unrecognised event rather than an empty pill: a client older
 * than the server should be silent, not visibly broken.
 */
const SystemMessageBubble = ({ message, viewerId }) => {
  const text = groupEventText(message, viewerId);
  if (!text) return null;

  return (
    <p className="px-6 py-1 text-center text-[12px] leading-relaxed text-neutral-500">
      {text}
    </p>
  );
};

export default SystemMessageBubble;
