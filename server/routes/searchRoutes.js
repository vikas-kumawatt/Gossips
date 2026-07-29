import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { protect } from "../middleware/authMiddleware.js";
import {
  searchContent,
  getSearchHistory,
  addSearchHistory,
  deleteSearchHistoryEntry,
  clearSearchHistory,
} from "../controllers/searchController.js";

const router = Router();

/*
 * Content search is the most expensive read in the app: an unanchored text
 * query is a scan of two collections, joined against accounts for visibility.
 * The client debounces and pages, so normal use is a handful of requests a
 * minute — this is the backstop against someone paging the whole corpus out.
 */
const searchLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { success: false, error: { message: "Slow down a moment" } },
  standardHeaders: true,
  legacyHeaders: false,
});

// History writes happen on submit and on opening a result, not per keystroke.
const historyWriteLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { success: false, error: { message: "Slow down a moment" } },
  standardHeaders: true,
  legacyHeaders: false,
});

// Posts and replies. People search stays on /user/search — it returns accounts,
// not content, and already has its own suggestion ranking.
router.get("/content", protect, searchLimit, searchContent);

router.get("/history", protect, getSearchHistory);
router.post("/history", protect, historyWriteLimit, addSearchHistory);
router.delete("/history/:entryId", protect, historyWriteLimit, deleteSearchHistoryEntry);
router.delete("/history", protect, historyWriteLimit, clearSearchHistory);

export default router;
