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
