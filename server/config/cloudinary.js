import { v2 as cloudinary } from "cloudinary";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();  

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true, 
});

/*
 * The folder was hardcoded to "posts" while two callers were already passing
 * "chat_media" and "voice_notes" as a second argument, so every private chat
 * attachment and voice note was being filed alongside public post media. The
 * default keeps the callers that pass nothing exactly where they were.
 */
/**
 * The `public_id` and `resource_type` inside one of our own upload URLs.
 *
 * Needed to delete something we uploaded: `uploader.destroy` takes those two, and
 * the only thing that travels back from the client is the URL. Deriving it is safe
 * here because the caller has already verified the URL's signature, so it is a URL
 * this server produced — and this server only ever uploads (no transformations in
 * the path), which is what makes the shape predictable.
 *
 * Returns null for anything that isn't recognisably one of ours; callers treat that
 * as "nothing to delete" rather than as an error.
 */
export const parseCloudinaryUrl = (url) => {
  if (typeof url !== "string") return null;
  const marker = "/upload/";
  const at = url.indexOf(marker);
  if (at < 0) return null;

  const before = url.slice(0, at).split("/");
  const resourceType = before[before.length - 1];
  if (!["image", "video", "raw"].includes(resourceType)) return null;

  let path = url.slice(at + marker.length);
  // The version segment Cloudinary inserts, e.g. "v1699999999/".
  path = path.replace(/^v\d+\//, "");
  // Strip the extension, but only from the final segment — folder names may
  // contain dots.
  const lastSlash = path.lastIndexOf("/");
  const dir = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : "";
  const file = path.slice(lastSlash + 1).replace(/\.[^./]+$/, "");
  if (!file) return null;

  return { publicId: `${dir}${file}`, resourceType };
};

/**
 * Remove an uploaded asset. Best effort: a failure is logged and swallowed,
 * because the caller is already on an error path and a failed cleanup must not
 * replace the original error with a different one.
 */
export const deleteFromCloudinary = async (url) => {
  const parsed = parseCloudinaryUrl(url);
  if (!parsed) return false;
  try {
    await cloudinary.uploader.destroy(parsed.publicId, {
      resource_type: parsed.resourceType,
    });
    return true;
  } catch (error) {
    console.error("Cloudinary destroy failed:", parsed.publicId, error?.message);
    return false;
  }
};

export const uploadToCloudinary = (filePath, folder = "posts") => {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload(
      filePath,
      {
        resource_type: "auto",
        folder,
      },
      (error, result) => {
        fs.unlink(filePath, (unlinkErr) => {
          if (unlinkErr) console.error("Error removing temp file:", unlinkErr);
        });

        if (error) return reject(error);
        resolve(result);
      }
    );
  });
};
