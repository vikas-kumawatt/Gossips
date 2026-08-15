import mongoose from "mongoose";
import Post from "../models/Post.js";
import Saved from "../models/Saved.js";
import NotInterested from "../models/NotInterested.js";
import UserSettings from "../models/UserSettings.js";
import UserRelation from "../models/UserRelation.js";
import { parseHashtags } from "../utils/richText.js";
import { atPreferenceCap, sameChatId, withoutChatId } from "../utils/chatPreferences.js";

/**
 * Shaping your own feed: saving, dismissing, favouriting.
 *
 * ── What these three have in common ─────────────────────────────────────────
 *
 * Nobody else can tell. Saving a post sends no notification and bumps no counter; the author
 * of a post you dismiss is never told; a favourited author doesn't know. They are writes to
 * rows that only their owner reads, which is what makes them the safe end of the action space
 * a bot can reach — the worst outcome of a bot getting one wrong is a slightly worse feed for
 * its owner's own account.
 *
 * Same contract as engagement.js — `{ ok: true, ...outcome }` or `{ ok: false, status, error }`,
 * never a thrown refusal, never a response object. Read the header there first; the reasoning
 * is identical and is not repeated.
 *
 * ── What was tightened on the way out of the controllers ────────────────────
 *
 * These bodies are the controllers' logic moved, with one deliberate exception. `toggleSavePost`
 * validated nothing at all: it never checked that the post existed, wasn't deleted, wasn't a
 * draft, or that its author hadn't blocked you — an unparseable id fell through to a 500. That
 * is survivable for a person tapping a bookmark on a post already rendered in front of them,
 * and it is not survivable for a caller that acts on ids from a model. The checks are added
 * here, so the human path gains them too.
 */

const idOf = (value) => (value?._id ? value._id : value)?.toString?.() ?? String(value);

/**
 * The post, if this actor is allowed to act on it at all.
 *
 * Shared by save and dismiss because they are the same question: does this post exist, is it
 * live, and is the actor on speaking terms with its author. Returns the lean post or a refusal
 * in the service's own shape.
 */
const readablePost = async (actorId, postId) => {
  if (!mongoose.isValidObjectId(postId)) {
    // 404 rather than 400, matching engagement.js: an id that cannot name a document is
    // indistinguishable, from the caller's side, from one that names a missing one.
    return { ok: false, status: 404, error: "Post not found" };
  }

  const post = await Post.findById(postId).select("author content isDeleted isDraft").lean();
  if (!post || post.isDeleted || post.isDraft) {
    return { ok: false, status: 404, error: "Post not found" };
  }

  /*
   * A block hides the post everywhere it would be rendered, so a row pointing at it would be
   * a saved item that can never appear — and, worse, a way to confirm the post still exists.
   * Skipped when the actor is the author: you may save your own post, and `eitherBlocks` on
   * yourself is a query with no answer worth waiting for.
   */
  if (idOf(post.author) !== idOf(actorId)) {
    if (await UserRelation.eitherBlocks(actorId, post.author)) {
      return { ok: false, status: 404, error: "Post not found" };
    }
  }

  return { ok: true, post };
};

/**
 * Toggle a post into or out of the actor's saved list.
 *
 * @returns `{ ok, saved }` — `saved: false` means this call *removed* it.
 *
 * A toggle, exactly like `likePost`, and it carries the same warning: a caller that asks to
 * save an already-saved post un-saves it. The bot layer is responsible for not offering one —
 * `already_saved` rides on the perception for that reason.
 */
export const savePost = async ({ actorId, postId }) => {
  if (!mongoose.isValidObjectId(postId)) {
    return { ok: false, status: 404, error: "Post not found" };
  }

  /*
   * Un-saving is checked first and needs no visibility check.
   *
   * A post you saved can later be deleted, or its author can block you, and then it is not
   * "readable" any more — but you still have a row in your saved list pointing at it, and
   * refusing to remove it would strand it there permanently. The visibility rules govern what
   * you may *add*, not what you may take back out.
   */
  const existing = await Saved.findOne({ user: actorId, post: postId }).select("_id").lean();
  if (existing) {
    await Saved.deleteOne({ _id: existing._id });
    return { ok: true, saved: false };
  }

  const readable = await readablePost(actorId, postId);
  if (!readable.ok) return readable;

  /*
   * `Saved` has no unique index — see the model — so two concurrent saves can both pass the
   * check above and write two rows. Harmless (the list de-duplicates on read and unsaving
   * removes by `user`+`post`), and not worth adding an index migration to this change.
   */
  await Saved.create({ user: actorId, post: postId });
  return { ok: true, saved: true };
};

