import React, { useState, useRef, useEffect } from "react";
import { X, Check, RotateCw, ZoomIn, ZoomOut } from "lucide-react";
import { cropAndResizeImage } from "../lib/imageCrop";

const AvatarCropModal = ({ isOpen, imageSource, onClose, onCropComplete }) => {
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [loading, setLoading] = useState(false);
  const imgRef = useRef(null);

  useEffect(() => {
    if (isOpen) {
      setZoom(1);
      setRotation(0);
    }
  }, [isOpen, imageSource]);

  if (!isOpen || !imageSource) return null;

  const handleApplyCrop = async () => {
    try {
      setLoading(true);
      const result = await cropAndResizeImage(imageSource, {
        targetSize: 512,
        quality: 0.9,
      });
      onCropComplete(result);
      onClose();
    } catch {
      onClose();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <div className="relative w-full max-w-sm rounded-2xl border border-neutral-800 bg-[#141414] p-5 shadow-2xl">
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded-full p-2 text-neutral-400 hover:bg-neutral-800 hover:text-white"
        >
          <X className="h-5 w-5" />
        </button>

        <h3 className="text-base font-bold text-white mb-1">Adjust Profile Photo</h3>
        <p className="text-xs text-neutral-400 mb-4">Preview and optimize before uploading</p>

        <div className="relative w-64 h-64 mx-auto rounded-full overflow-hidden border-2 border-blue-500/50 bg-black flex items-center justify-center shadow-inner">
          <img
            ref={imgRef}
            src={imageSource}
            alt="Crop Preview"
            style={{
              transform: `scale(${zoom}) rotate(${rotation}deg)`,
              transition: "transform 0.15s ease-out",
            }}
            className="max-w-none max-h-none object-cover pointer-events-none"
          />
        </div>

        <div className="flex items-center justify-center gap-4 mt-5">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(0.8, z - 0.1))}
            className="p-2 rounded-xl bg-neutral-800 text-neutral-300 hover:bg-neutral-700 hover:text-white transition-colors"
            title="Zoom out"
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <input
            type="range"
            min="0.8"
            max="2.5"
            step="0.05"
            value={zoom}
            onChange={(e) => setZoom(parseFloat(e.target.value))}
            className="w-32 accent-blue-500 cursor-pointer"
          />
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(2.5, z + 0.1))}
            className="p-2 rounded-xl bg-neutral-800 text-neutral-300 hover:bg-neutral-700 hover:text-white transition-colors"
            title="Zoom in"
          >
            <ZoomIn className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setRotation((r) => (r + 90) % 360)}
            className="p-2 rounded-xl bg-neutral-800 text-neutral-300 hover:bg-neutral-700 hover:text-white transition-colors"
            title="Rotate"
          >
            <RotateCw className="h-4 w-4" />
          </button>
        </div>

        <div className="flex gap-3 mt-6">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-xl border border-neutral-800 py-2.5 text-sm font-semibold text-neutral-300 hover:bg-neutral-800 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleApplyCrop}
            disabled={loading}
            className="flex-1 rounded-xl bg-white text-black hover:bg-neutral-200 py-2.5 text-sm font-semibold transition-colors disabled:opacity-50"
          >
            {loading ? "Processing..." : "Save Photo"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AvatarCropModal;
