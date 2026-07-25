import React from "react";
import { Icons } from "../components/icons";

const MediaPreviewModal = ({ 
  mediaPreview, 
  newMessage, 
  onMessageChange, 
  onConfirm, 
  onCancel, 
  isSending 
}) => {
  if (!mediaPreview) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-90 flex items-center justify-center z-50 p-4">
      <div className="bg-neutral-900 rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-hidden">
        <div className="p-4 border-b border-neutral-800 flex justify-between items-center">
          <h3 className="font-medium">Send Media</h3>
          <button
            onClick={onCancel}
            className="text-neutral-400 hover:text-white"
          >
            <Icons.close className="w-6 h-6" />
          </button>
        </div>
        
        <div className="p-4">
          {mediaPreview.type === "image" ? (
            <img
              src={mediaPreview.url}
              alt="Preview"
              className="max-w-[min(100%,240px)] max-h-52 w-auto h-auto object-contain rounded-lg mx-auto block"
            />
          ) : (
            <video
              src={mediaPreview.url}
              controls
              className="max-w-[min(100%,240px)] max-h-52 w-auto h-auto object-contain rounded-lg mx-auto block"
            />
          )}
          
          <textarea
            value={newMessage}
            onChange={(e) => onMessageChange(e.target.value)}
            placeholder="Add a caption..."
            className="w-full mt-4 bg-neutral-800 text-white placeholder-neutral-400 rounded-lg p-3 resize-none focus:outline-none"
            rows={3}
          />
          
          <div className="flex gap-3 mt-4">
            <button
              onClick={onCancel}
              className="flex-1 bg-neutral-800 text-white py-2.5 rounded-lg font-medium hover:bg-neutral-700 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={isSending}
              className="flex-1 bg-violet-600 text-white py-2.5 rounded-lg font-medium hover:bg-violet-700 transition-colors disabled:opacity-50"
            >
              {isSending ? "Sending..." : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MediaPreviewModal;