/**
 * Report taxonomy — what a user can report and why.
 *
 * KEEP IN SYNC with server/utils/reportCategories.js (same data, this renders
 * it, the server validates against it).
 */

export const REPORT_CATEGORIES = [
  {
    id: "spam",
    label: "Spam",
    description: "Repetitive, misleading or bot-driven content",
    appliesTo: ["post", "comment", "message", "conversation", "user"],
    subcategories: [
      { id: "unwanted_commercial", label: "Unwanted commercial content" },
      { id: "bots_fake_engagement", label: "Bots or fake engagement" },
      { id: "repetitive_posting", label: "Posting the same thing repeatedly" },
      { id: "malicious_links", label: "Malicious or misleading links" },
    ],
  },
  {
    id: "nudity",
    label: "Nudity or sexual activity",
    description: "Sexual content, or content shared without consent",
    appliesTo: ["post", "comment", "message", "conversation", "user"],
    subcategories: [
      { id: "adult_nudity", label: "Adult nudity or sexual acts" },
      { id: "sexual_services", label: "Sexual services or solicitation" },
      { id: "non_consensual_images", label: "Sharing private images without consent" },
      { id: "minor_sexualisation", label: "Involves a minor" },
    ],
  },
  {
    id: "hate",
    label: "Hate speech or symbols",
    description: "Attacks on people based on who they are",
    appliesTo: ["post", "comment", "message", "conversation", "user"],
    subcategories: [
      { id: "slurs", label: "Slurs or degrading language" },
      { id: "hate_symbols", label: "Hate symbols or imagery" },
      { id: "dehumanising_speech", label: "Dehumanising speech" },
      { id: "targeted_group_attack", label: "Attacking a protected group" },
    ],
  },
  {
    id: "violence",
    label: "Violence or dangerous organisations",
    description: "Threats, graphic violence or extremism",
    appliesTo: ["post", "comment", "message", "conversation", "user"],
    subcategories: [
      { id: "violent_threats", label: "Threats of violence" },
      { id: "graphic_violence", label: "Extremely graphic violence" },
      { id: "terrorism_extremism", label: "Terrorism or violent extremism" },
      { id: "animal_abuse", label: "Animal abuse" },
    ],
  },
  {
    id: "bullying",
    label: "Bullying or harassment",
    description: "Targeting someone to demean or intimidate them",
    appliesTo: ["post", "comment", "message", "conversation", "user"],
    subcategories: [
      { id: "targeted_harassment", label: "Harassing me or someone I know" },
      { id: "unwanted_contact", label: "Unwanted or repeated contact" },
      { id: "threats_to_share", label: "Threatening to share private content" },
      { id: "doxxing", label: "Sharing private information" },
    ],
  },
  {
    id: "false_info",
    label: "False information",
    description: "Misleading claims or manipulated media",
    appliesTo: ["post", "comment", "user"],
    subcategories: [
      { id: "health_misinformation", label: "Health misinformation" },
      { id: "election_misinformation", label: "Election or political misinformation" },
      { id: "manipulated_media", label: "Digitally altered or AI-generated media" },
      { id: "other_misinformation", label: "Other false information" },
    ],
  },
  {
    id: "scam",
    label: "Scam or fraud",
    description: "Attempts to trick people out of money or data",
    appliesTo: ["post", "comment", "message", "conversation", "user"],
    subcategories: [
      { id: "phishing", label: "Phishing or stealing account details" },
      { id: "fake_giveaway", label: "Fake giveaway or prize" },
      { id: "investment_scam", label: "Investment or crypto scam" },
      { id: "romance_scam", label: "Romance scam" },
      { id: "brand_impersonation", label: "Pretending to be a business" },
    ],
  },
  {
    id: "illegal",
    label: "Sale of illegal or regulated goods",
    description: "Buying or selling restricted items",
    appliesTo: ["post", "comment", "message", "conversation", "user"],
    subcategories: [
      { id: "drugs", label: "Drugs" },
      { id: "weapons", label: "Weapons or firearms" },
      { id: "counterfeit_goods", label: "Counterfeit goods" },
      { id: "endangered_wildlife", label: "Endangered animals or wildlife" },
    ],
  },
  {
    id: "self_harm",
    label: "Suicide, self-injury or eating disorders",
    description: "Content that could put someone at risk",
    appliesTo: ["post", "comment", "message", "conversation", "user"],
    subcategories: [
      { id: "suicide_self_injury", label: "Suicide or self-injury" },
      { id: "eating_disorder", label: "Disordered eating" },
      { id: "encouraging_self_harm", label: "Encouraging someone to hurt themselves" },
    ],
  },
  {
    id: "ip",
    label: "Intellectual property",
    description: "Use of your copyright or trademark",
    appliesTo: ["post", "comment", "user"],
    subcategories: [
      { id: "copyright", label: "Copyright infringement" },
      { id: "trademark", label: "Trademark infringement" },
    ],
  },
  {
    id: "impersonation",
    label: "Impersonation",
    description: "Pretending to be someone they aren't",
    appliesTo: ["user"],
    subcategories: [
      { id: "impersonating_me", label: "Pretending to be me" },
      { id: "impersonating_someone", label: "Pretending to be someone I know" },
      { id: "fake_account", label: "Fake account" },
    ],
  },
  {
    id: "underage",
    label: "Underage account",
    description: "This account belongs to someone under 13",
    appliesTo: ["user"],
    subcategories: [{ id: "under_13", label: "They're under 13" }],
  },
  {
    id: "something_else",
    label: "Something else",
    description: "Tell us what's wrong",
    appliesTo: ["post", "comment", "message", "conversation", "user"],
    subcategories: [],
    requiresDetails: true,
  },
];

export const MAX_REPORT_DETAILS = 1000;

// Wording for the first screen of the sheet, per thing being reported.
export const REPORT_TARGET_LABELS = {
  post: "Report post",
  comment: "Report comment",
  message: "Report message",
  conversation: "Report chat",
  user: "Report account",
};

export const getCategoriesFor = (targetType) =>
  REPORT_CATEGORIES.filter((c) => c.appliesTo.includes(targetType));

export const getCategory = (categoryId) =>
  REPORT_CATEGORIES.find((c) => c.id === categoryId) || null;

// Human-readable version of a stored { category, subcategory } pair.
export const getReasonLabel = (categoryId, subcategoryId) => {
  const category = getCategory(categoryId);
  if (!category) return "Reported";
  const sub = category.subcategories.find((s) => s.id === subcategoryId);
  return sub ? `${category.label} — ${sub.label}` : category.label;
};

// Reasons that warrant pointing the reporter at support rather than just
// thanking them.
export const SUPPORT_CATEGORIES = new Set(["self_harm"]);
