import multer, { diskStorage } from "multer";
import { extname } from "path";
import { existsSync, mkdirSync } from "fs"; 

const uploadPath = "uploads/";
if (!existsSync(uploadPath)) {
  mkdirSync(uploadPath);
}

const storage = diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + extname(file.originalname));
  },
});

/*
 * Two filters, because two kinds of route — though both now allow the same types.
 *
 * Posts, comments, avatars and report attachments are media: an image, a video or an
 * audio clip. Chat used to additionally accept documents, and this separate instance is
 * what let it. Documents have since been removed from the product, so the two lists agree
 * again; the instances stay separate because they differ in more than the filter, and
 * because widening the *shared* one is the mistake this comment originally existed to
 * prevent — `/posts/create`, `/reply/comment` and `/user/profile-setup` don't re-check the
 * mimetype, and `uploadFiles.uploadMedia` classifies anything that isn't audio, video or a
 * gif as `type: "image"`.
 */
const MEDIA_TYPES = [
  "image/",
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/mkv",
  "video/quicktime",
  "video/x-msvideo",
  "audio/",
];

/**
 * The types chat accepts, exported so the controller's own allow-list can be the same
 * list rather than a second copy that drifts from this one.
 *
 * Documents are gone. This was `[...MEDIA_TYPES, ...DOCUMENT_TYPES]` — PDFs, Word files,
 * spreadsheets — and the client has no way to send one any more, so leaving the endpoint
 * willing to store them would be an upload path with no feature behind it. `audio/` stays:
 * that is how voice notes arrive.
 */
export const CHAT_UPLOAD_TYPES = [...MEDIA_TYPES];

/*
 * The size ceiling lives here and only here. The chat controller carried its
 * own 100MB check, which was dead code — multer had already refused anything
 * over 50MB before the handler ran — and two numbers claiming to be the same
 * limit is how they drift. server.js imports this one so the rejection it
 * sends back names the number actually being enforced.
 */
export const MAX_FILE_SIZE = 50 * 1024 * 1024;

/*
 * A fileFilter rejection reaches Express as an ordinary Error, indistinguish-
 * able from a genuine fault, so the JSON error handler would have to answer it
 * with a 500. The tag is what lets it answer 400 instead.
 */
export const UNSUPPORTED_FILE_TYPE = "UNSUPPORTED_FILE_TYPE";

const filterFor = (types) => (req, file, cb) => {
  if (types.some((type) => file.mimetype.startsWith(type))) {
    cb(null, true);
  } else {
    const error = new Error("Unsupported file format");
    error.code = UNSUPPORTED_FILE_TYPE;
    cb(error, false);
  }
};

const upload = multer({
  storage,
  fileFilter: filterFor(MEDIA_TYPES),
  limits: { fileSize: MAX_FILE_SIZE },
});

/** Chat attachments: the media types plus documents. */
export const chatUpload = multer({
  storage,
  fileFilter: filterFor(CHAT_UPLOAD_TYPES),
  limits: { fileSize: MAX_FILE_SIZE },
});

export default upload;
