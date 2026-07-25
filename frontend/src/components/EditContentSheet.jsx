import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "react-hot-toast";
import ResponsiveSheet from "./ui/responsive-sheet";
import { Icons } from "./icons";
import { postAPI, commentAPI } from "../services/api";

const MAX_CONTENT_LENGTH = 500; // mirrors the server's maxlength

/**
 * EditContentSheet — edit the text of a post or comment.
 *
 * Text only: media is fixed at creation, matching how Instagram lets you change
 * a caption but never the photo. Deliberately not built on CreatePost, which is
 * 700 lines of drafts, media pickers and audience controls that an edit can't
 * use, and which resets its form whenever it opens.
 */
const EditContentSheet = ({
  isComment,
  targetId,
  initialContent,
  initialAiGenerated = false,
  onSaved,
  onClose,
}) => {
  const [content, setContent] = useState(initialContent || "");
  // The only place an AI disclosure can be removed after posting.
  const [isAiGenerated, setIsAiGenerated] = useState(!!initialAiGenerated);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef(null);

  // Focus with the caret at the end rather than selecting everything.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const trimmed = content.trim();
  const textUnchanged = trimmed === (initialContent || "").trim();
  const labelUnchanged = isAiGenerated === !!initialAiGenerated;
  const unchanged = textUnchanged && labelUnchanged;
  const tooLong = trimmed.length > MAX_CONTENT_LENGTH;
  const canSave = !saving && !!trimmed && !unchanged && !tooLong;

  // Vetoes closing (backdrop, Escape, drag, Cancel) when there's unsaved work.
  const confirmDiscard = () => unchanged || window.confirm("Discard your changes?");

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const body = { content: trimmed, isAiGenerated };
      const data = isComment
        ? await commentAPI.editComment(targetId, body)
        : await postAPI.editPost(targetId, body);

      const updated = isComment ? data?.comment : data?.post;
      if (updated) onSaved(updated);
      toast.success(isComment ? "Comment updated" : "Post updated");
      // Straight to onClose: going through the sheet's animated close would
      // trip the unsaved-changes veto on the way out.
      onClose();
    } catch (error) {
      toast.error(
        error.response?.data?.message ||
          error.response?.data?.error ||
          "Couldn't save changes"
      );
      setSaving(false);
    }
  };

  return (
    <ResponsiveSheet
      onClose={onClose}
      canClose={confirmDiscard}
      title={isComment ? "Edit comment" : "Edit post"}
    >
      {(close) => (
        <div className="p-4">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="What's on your mind?"
            className="w-full h-40 bg-neutral-900 rounded-2xl border border-neutral-800 text-white text-[15px] placeholder:text-neutral-500 resize-none outline-none p-4 leading-relaxed"
          />

          <p className="mt-2 text-[12px] text-neutral-500 leading-relaxed">
            Only the text can be changed. Anyone can see that this was edited,
            and view previous versions.
          </p>

          {/* Toggling the label alone doesn't mark the post as edited. */}
          <div className="mt-3 flex items-start justify-between gap-4 rounded-xl border border-neutral-800 p-3">
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-[14px] font-medium text-white">
                <Icons.ai className="w-4 h-4" />
                AI label
              </span>
              <span className="block text-[12px] text-neutral-500 mt-0.5">
                Tell people AI was used to make this.
              </span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={isAiGenerated}
              aria-label="AI label"
              onClick={() => setIsAiGenerated((v) => !v)}
              className={`relative w-11 h-6 rounded-full transition-colors shrink-0 cursor-pointer ${
                isAiGenerated ? "bg-green-500" : "bg-neutral-700"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                  isAiGenerated ? "translate-x-5" : ""
                }`}
              />
            </button>
          </div>

          <div className="mt-3 flex items-center justify-between gap-3">
            <span
              className={`text-[12px] shrink-0 ${
                tooLong ? "text-red-500" : "text-neutral-500"
              }`}
            >
              {trimmed.length}/{MAX_CONTENT_LENGTH}
            </span>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={close}
                disabled={saving}
                className="px-4 py-2 rounded-xl border border-neutral-700 text-white text-sm font-semibold hover:bg-neutral-800 transition-colors disabled:opacity-40 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!canSave}
                onClick={handleSave}
                className="px-5 py-2 rounded-xl bg-white text-black text-sm font-semibold hover:bg-neutral-200 transition-colors disabled:opacity-40 disabled:cursor-default flex items-center gap-2 cursor-pointer"
              >
                {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </ResponsiveSheet>
  );
};

export default EditContentSheet;
