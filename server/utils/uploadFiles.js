import { uploadToCloudinary } from "../config/cloudinary.js";

/**
 * Upload an array of multer file objects to Cloudinary.
 * Returns an array of secure URLs in the same order.
 *
 * @param {Express.Multer.File[]} files
 * @param {string} [folder]  - optional Cloudinary folder name
 * @returns {Promise<string[]>}
 */
export async function uploadFiles(files, folder) {
  const urls = [];
  for (const file of files) {
    const result = await uploadToCloudinary(file.path, folder);
    urls.push(result.secure_url);
  }
  return urls;
}

/**
 * The typed version, for post and comment attachments.
 *
 * The type comes from multer's mimetype rather than the resulting URL, because
 * Cloudinary reports both audio and video as `resource_type: "video"` and the
 * extension guess can't tell a .webm recording from a .webm clip. The mimetype
 * is what the browser actually sent, so it's the one thing that knows.
 *
 * @param {Express.Multer.File[]} files
 * @returns {Promise<Array<{url,type,duration?,width?,height?}>>}
 */
export async function uploadMedia(files) {
  const items = [];

  for (const file of files) {
    const result = await uploadToCloudinary(file.path);
    const mime = file.mimetype || "";

    let type = "image";
    if (mime.startsWith("audio/")) type = "audio";
    else if (mime.startsWith("video/")) type = "video";
    else if (mime === "image/gif") type = "gif";

    const item = { url: result.secure_url, type };
    if (Number.isFinite(result.duration)) item.duration = result.duration;
    // Cloudinary omits dimensions for audio, which is what we want.
    if (Number.isFinite(result.width)) item.width = result.width;
    if (Number.isFinite(result.height)) item.height = result.height;

    items.push(item);
  }

  return items;
}
