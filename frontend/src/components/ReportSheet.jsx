import { useEffect, useState } from "react";
import { ChevronRight, Loader2, Check, Clock } from "lucide-react";
import { toast } from "react-hot-toast";
import ResponsiveSheet from "./ui/responsive-sheet";
import { Icons } from "./icons";
import { useBlock } from "../contexts/BlockContext";
import { useMute } from "../contexts/MuteContext";
import { reportAPI } from "../services/api";
import {
  MAX_REPORT_DETAILS,
  REPORT_TARGET_LABELS,
  SUPPORT_CATEGORIES,
  getCategoriesFor,
  getCategory,
  getReasonLabel,
} from "../lib/reportCategories";

// Rows are full-width inside a px-2 container — margins on a w-full element
// overflow the sheet and add a horizontal scrollbar.
const rowClass =
  "w-full flex justify-between items-center gap-3 text-left p-3 my-0.5 tracking-normal select-none font-semibold text-[15px] hover:bg-neutral-800 rounded-xl active:bg-neutral-950 outline-none cursor-pointer disabled:opacity-50 disabled:cursor-default";

const SUBJECT_NOUN = {
  post: "this post",
  comment: "this comment",
  message: "this message",
  conversation: "this chat",
  user: "this account",
  hashtag: "this hashtag",
};

const STATUS_COPY = {
  pending: {
    title: "Awaiting review",
    body: "We've received your report. Our team will review it against our Community Guidelines.",
  },
  reviewing: {
    title: "Under review",
    body: "We're taking a look at this now. We'll let you know once a decision has been made.",
  },
  actioned: {
    title: "Decision made",
    body: "We found that this goes against our Community Guidelines and have taken action.",
  },
  dismissed: {
    title: "Decision made",
    body: "We reviewed this and didn't find that it goes against our Community Guidelines.",
  },
};

const SUPPORT_MESSAGE =
  "If you or someone you know needs support right now, please reach out to a local helpline or someone you trust.";

const formatReportedOn = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString();
};

/**
 * ReportSheet — category → subcategory (or free text) → confirmation.
 *
 * Reopening on something already reported shows its review status instead of
 * letting the same person file it twice.
 *
 * Rendered app-wide by ReportProvider; open it with `openReport()` rather than
 * mounting this directly.
 */
