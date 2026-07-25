// Shared "Who can reply & quote" audience options.
// Keep values in sync with the backend enum on Post/Comment models:
//   "anyone" | "followers" | "following" | "mentioned"

export const REPLY_AUDIENCE_OPTIONS = [
  { value: "anyone", label: "Anyone", triggerText: "Anyone can reply & quote" },
  {
    value: "followers",
    label: "Your Followers",
    triggerText: "Your followers can reply & quote",
  },
  {
    value: "following",
    label: "Profiles you Follow",
    triggerText: "Profiles you follow can reply & quote",
  },
  {
    value: "mentioned",
    label: "Profiles you mention",
    triggerText: "Profiles you mention can reply & quote",
  },
];

export const getReplyTriggerText = (value) =>
  REPLY_AUDIENCE_OPTIONS.find((o) => o.value === value)?.triggerText ||
  REPLY_AUDIENCE_OPTIONS[0].triggerText;

// Shown to a viewer who isn't allowed to reply/quote (page hint + toast).
export const REPLY_RESTRICTED_TEXT = "Only some profiles can reply to this gossip.";
