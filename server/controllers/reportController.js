import PlatformReport from "../models/PlatformReport.js";
import { uploadToCloudinary } from "../config/cloudinary.js";
import { REPORT_TARGET_TYPES } from "../utils/reportCategories.js";
import {
  canReportAgain,
  findLatestReport,
  reportContent,
  resolveReportTarget,
  validateReportIdentifier,
} from "../services/moderation.js";

export const createPlatformReport = async (req, res) => {
  try {
    const { message, url, userAgent } = req.body;

    if (!message?.trim()) {
      return res.status(400).json({ error: "Please describe the problem" });
    }
    if (message.trim().length > 2000) {
      return res.status(400).json({ error: "Message must be under 2000 characters" });
    }

    let screenshotUrl = null;
    if (req.file) {
      const result = await uploadToCloudinary(req.file.path);
      screenshotUrl = result.secure_url;
    }

    await PlatformReport.create({
      user: req.user?._id || null,
      message: message.trim(),
      screenshot: screenshotUrl,
      metadata: {
        url: url || null,
        userAgent: userAgent || null,
      },
    });

    return res.status(201).json({ message: "Report submitted. Thank you!" });
  } catch (error) {
    console.error("createPlatformReport error:", error);
    return res.status(500).json({ error: "Failed to submit report" });
  }
};

/**
 * GET /reports/status — has the caller already reported this thing, where did it get to, and
 * may they report it again? Drives the "Awaiting review" / "Decision made" screen.
 *
 * The target resolution and the repeat rule live in `services/moderation.js` now, because the
 * bot executor needs them too. They are the same functions this file used to define — moved,
 * not reimplemented, which is the whole point: a second resolver would eventually disagree
 * about which messages a person is allowed to report.
 */
export const getReportStatus = async (req, res) => {
  try {
    const { targetType, targetId, username } = req.query;

    if (!REPORT_TARGET_TYPES.includes(targetType)) {
      return res.status(400).json({ error: "Unknown report target" });
    }
    const idError = validateReportIdentifier(targetType, targetId, username);
    if (idError) return res.status(400).json({ error: idError });

    const target = await resolveReportTarget(targetType, { targetId, username }, req.user._id);
    if (target.error) return res.status(404).json({ error: target.error });

    const report = await findLatestReport(req.user._id, targetType, target);
    return res.status(200).json({
      report: report || null,
      canReportAgain: canReportAgain(report, target),
    });
  } catch (error) {
    console.error("getReportStatus error:", error);
    return res.status(500).json({ error: "Failed to load report status" });
  }
};

export const createReport = async (req, res) => {
  try {
    const { targetType, targetId, username, category, subcategory, details, url } = req.body;

    const result = await reportContent({
      actorId: req.user._id,
      targetType,
      targetId,
      username,
      category,
      subcategory,
      details,
      url,
      userAgent: req.get("user-agent") || null,
      /*
       * A person is filing this one. The flag exists so a moderator can tell an automated
       * report from a human judgement, and it is read from the account rather than trusted
       * from the body — a client must not be able to launder a bot's report as a person's,
       * or stamp a person's as a bot's to have it discounted.
       */
      reporterIsBot: Boolean(req.user.isBot),
    });

    if (!result.ok) return res.status(result.status).json({ error: result.error });
    // Unchanged: an existing open report is answered 200 with a marker, not an error, so the
    // client can show "you already reported this" rather than a failure.
    if (result.alreadyReported) {
      return res.status(200).json({ alreadyReported: true, report: result.report });
    }

    return res.status(201).json({ message: "Thanks for reporting." });
  } catch (error) {
    console.error("createReport error:", error);
    return res.status(500).json({ error: "Failed to submit report" });
  }
};