const ReportSheet = ({ target, onClose }) => {
  const { targetType, targetId, username, hashtag, name, onNotInterested } = target;

  /*
   * A hashtag belongs to nobody, so there's no account to mute or block after
   * reporting it — and the tag must never be treated as a handle. The API's
   * non-id target slot is called `username`, so the tag travels in it, but
   * only from here down.
   */
  const isHashtag = targetType === "hashtag";
  const identifier = isHashtag ? hashtag : username;
  const accountHandle = isHashtag ? null : username;

  const { requestBlock, isBlocked } = useBlock();
  const { mute, isMuted } = useMute();

  // loading | status | category | subcategory | details | done
  const [step, setStep] = useState("loading");
  const [existing, setExisting] = useState(null);
  // A resolved report doesn't lock the target — the content may have changed
  // since the decision was made.
  const [canReportAgain, setCanReportAgain] = useState(false);
  const [categoryId, setCategoryId] = useState(null);
  const [details, setDetails] = useState("");
  // The subcategory currently being submitted, so only its row spins.
  const [submitting, setSubmitting] = useState(null);
  const [dismissed, setDismissed] = useState(false);

  const category = getCategory(categoryId);

  // Has this person already reported this? A failed check shouldn't stop them
  // reporting — fall through to the category list.
  useEffect(() => {
    let active = true;
    reportAPI
      .status({
        targetType,
        targetId: targetId || undefined,
        username: identifier || undefined,
      })
      .then((data) => {
        if (!active) return;
        if (data?.report) {
          setExisting(data.report);
          setCanReportAgain(!!data.canReportAgain);
          setStep("status");
        } else {
          setStep("category");
        }
      })
      .catch(() => {
        if (active) setStep("category");
      });
    return () => {
      active = false;
    };
  }, [targetType, targetId, identifier]);

  const submit = async (subcategory, detailsText) => {
    setSubmitting(subcategory || "details");
    try {
      const data = await reportAPI.create({
        targetType,
        targetId: targetId || undefined,
        username: identifier || undefined,
        category: categoryId,
        subcategory: subcategory || undefined,
        details: detailsText || undefined,
        url: window.location.href,
      });
      // Lost a race with another tab — that report is open, so show its status.
      if (data?.alreadyReported && data.report) {
        setExisting(data.report);
        setCanReportAgain(false);
        setStep("status");
      } else {
        setStep("done");
      }
    } catch (error) {
      toast.error(error.response?.data?.error || "Couldn't submit report");
    } finally {
      setSubmitting(null);
    }
  };

  const handleCategory = (picked) => {
    setCategoryId(picked.id);
    setStep(picked.subcategories.length ? "subcategory" : "details");
  };

  const goBackToCategories = () => {
    setCategoryId(null);
    setDetails("");
    setStep("category");
  };

  const handleMute = async () => {
    try {
      await mute(username);
      toast.success(`Muted @${username}`);
    } catch {
      toast.error("Couldn't mute");
    }
  };

  const handleNotInterested = () => {
    onNotInterested?.();
    setDismissed(true);
  };

  // Block / Mute / Not interested, offered after reporting and alongside an
  // existing report's status.
  const followUps = (close) => (
    <div className="border-t border-neutral-800 pt-2">
      <p className="px-5 pt-1 pb-1 text-neutral-400 text-[13px] font-semibold">
        You can also
      </p>

      <div className="px-2">
        {onNotInterested && (
          <button
            type="button"
            disabled={dismissed}
            onClick={handleNotInterested}
            className={rowClass}
          >
            <span className="min-w-0">
              {dismissed
                ? "You'll see fewer posts like this"
                : "See fewer posts like this"}
            </span>
            <Icons.notinterested />
          </button>
        )}

        {accountHandle && !isMuted(accountHandle) && (
          <button type="button" onClick={handleMute} className={rowClass}>
            <span className="truncate min-w-0">Mute @{accountHandle}</span>
            <Icons.mute />
          </button>
        )}

        {accountHandle && !isBlocked(accountHandle) && (
          <button
            type="button"
            // Block has its own confirmation dialog. Drop this sheet immediately
            // rather than animating out over the top of it.
            onClick={() => {
              onClose();
              requestBlock({ username: accountHandle, name });
            }}
            className={`${rowClass} text-red-500`}
          >
            <span className="truncate min-w-0">Block @{accountHandle}</span>
            <Icons.block />
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={close}
        className="w-full py-3 mt-1 font-semibold text-[15px] border-t border-neutral-800 hover:bg-neutral-800 cursor-pointer"
      >
        Done
      </button>
    </div>
  );

  const title =
    step === "status"
      ? "Report status"
      : step === "category" || step === "loading"
      ? REPORT_TARGET_LABELS[targetType] || "Report"
      : step === "done"
      ? "Report"
      : category?.label || "Report";

  // Only the reason steps go back; loading, status and confirmation are terminal.
  const back =
    step === "subcategory" || step === "details" ? goBackToCategories : null;

  // Fall back to the pending copy so an unrecognised status can't blank the sheet.
  const statusCopy = existing ? STATUS_COPY[existing.status] || STATUS_COPY.pending : null;
  const reportedOn = formatReportedOn(existing?.createdAt);
  const decided = existing?.status === "actioned" || existing?.status === "dismissed";

  return (
    <ResponsiveSheet onClose={onClose} title={title} onBack={back}>
      {(close) => (
        <>
          {step === "loading" && (
            <div className="flex items-center justify-center py-14">
              <Loader2 className="w-5 h-5 animate-spin text-neutral-500" />
            </div>
          )}

          {step === "status" && statusCopy && (
            <div className="pb-2">
              <div className="px-6 pt-6 pb-5 text-center">
                <div className="mx-auto mb-3 w-11 h-11 rounded-full bg-neutral-800 flex items-center justify-center">
                  {decided ? (
                    <Check className="w-5 h-5" />
                  ) : (
                    <Clock className="w-5 h-5" />
                  )}
                </div>
                <h3 className="font-bold text-[17px]">{statusCopy.title}</h3>
                <p className="mt-2 text-neutral-400 text-[13px] leading-relaxed">
                  You've already reported {SUBJECT_NOUN[targetType]}.{" "}
                  {statusCopy.body}
                  {canReportAgain &&
                    " If it's changed since then, you can report it again."}
                </p>
                <div className="mt-4 rounded-2xl bg-neutral-900 border border-neutral-800 px-4 py-3 text-left">
                  <p className="text-[11px] uppercase tracking-wide text-neutral-500 font-semibold">
                    Your report
                  </p>
                  <p className="mt-1 text-[14px] break-words">
                    {getReasonLabel(existing.category, existing.subcategory)}
                  </p>
                  {reportedOn && (
                    <p className="mt-0.5 text-[12px] text-neutral-500">
                      Reported on {reportedOn}
                    </p>
                  )}
                </div>
                {SUPPORT_CATEGORIES.has(existing.category) && (
                  <p className="mt-4 text-neutral-400 text-[13px] leading-relaxed">
                    {SUPPORT_MESSAGE}
                  </p>
                )}
                {canReportAgain && (
                  <button
                    type="button"
                    onClick={goBackToCategories}
                    className="mt-4 w-full py-2.5 rounded-xl bg-white text-black text-sm font-semibold hover:bg-neutral-200 transition-colors cursor-pointer"
                  >
                    Report again
                  </button>
                )}
              </div>

              {followUps(close)}
            </div>
          )}

          {step === "category" && (
            <div className="py-2 px-2">
              <p className="px-3 pt-2 pb-3 text-neutral-400 text-[13px] leading-relaxed">
                Why are you reporting {SUBJECT_NOUN[targetType]}? Your report is
                anonymous — we won't tell them who reported them.
              </p>
              {getCategoriesFor(targetType).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => handleCategory(c)}
                  className={rowClass}
                >
                  <span className="flex flex-col gap-0.5 min-w-0">
                    <span>{c.label}</span>
                    <span className="text-[13px] font-normal text-neutral-400">
                      {c.description}
                    </span>
                  </span>
                  <ChevronRight className="w-4 h-4 shrink-0 text-neutral-400" />
                </button>
              ))}
            </div>
          )}

          {step === "subcategory" && category && (
            <div className="py-2 px-2">
              <p className="px-3 pt-2 pb-3 text-neutral-400 text-[13px]">
                Pick the closest match so we route it to the right reviewer.
              </p>
              {category.subcategories.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  disabled={!!submitting}
                  onClick={() => submit(s.id, null)}
                  className={rowClass}
                >
                  <span className="min-w-0">{s.label}</span>
                  {submitting === s.id ? (
                    <Loader2 className="w-4 h-4 shrink-0 animate-spin text-neutral-400" />
                  ) : (
                    <ChevronRight className="w-4 h-4 shrink-0 text-neutral-400" />
                  )}
                </button>
              ))}
            </div>
          )}

          {step === "details" && (
            <div className="p-4">
              <textarea
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                placeholder="Tell us what's wrong. Include as much detail as you can."
                maxLength={MAX_REPORT_DETAILS}
                className="w-full h-36 bg-neutral-900 rounded-2xl border border-neutral-800 text-white text-[15px] placeholder:text-neutral-500 resize-none outline-none p-4 leading-relaxed"
              />
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="text-[12px] text-neutral-500 shrink-0">
                  {details.length}/{MAX_REPORT_DETAILS}
                </span>
                <button
                  type="button"
                  disabled={!!submitting || !details.trim()}
                  onClick={() => submit(null, details.trim())}
                  className="px-5 py-2 rounded-xl bg-white text-black text-sm font-semibold hover:bg-neutral-200 transition-colors disabled:opacity-40 flex items-center gap-2 cursor-pointer shrink-0"
                >
                  {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Submit report
                </button>
              </div>
            </div>
          )}

          {step === "done" && (
            <div className="pb-2">
              <div className="px-6 pt-6 pb-5 text-center">
                <div className="mx-auto mb-3 w-11 h-11 rounded-full bg-neutral-800 flex items-center justify-center">
                  <Check className="w-5 h-5" />
                </div>
                <h3 className="font-bold text-[17px]">Thanks for letting us know</h3>
                <p className="mt-2 text-neutral-400 text-[13px] leading-relaxed">
                  We'll review this against our Community Guidelines. They won't
                  know you reported them. You can check back here for the
                  outcome.
                </p>
                {SUPPORT_CATEGORIES.has(categoryId) && (
                  <p className="mt-3 text-neutral-400 text-[13px] leading-relaxed">
                    {SUPPORT_MESSAGE}
                  </p>
                )}
              </div>

              {followUps(close)}
            </div>
          )}
        </>
      )}
    </ResponsiveSheet>
  );
};

export default ReportSheet;
