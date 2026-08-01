import { Router } from "express";
import { getHashtagContent, getTrendingHashtags } from "../controllers/hashtagController.js";
import { protect } from "../middleware/authMiddleware.js";

const router = Router();

/*
 * "trending" before "/:tag" — it's a legal tag shape, so ordering is the only
 * thing keeping it from being read as somebody's hashtag page.
 */
router.get("/trending", protect, getTrendingHashtags);
router.get("/:tag", protect, getHashtagContent);

export default router;
