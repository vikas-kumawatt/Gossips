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

const allowedTypes = [
  "image/",
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/mkv",
  "audio/",
];

const fileFilter = (req, file, cb) => {
  if (allowedTypes.some((type) => file.mimetype.startsWith(type))) {
    cb(null, true);
  } else {
    cb(new Error("Unsupported file format"), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
});


export default upload;
