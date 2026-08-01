import { Router } from "express";
import { getHashtagContent } from "../controllers/hashtagController.js";
import { protect } from "../middleware/authMiddleware.js";

const router = Router();

/*
 * Only the page. Anything else here would need a single-segment name, and every
 * one of those is a legal hashtag — `/tags/search` would have shadowed the page
 * for #search. Hashtag search and trending live under /search instead, which is
 * where searching for things belongs.
 */
router.get("/:tag", protect, getHashtagContent);

export default router;
