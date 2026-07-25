import { useState, useRef } from "react";
import { X, Paperclip, Loader2 } from "lucide-react";
import { toast } from "react-hot-toast";
import ResponsiveSheet from "./ui/responsive-sheet";
import { reportAPI } from "../services/api";

const ReportProblemModal = ({ isOpen, onClose }) => {
  const [message, setMessage] = useState("");
  const [screenshot, setScreenshot] = useState(null);
  const [screenshotName, setScreenshotName] = useState("");
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef(null);

  if (!isOpen) return null;

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setScreenshot(file);
    setScreenshotName(file.name);
  };

  const handleRemoveScreenshot = () => {
    setScreenshot(null);
    setScreenshotName("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleClose = () => {
    setMessage("");
    setScreenshot(null);
    setScreenshotName("");
    onClose();
  };

  const handleSubmit = async () => {
    if (!message.trim()) {
      return toast.error("Please describe the problem");
    }

    setLoading(true);
    try {
      const formData = new FormData();
      formData.append("message", message.trim());
      formData.append("url", window.location.href);
      formData.append("userAgent", navigator.userAgent);
      if (screenshot) formData.append("screenshot", screenshot);

      await reportAPI.platform(formData);

      toast.success("Report submitted. Thank you!");
      handleClose();
    } catch (error) {
      toast.error(error.response?.data?.error || "Failed to submit report");
    } finally {
      setLoading(false);
    }
  };

  return (
    <ResponsiveSheet onClose={handleClose} title="Report a problem">
      <div className="p-4">
        <div className="bg-neutral-900 rounded-2xl border border-neutral-800 overflow-hidden">
          {/* Textarea */}
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Please include as many details as possible..."
            className="w-full bg-transparent text-white text-base placeholder:text-neutral-500 resize-none h-40 outline-none p-4 leading-relaxed"
            maxLength={2000}
          />

          {/* Screenshot pill */}
          {screenshotName && (
            <div className="px-4 pb-2 flex items-center gap-2">
              <span className="text-xs text-neutral-400 bg-neutral-800 rounded-full px-3 py-1 max-w-[260px] truncate">
                {screenshotName}
              </span>
              <button
                onClick={handleRemoveScreenshot}
                className="text-neutral-500 hover:text-white transition-colors shrink-0"
                aria-label="Remove screenshot"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}

          {/* Action row */}
          <div className="flex items-center justify-between px-3 py-3 border-t border-neutral-800">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="p-1.5 text-neutral-400 hover:text-white transition-colors rounded-md hover:bg-neutral-800 cursor-pointer"
              aria-label="Attach screenshot"
            >
              <Paperclip className="w-[18px] h-[18px]" />
            </button>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileChange}
            />

            <button
              type="button"
              onClick={handleSubmit}
              disabled={loading}
              className="px-5 py-1.5 border border-neutral-600 rounded-xl text-white text-sm font-semibold hover:bg-neutral-800 transition-colors disabled:opacity-50 flex items-center cursor-pointer gap-2"
            >
              {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Submit
            </button>
          </div>
        </div>
      </div>
    </ResponsiveSheet>
  );
};

export default ReportProblemModal;
