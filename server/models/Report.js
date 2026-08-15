import { Schema, model } from "mongoose";
import { REPORT_TARGET_TYPES, MAX_REPORT_DETAILS } from "../utils/reportCategories.js";

/**
 * Report — a user reporting a piece of content or an account.
 *
 * Distinct from PlatformReport, which is a bug/feedback channel about the
 * product itself. Content reports are never surfaced to the reported party.
 */
const reportSchema = new Schema(
  {
    reporter: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    targetType: {
      type: String,
      enum: REPORT_TARGET_TYPES,
      required: true,
    },
    // The reported document. Null for `conversation` reports, which are keyed
    // by the Message.conversation string rather than a document of their own.
    targetId: {
      type: Schema.Types.ObjectId,
      default: null,
    },
    targetKey: {
      type: String,
      default: null,
    },
    // Denormalised owner of the reported thing (post author, message sender,
    // the reported account itself). Lets moderation group reports by offender
    // without re-resolving every target. Null for group reports.
    targetOwner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    category: {
      type: String,
      required: true,
    },
    subcategory: {
      type: String,
      default: null,
    },
    details: {
      type: String,
      trim: true,
      maxlength: MAX_REPORT_DETAILS,
      default: null,
    },
    status: {
      type: String,
      enum: ["pending", "reviewing", "actioned", "dismissed"],
      default: "pending",
      index: true,
    },
    /*
     * Filed by an AI account acting on its own, rather than by a person.
     *
     * Recorded rather than enforced: bots may report, under their own tight daily cap (see
     * `bots/rateLimits.js`), and a moderator needs to know which kind of judgement produced
     * a queue item. A model deciding a post is harassment and a person deciding it are not
     * the same evidence, and a queue that flattens them is a queue that will eventually
     * action the wrong one.
     *
     * Denormalised from `reporter.isBot` on purpose: the flag has to stay true for the
     * historical record even if the account is later deleted, and a moderation queue should
     * not need a join to answer a question this load-bearing.
     */
    reporterIsBot: {
      type: Boolean,
      default: false,
      index: true,
    },
    metadata: {
      url: { type: String, default: null },
      userAgent: { type: String, default: null },
    },
  },
  { timestamps: true }
);

// Look up a reporter's history on one target: the open report blocks a repeat,
// the latest one drives the status screen.
//
// Deliberately NOT unique. The rule is "one *open* report per target", and once
// a report is resolved a new one is allowed with an identical key — so a plain
// unique index would reject the re-report, and including `status` in the key
// would instead reject the moderator's resolve. Enforced in the controller;
// worst case a double-submit leaves a duplicate row in the queue.
reportSchema.index({ reporter: 1, targetType: 1, targetId: 1, targetKey: 1 });

// Moderation queues: everything reported about one target, and the backlog.
reportSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
reportSchema.index({ status: 1, createdAt: -1 });

export default model("Report", reportSchema);
