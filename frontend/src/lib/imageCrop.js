/**
 * Client-side image cropping and resizing utility.
 * Downscales and crops images to a 1:1 square canvas before upload.
 */

export const cropAndResizeImage = (
  imageSource,
  {
    targetSize = 512,
    cropX = 0,
    cropY = 0,
    cropWidth,
    cropHeight,
    quality = 0.88,
    mimeType = "image/jpeg",
  } = {}
) => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";

    img.onload = () => {
      const srcWidth = img.naturalWidth || img.width;
      const srcHeight = img.naturalHeight || img.height;

      // Default to center square crop if not specified
      const side = Math.min(srcWidth, srcHeight);
      const sx = cropWidth ? cropX : (srcWidth - side) / 2;
      const sy = cropHeight ? cropY : (srcHeight - side) / 2;
      const sw = cropWidth || side;
      const sh = cropHeight || side;

      const canvas = document.createElement("canvas");
      canvas.width = targetSize;
      canvas.height = targetSize;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return reject(new Error("Failed to get canvas 2D context"));
      }

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";

      // Draw cropped square
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, targetSize, targetSize);

      canvas.toBlob(
        (blob) => {
          if (!blob) {
            return reject(new Error("Canvas blob export failed"));
          }
          const file = new File([blob], "avatar.jpg", { type: mimeType });
          const previewUrl = URL.createObjectURL(blob);
          resolve({ file, blob, previewUrl });
        },
        mimeType,
        quality
      );
    };

    img.onerror = () => reject(new Error("Failed to load image for cropping"));

    if (typeof imageSource === "string") {
      img.src = imageSource;
    } else if (imageSource instanceof File || imageSource instanceof Blob) {
      const reader = new FileReader();
      reader.onload = (e) => {
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.readAsDataURL(imageSource);
    } else {
      reject(new Error("Invalid image source"));
    }
  });
};