/**
 * Record that the actor doesn't want to see posts like this one.
 *
 * Idempotent rather than a toggle — an upsert against the unique `{user, post}` index — so
 * unlike `savePost` a repeated call is harmless. Undoing is `undoNotInterested`, a separate
 * verb, which is why this one is safe to hand a bot without an `already` flag to guard it.
 *
 * @returns `{ ok }`
 */
export const setNotInterested = async ({ actorId, postId }) => {
  const readable = await readablePost(actorId, postId);
  if (!readable.ok) return readable;

  const { post } = readable;

  /*
   * The author and hashtags are denormalised onto the row because they are the *signal*: the
   * feed hard-hides this post and soft-down-ranks anything else by the same author or carrying
   * the same tags. Reading them from the post at write time means the signal survives the post
   * being edited or deleted afterwards.
   */
  await NotInterested.updateOne(
    { user: actorId, post: postId },
    { $set: { author: post.author, hashtags: parseHashtags(post.content || "") } },
    { upsert: true }
  );

  return { ok: true };
};

/**
 * Undo a dismissal. Idempotent, and deliberately never fails.
 *
 * An unparseable id, a post that has since been deleted, a row that was never there — all of
 * them mean the same thing to the caller: there is no dismissal on this post any more. The
 * controller returned 200 for every one of those before the extraction and still should; a
 * 404 on "stop hiding this" is an error nobody can act on.
 */
export const undoNotInterested = async ({ actorId, postId }) => {
  if (mongoose.isValidObjectId(postId)) {
    await NotInterested.deleteOne({ user: actorId, post: postId });
  }
  return { ok: true };
};

/**
 * Toggle an author into the actor's favourites.
 *
 * ── "Favourite" is an author, stored as a chat id ───────────────────────────
 *
 * There is no favourite-*post* concept in this app. The overflow menu on a post says "Add to
 * favorites" and acts on its author, and what it actually writes is the string `user_<id>`
 * into `UserSettings.chat.favoriteChats` — the same list that stars a conversation in the DM
 * screen. The feed's Favourites tab then reads that list back and filters posts by those
 * authors.
 *
 * That is a surprising shape and it is not being changed here; this function exists so the bot
 * path and the human path agree on it rather than each inventing their own idea of what
 * favouriting means.
 *
 * @returns `{ ok, favorite }` — `favorite: false` means this call removed them.
 */
export const favouriteAuthor = async ({ actorId, targetId }) => {
  if (!mongoose.isValidObjectId(targetId)) {
    return { ok: false, status: 404, error: "User not found" };
  }
  if (idOf(targetId) === idOf(actorId)) {
    return { ok: false, status: 400, error: "You can't favourite yourself" };
  }

  const chatId = `user_${idOf(targetId)}`;

  /*
   * Upsert, because a bot may never have opened the settings screen that creates this row.
   * `$setOnInsert` only — the toggle itself is a second write below, so that reading the
   * current list and writing the new one can't be split by the upsert creating an empty one.
   */
  const settings = await UserSettings.findOneAndUpdate(
    { user: actorId },
    { $setOnInsert: { user: actorId } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).select("chat.favoriteChats");

  const existing = settings?.chat?.favoriteChats || [];
  // Case-insensitively — legacy rows stored a mixed-case id and a plain `includes` would
  // add a second entry for the same person.
  const wasFavorite = existing.some((id) => sameChatId(id, chatId));

  if (wasFavorite) {
    settings.chat.favoriteChats = withoutChatId(existing, chatId);
    await settings.save();
    return { ok: true, favorite: false };
  }

  if (atPreferenceCap(existing, chatId)) {
    return { ok: false, status: 400, error: "Your favourites list is full" };
  }

  settings.chat.favoriteChats = [...existing, chatId];
  await settings.save();
  return { ok: true, favorite: true };
};
