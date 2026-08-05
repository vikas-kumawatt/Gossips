import React, {
  useContext,
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useCallback,
} from "react";
import { UserContext } from "../contexts/UserContext";
import { useChat } from "../contexts/ChatContext";
import { useReport } from "../contexts/ReportContext";
import { useParams, useNavigate } from "react-router-dom";
import { Icons } from "../components/icons";
import { chatAPI } from "../services/api";
import CreatePollSheet from "../components/Chat/CreatePollSheet";
import ChatLockPrompt from "../components/Chat/ChatLockPrompt";
import ReconnectBanner from "../components/Chat/ReconnectBanner";
import MessageList from "../components/Chat/MessageList";
import VideoPlayerOverlay from "../components/Chat/VideoPlayerOverlay";
import ChatComposer from "../components/Chat/ChatComposer";
import MessageBubble from "../components/Chat/MessageBubble";
import { useVoiceRecorder } from "../hooks/useVoiceRecorder";
import useMediaTray from "../hooks/useMediaTray";
import { groupMessagesBySender } from "../lib/chatMessage";
import { MAX_MESSAGE_LENGTH } from "../lib/composerMedia";
import { downloadMedia } from "../lib/downloadMedia";
import { lockedChatIdFromError } from "../services/chatUnlock";
import { canEditMessage } from "../utils/messageEditing";
import ResponsiveMenu from "../components/ui/ResponsiveMenu";

const MESSAGE_RATE_LIMIT = 1000;
/** Matches the DM composer's cap. */
const MAX_RECORDING_MS = 120_000;
/*
 * The flat placeholder the preview bar falls back to when a clip carries no envelope.
 * Normalised 0-1, because the renderer sizes bars as `amp * 30px`.
 */
const VOICE_IDLE_WAVEFORM = Array.from(
  { length: 32 },
  (_, i) => 0.18 + Math.abs(Math.sin(i * 0.7 + 1)) * 0.65
);

const GroupChatPage = () => {
  const { userAuth } = useContext(UserContext);
  const currentUserId = userAuth?._id || userAuth?.id;
  const { groupId } = useParams();
  const navigate = useNavigate();
  const { openReport } = useReport();

  const {
    messages,
    threadLoading: messagesLoading,
    threadError: messagesError,
    actions: {
      loadGroupMessages,
      sendGroupMessage,
      editMessage, // Context handles if it's group message via messageId?
      unsendMessage,
      deleteMessageForMe, // Context handles logic
      pinMessage,
      voteInPoll,
      // Group messages were always reactable over the socket; nothing on this page
      // called it.
      reactToMessage,
      setCurrentConversation,
      markConversationAsRead,
      hydrateThreadFromCache,
    },
  } = useChat();

  const [newMessage, setNewMessage] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [group, setGroup] = useState(null); // Group info
  const [loading, setLoading] = useState(true);
  const [isSending, setIsSending] = useState(false); // Corrected declaration
  const [uploadingPreview, setUploadingPreview] = useState(null);
  const [replyingTo, setReplyingTo] = useState(null);
  const [editingMessage, setEditingMessage] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [selectedMessage, setSelectedMessage] = useState(null);
  const [error, setError] = useState(null); // Added missing error state
  /*
   * Attachments, the same tray the DM composer uses. Photos and videos only — see the
   * `accept` list in lib/composerMedia.js.
   */
  const tray = useMediaTray({ onReject: (message) => setError(message) });
  const [showPollComposer, setShowPollComposer] = useState(false);
  // Groups had no pinned bar at all — the route existed and always returned
  // empty, because the handler built a DM key from the group id.
  const [pinnedMessages, setPinnedMessages] = useState([]);
  const [pinnedDismissed, setPinnedDismissed] = useState(false);
  const [hasMore, setHasMore] = useState(true); // Added missing hasMore state
  // The chat lock, enforced server-side — see UserConversationPage for the
  // reasoning; `lockedChats` holds `group_<id>` entries too.
  const [lockedChatId, setLockedChatId] = useState(null);
  const [unlockAttempt, setUnlockAttempt] = useState(0);
  /*
   * Reactions and the media lightbox, which the group thread simply didn't have.
   *
   * The reaction picker, the pills, and tapping an image to open it full screen are
   * all in the shared bubble — but the bubble needs somewhere to report to, and this
   * page had no state for either. Group messages could be reacted to over the socket
   * and there was no way to do it.
   */
  const [reactingTo, setReactingTo] = useState(null);
  const [bigPreviewMedia, setBigPreviewMedia] = useState(null);

  /*
   * Voice recording, shared with the DM composer.
   *
   * The microphone button here had no handler — the recorder simply didn't exist on
   * this page. The hook owns the hardware and its own unmount cleanup, so navigating
   * away mid-recording releases the mic without this page having to remember to.
   */
  const voice = useVoiceRecorder({
    maxMs: MAX_RECORDING_MS,
    onError: (message) => setError(message),
  });
  const messagesEndRef = useRef(null);
  const messagesContainerRef = useRef(null);
  /*
   * The composer's height follows its content.
   *
   * A textarea has a fixed `rows` and won't grow, so a multi-line message would scroll a
   * one-line box. Capped by the element's own `max-h-32`, which is where 128 comes from.
   */
  const composerRef = useRef(null);
  const lastMessageTime = useRef(0);
  const hasFetchedData = useRef(false);
  const topSentinelRef = useRef(null);
  const scrollAnchorRef = useRef(null);
  const isInitialLoadRef = useRef(true);
  const isLoadingMoreRef = useRef(false);

  const loadPinned = useCallback(async () => {
    try {
      const res = await chatAPI.getGroupPinnedMessages(groupId);
      setPinnedMessages(res.pinnedMessages || []);
    } catch (err) {
      // A missing pinned bar isn't worth interrupting the thread over.
      console.error("Error fetching group pinned messages:", err);
    }
  }, [groupId]);

  useEffect(() => {
    setPinnedDismissed(false);
    if (groupId) loadPinned();
  }, [groupId, loadPinned]);

  // Voting is a socket emit, so the only failure it can report synchronously is
  // "no socket" — the result arrives later as a pollUpdated broadcast.
  const handleVote = useCallback(
    (messageId, optionIds) => {
      try {
        voteInPoll(messageId, optionIds);
      } catch (err) {
        console.error("Error voting in poll:", err);
        setError("Couldn't record your vote — check your connection.");
      }
    },
    [voteInPoll]
  );

  // Initialization Effect
  useEffect(() => {
    const initChat = async () => {
      // If we already fetched for this groupId, skip?
      // UserConversationPage resets hasFetchedData on params change.
      if (hasFetchedData.current === groupId) return;
      hasFetchedData.current = groupId;

      setLoading(true);
      setError(null);

      /*
       * The thread from its last snapshot, alongside the request rather than
       * before it — nothing here is awaited, so the network is never delayed, and
       * the provider declines if the fetch has already filled the thread. `loading`
       * is released as soon as something is painted so the spinner stops hiding it.
       */
      hydrateThreadFromCache("group", groupId)
        .then((cached) => {
          if (cached?.painted) setLoading(false);
        })
        .catch(() => {});

      try {
        /*
         * Set the conversation BEFORE loading, not after.
         *
         * SET_CURRENT_CONVERSATION clears the message array — that is how
         * switching chats avoids flashing the previous thread. Dispatching it
         * after loadGroupMessages threw away the page that had just been
         * fetched, so a group opened from the chat list showed its header and
         * an empty thread until a live message happened to arrive. The DM page
         * has always had the ordering the other way round.
         */
        setCurrentConversation(groupId);

        // response contains { messages, hasMore, groupInfo }
        const response = await loadGroupMessages(groupId);

        if (response && response.groupInfo) {
          setGroup(response.groupInfo);
          setHasMore(response.hasMore); // Update hasMore based on response
        }
      } catch (err) {
        // A locked group is a prompt, not a failure — see ChatLockPrompt.
        const locked = lockedChatIdFromError(err);
        if (locked) {
          setLockedChatId(locked);
          hasFetchedData.current = null;
          return;
        }
        console.error("Error in initChat:", err);
        setError("Failed to load group. Please try again.");
      } finally {
        setLoading(false);
      }
    };

    if (groupId && userAuth.token) {
      initChat();
    }

    return () => {
      hasFetchedData.current = null;
      setCurrentConversation(null);
    };
  }, [
    groupId,
    userAuth.token,
    loadGroupMessages,
    setCurrentConversation,
    hydrateThreadFromCache,
    // Bumped once the PIN prompt has stored a grant, so the load retries.
    unlockAttempt,
  ]);

  const loadMoreMessages = useCallback(async () => {
    // A ref, not the `loadingMore` state: the observer is rebuilt whenever this
    // callback's identity changes and re-observing an already-intersecting
    // sentinel fires immediately, so two callbacks in one tick would both see
    // false and request the same cursor.
    if (isLoadingMoreRef.current) return;
    if (!hasMore || messagesLoading) return;
    isLoadingMoreRef.current = true;

    const container = messagesContainerRef.current;
    if (container) {
      scrollAnchorRef.current = {
        prevScrollHeight: container.scrollHeight,
        prevScrollTop: container.scrollTop,
      };
    }

    setLoadingMore(true);
    try {
      const oldestMessage = messages[0];
      if (!oldestMessage) {
        scrollAnchorRef.current = null;
        return;
      }

      const cursor = oldestMessage
        ? btoa(
            JSON.stringify({
              createdAt: oldestMessage.createdAt,
              _id: oldestMessage._id,
            })
          )
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/g, "")
        : null;
      await loadGroupMessages(groupId, cursor);
    } catch (err) {
      console.error("Error loading more messages:", err);
    } finally {
      isLoadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [hasMore, messagesLoading, messages, loadGroupMessages, groupId]);

  /*
   * Group pagination, which has never worked.
   *
   * This observed `[data-first-message]` — an attribute that appears nowhere in
   * the app, so it observed nothing and older group messages could not be
   * loaded at all. It also ran before the list had mounted and had no
   * dependency that changed afterwards, the same dead-observer bug the DM page
   * had. Now: a real sentinel, gated on `loading`.
   */
  useEffect(() => {
    if (loading || !topSentinelRef.current || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMoreMessages();
      },
      { root: messagesContainerRef.current, rootMargin: "100px", threshold: 0 }
    );

    observer.observe(topSentinelRef.current);
    return () => observer.disconnect();
  }, [loading, hasMore, loadMoreMessages]);

  useEffect(() => {
    if (messagesError) {
      setError(messagesError);
    }
  }, [messagesError]);

  /*
   * This scrolled to the bottom on every change to the message array — so
   * loading older messages threw the user straight back to the newest one,
   * which made pagination useless even once the observer was attached.
   */
  useLayoutEffect(() => {
    const container = messagesContainerRef.current;
    if (loading || !container || messages.length === 0) return;

    if (scrollAnchorRef.current) {
      const { prevScrollHeight, prevScrollTop } = scrollAnchorRef.current;
      container.scrollTop = container.scrollHeight - prevScrollHeight + prevScrollTop;
      scrollAnchorRef.current = null;
      return;
    }

    if (isInitialLoadRef.current) {
      container.scrollTop = container.scrollHeight;
      isInitialLoadRef.current = false;
      return;
    }

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom < 150) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, loading, loadingMore]);

  /*
   * Mark the group read.
   *
   * This page never did — so a group's badge counted up while you sat reading
   * it, no read watermark was ever written for the group, and every message you
   * had ever received there stayed unread until you happened to click the group
   * in the chat list. Mirrors the DM page: newest inbound message only, and only
   * while the tab is actually visible.
   */
  const newestInboundId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const senderId = messages[i]?.sender?._id || messages[i]?.sender;
      if (String(senderId) !== String(currentUserId)) return messages[i]._id;
    }
    return null;
  }, [messages, currentUserId]);

  useEffect(() => {
    if (!newestInboundId || !groupId) return;

    const markIfVisible = () => {
      if (document.visibilityState !== "visible") return;
      markConversationAsRead(null, `group_${groupId}`, `g:${groupId}`);
    };

    markIfVisible();
    document.addEventListener("visibilitychange", markIfVisible);
    return () => document.removeEventListener("visibilitychange", markIfVisible);
  }, [newestInboundId, groupId, markConversationAsRead]);

  // No typing indicator for groups: the server's `typing` handler takes a
  // receiverId and emits to that one user, so there is nothing to broadcast to
  // a room yet.

  const resizeComposer = useCallback(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, []);

  // Also on programmatic changes — an emoji, a cleared send, entering edit mode — which
  // don't go through onChange.
  useEffect(() => {
    resizeComposer();
  }, [newMessage, resizeComposer]);

  const handleInputChange = (e) => {
    const value = e.target.value;
    if (editingMessage) {
      setNewMessage(value);
      return;
    }
    setNewMessage(value);
  };

  /**
   * @param media What is about to be sent, if anything.
   *
   * `media` is a parameter and not read off the tray, because by the time a send is
   * validated the tray has already been emptied — `handleSendMedia` takes the files
   * before it uploads them, and `sendVoiceNote` never puts its clip in the tray at all.
   * Checking only the tray meant an attachment or a voice note sent without a caption
   * was refused as "Message cannot be empty", which is exactly what the DM page passes
   * `media` through to avoid.
   */
  const validateMessage = (media = []) => {
    if (!newMessage.trim() && !media.length && !tray.items.length) {
      return "Message cannot be empty";
    }
    if (newMessage.length > MAX_MESSAGE_LENGTH) {
      return `Message too long (${MAX_MESSAGE_LENGTH} characters maximum)`;
    }
    const now = Date.now();
    if (now - lastMessageTime.current < MESSAGE_RATE_LIMIT) {
      return "Please wait a moment before sending another message";
    }
    return null;
  };

  /**
   * @returns whether the message actually went out.
   *
   * The caller needs to know. `handleSendMedia` uploads to Cloudinary *before* calling
   * this, so a send that stops at validation — an over-long caption, the rate limit —
   * used to look identical to success from out there: the uploads were orphaned, the
   * blob URLs were released and the optimistic bubble was cleared, so the user's photos
   * disappeared with nothing but a small error line to explain it.
   */
  const sendMessage = async (media = [], messageType = "text") => {
    if (editingMessage) {
      await handleEditMessage();
      return false;
    }
    const validationError = validateMessage(media);
    if (validationError) {
      setError(validationError);
      return false;
    }

    setIsSending(true);
    const tempId = `temp-${Date.now()}-${Math.random()}`;

    const messageData = {
      tempId,
      groupId,
      senderId: currentUserId,
      senderUsername: userAuth.username,
      content: newMessage.trim(),
      media,
      messageType,
      replyTo: replyingTo
        ? {
            _id: replyingTo._id,
            content: replyingTo.content,
            senderUsername: replyingTo.senderUsername,
            senderId: replyingTo.sender?._id || replyingTo.sender,
            messageType: replyingTo.messageType,
          }
        : null,
    };

    try {
      await sendGroupMessage(messageData);
      setNewMessage("");
      setReplyingTo(null);
      setError(null);
      lastMessageTime.current = Date.now();
      return true;
    } catch (err) {
      console.error("Error sending message:", err);
      // The server's own reason — "You're muted in this group", "Slow mode is on —
      // wait 12s" — reaches here now that the send is acknowledged. A generic
      // string threw away the only part the user could act on.
      setError(err?.message || "Failed to send message");
      return false;
    } finally {
      setIsSending(false);
    }
  };

  const handleEditMessage = async () => {
    if (!editingMessage || !newMessage.trim()) {
      setError("Message cannot be empty");
      return;
    }
    try {
      await editMessage(editingMessage._id, newMessage.trim());
      // Only on success. The provider used to swallow the rejection, so this
      // ran either way and the edit the user had typed was gone.
      setNewMessage("");
      setEditingMessage(null);
      setError(null);
    } catch (err) {
      console.error("Error editing message:", err);
      setError(
        err?.response?.data?.error || "Couldn't save that edit. Your text is still here."
      );
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // `handleSendButtonClick`, not `sendMessage`: with attachments staged, the text is
      // their caption. Calling `sendMessage` directly sent the caption as a message of
      // its own and left the photos sitting in the tray.
      if (!isSending) handleSendButtonClick();
    } else if (e.key === "Escape") {
      /*
       * Escape leaves the draft alone unless it *is* an edit.
       *
       * This cleared `newMessage` unconditionally, so pressing Escape while composing —
       * to dismiss the keyboard, or out of habit — deleted whatever had been typed with
       * no way back. Only an edit has something to revert to.
       */
      if (editingMessage) {
        setEditingMessage(null);
        setNewMessage("");
      }
      if (replyingTo) setReplyingTo(null);
      // ChatComposer closes its own emoji and GIF pickers on Escape before this runs.
    }
  };

  const handleEmojiClick = (emojiObject) => {
    if (newMessage.length + emojiObject.emoji.length <= MAX_MESSAGE_LENGTH) {
      setNewMessage((prev) => prev + emojiObject.emoji);
    }
  };

  /**
   * Send the staged photos and videos as one message, captioned by the composer text.
   *
   * Ported from the DM thread rather than rewritten. The group page had no equivalent —
   * its picker took one file at a time into a modal, with no caption, so a group could
   * not receive a multi-photo message at all and anything typed alongside was posted
   * separately afterwards.
   */
  const handleSendMedia = async () => {
    if (!tray.items.length || isSending) return;

    // `take` empties the tray and hands the items over *without* revoking their URLs:
    // the optimistic bubble below renders from them while the upload is in flight.
    const filesToUpload = tray.take();
    const caption = newMessage.trim();

    setUploadingPreview({
      _id: `uploading-${Date.now()}`,
      isOwn: true,
      isUploading: true,
      media: filesToUpload.map((f) => ({ type: f.type, url: f.url })),
      messageType: "media",
      createdAt: new Date().toISOString(),
      content: caption,
    });
    setIsSending(true);

    /*
     * Held outside the try so the catch can see what did upload. Uploads happen one at a
     * time before the message is sent, so a failure on file five of six leaves four in
     * Cloudinary with nothing pointing at them — and since the selection is put back for
     * a retry, pressing send again would upload them a second time (CF28).
     */
    const uploadedItems = [];

    try {
      for (const item of filesToUpload) {
        const formData = new FormData();
        formData.append("file", item.file);
        // The server's descriptor verbatim, signature included: it covers
        // {url, type, fileSize}, so a locally-rebuilt one fails verification on send.
        uploadedItems.push(await chatAPI.uploadMedia(formData));
      }

      // Refused sends are reported, not thrown, so the result has to be checked —
      // otherwise the cleanup below runs on a message that never left.
      if (!(await sendMessage(uploadedItems, "media"))) {
        throw new Error("The message was not sent");
      }

      // Only now are the local previews safe to release.
      filesToUpload.forEach((item) => tray.release(item.url));
      setUploadingPreview(null);
    } catch (err) {
      console.error("Error sending media:", err);
      setUploadingPreview(null);

      // Throw away whatever did upload, since the retry will upload it again. Best
      // effort — the message already didn't send, and a failed cleanup must not become
      // a second error for the user to read.
      if (uploadedItems.length) {
        chatAPI
          .discardChatMedia(uploadedItems)
          .catch((discardError) =>
            console.error("Couldn't discard orphaned uploads:", discardError)
          );
      }

      tray.restore(filesToUpload);
      // `setError` only when there is something new to say: a refusal has already put
      // the server's own reason on screen, and replacing it with a generic line would
      // throw away the part the user can act on.
      setError((current) =>
        err?.response?.data?.error ||
        current ||
        "Couldn't send that media — your files are still attached."
      );
    } finally {
      setIsSending(false);
    }
  };

  /**
   * What the send button does, which depends on what's in the composer.
   *
   * Attachments win over text, because the text is their caption rather than a message
   * of its own — except while editing, where the text is the edit.
   */
  const handleSendButtonClick = () => {
    if (isSending) return;
    if (tray.items.length > 0 && !editingMessage) {
      handleSendMedia();
      return;
    }
    sendMessage();
  };

  /** Shape from the shared GifPicker: { url, width, height }. */
  const handleGifSelect = (gif) => {
    sendMessage([{ type: "gif", url: gif.url, thumbnail: gif.url }], "gif");
  };

  /**
   * Send the recorded clip.
   *
   * Deliberately not routed through `handleSendMedia`: that path takes files off the
   * picker and knows nothing about a duration or an envelope, and both have to reach the
   * server or the bubble draws a synthetic waveform and claims 0:00.
   *
   * `takePreview` clears the composer and hands the clip over, without revoking its
   * blob URL — nothing here needs it, but keeping the contract identical to the DM
   * page's means the hook behaves the same either side.
   */
  const sendVoiceNote = async () => {
    if (!voice.preview || isSending) return;
    const clip = voice.takePreview();
    if (!clip) return;

    setIsSending(true);
    try {
      const formData = new FormData();
      formData.append("audio", clip.file);
      formData.append(
        "waveform",
        JSON.stringify(Array.isArray(clip.waveformSnapshot) ? clip.waveformSnapshot : [])
      );
      formData.append("duration", String(clip.duration));

      const uploaded = await chatAPI.uploadVoice(formData);
      if (!uploaded?.url) throw new Error("Upload returned no file");
      // The result is checked for the same reason it is in `handleSendMedia`: a refusal
      // is reported rather than thrown, and this clip has already left the recorder, so
      // treating a refusal as success discards the recording silently.
      if (!(await sendMessage([uploaded], "voice"))) {
        throw new Error("The voice message was not sent");
      }
    } catch (err) {
      console.error("Voice upload failed", err);
      // The reason `sendMessage` already reported, if it had one, in preference to this.
      setError((current) => current || "Couldn't send that voice message.");
    } finally {
      setIsSending(false);
      if (clip.url) URL.revokeObjectURL(clip.url);
    }
  };

  // Messages loaded from the server carry no `isOwn` flag — only the optimistic
  // send path sets one — so ownership has to be derived from the sender.
  const isOwnMessage = (msg) =>
    msg?.sender?._id === userAuth?.id || msg?.sender === userAuth?.id;

  /** How many people are in the group. `getGroup` returns this as `counts.members`. */
  const memberCount = group?.counts?.members ?? 0;

  /*
   * Stacks, dividers and `isOwn`, from the same helper the DM thread uses.
   *
   * The group list was a flat `messages.map` with an ad-hoc "show the avatar when the
   * sender changes" rule, so there was no bubble grouping, no day dividers and no
   * corner-radius continuation. `groupMessagesBySender` also breaks a stack when the
   * *sender* changes, not just the side — which matters here and not in a DM.
   */
  const messageGroups = useMemo(
    () => groupMessagesBySender(messages, currentUserId),
    [messages, currentUserId]
  );

  /**
   * "Ana replied to Ben" above a stack that quotes someone.
   *
   * Groups only. In a DM there are two people and the line would state the obvious,
   * which is why `replyLabelFor` isn't passed there. Full names, falling back to the
   * handle — a reply is about people, and half the point is seeing at a glance that it
   * was aimed at *you*.
   */
  const replyLabelFor = useCallback(
    (message) => {
      if (!message?.replyTo || message.isDeleted) return null;
      const who = (user) => user?.name || user?.username;
      const from = who(message.sender) || "Someone";
      const target = message.replyTo.sender;
      const to =
        String(target?._id || target) === String(currentUserId)
          ? "you"
          : who(target) || "someone";
      return `${from} replied to ${to}`;
    },
    [currentUserId]
  );

  const handleAddReaction = async (messageId, emoji) => {
    setReactingTo(null);
    try {
      await reactToMessage(messageId, emoji);
    } catch (err) {
      console.error("Failed to react:", err);
      setError("Couldn't add that reaction.");
    }
  };

  /** Scroll a quoted message into view and flash it, as the DM thread does. */
  const jumpToMessage = (messageId) => {
    const node = document.getElementById(`msg-${messageId}`);
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    node.classList.add("ring-2", "ring-violet-500/70", "rounded-2xl");
    setTimeout(() => {
      node.classList.remove("ring-2", "ring-violet-500/70", "rounded-2xl");
    }, 1200);
  };

  /*
   * Anchors the menu at the press, falling back to the bubble.
   *
   * The inline handler this replaces read `e.clientX/clientY` straight off the
   * event, which is 0,0 for a keyboard-invoked menu — the same bug the DM page
   * already fixed. A long press arrives as a pointer event and does carry
   * coordinates.
   */
  const handleMessageContextMenu = (msg, event) => {
    event.preventDefault?.();
    event.stopPropagation?.();

    setSelectedMessage(msg);

    const rect = event.currentTarget?.getBoundingClientRect?.();
    const x = Number.isFinite(event.clientX) && event.clientX ? event.clientX : rect?.left ?? 0;
    const y = Number.isFinite(event.clientY) && event.clientY ? event.clientY : rect?.bottom ?? 0;
    setContextMenu({ x, y });
  };

  const handleContextMenuAction = async (action) => {
    if (!selectedMessage) return;
    // These reject now that the provider stopped swallowing errors, and an
    // unhandled rejection in a menu handler is a silent no-op to the user.
    const attempt = async (label, run) => {
      try {
        await run();
        setError(null);
      } catch (err) {
        console.error(`${label} failed`, err);
        setError(err?.response?.data?.error || `Couldn't ${label} that message.`);
      }
    };

    switch (action) {
      case "reply":
        setReplyingTo(selectedMessage);
        break;
      case "edit":
        setEditingMessage(selectedMessage);
        setNewMessage(selectedMessage.content);
        break;
      case "unsend":
        await attempt("unsend", () => unsendMessage(selectedMessage._id));
        break;
      case "delete":
        await attempt("delete", () => deleteMessageForMe(selectedMessage._id));
        break;
      case "pin":
        await attempt("pin", async () => {
          // The target state, so a double-click doesn't net zero.
          await pinMessage(selectedMessage._id, !selectedMessage.isPinned);
          await loadPinned();
        });
        break;
      case "copy":
        navigator.clipboard.writeText(selectedMessage.content);
        break;
      // Fetched to a blob rather than linked, because `download` on an anchor is
      // ignored cross-origin and this media lives on Cloudinary.
      case "download":
        await attempt("download", () =>
          Promise.all((selectedMessage.media || []).map((item) => downloadMedia(item)))
        );
        break;
      case "report":
        openReport({
          targetType: "message",
          targetId: selectedMessage._id,
          // sender is an id rather than a document on some payloads; without a
          // username the sheet just drops the Block/Mute follow-ups.
          username: selectedMessage.sender?.username,
          name: selectedMessage.sender?.name,
        });
        break;
    }
    setContextMenu(null);
    setSelectedMessage(null);
  };

  /*
   * Checked before the loading and not-found branches, because a locked group is
   * neither: nothing loaded and nothing is missing — a PIN is owed.
   */
  if (lockedChatId) {
    return (
      <div className="flex flex-col min-h-screen bg-black text-white">
        <ChatLockPrompt
          chatId={lockedChatId}
          onUnlocked={() => {
            setLockedChatId(null);
            setUnlockAttempt((n) => n + 1);
          }}
          onCancel={() => navigate("/chat")}
        />
      </div>
    );
  }

  if (loading && !messages.length) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-black text-white">
        Loading group...
      </div>
    );
  }

  /*
   * Every failure used to collapse to a bare "Group not found" with no header
   * and no way back — a removed member, a deleted group and a dropped network
   * request were indistinguishable, and on desktop the only exit was the
   * browser's back button.
   */
  if (!group && !loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 min-h-screen bg-black text-white px-6 text-center">
        <Icons.group className="w-10 h-10 text-neutral-600" />
        <p className="text-neutral-300">
          {error || "This group isn't available."}
        </p>
        <p className="text-sm text-neutral-500">
          It may have been deleted, or you may no longer be a member.
        </p>
        <button
          onClick={() => navigate("/chat")}
          className="mt-2 px-4 py-2 rounded-full bg-neutral-800 hover:bg-neutral-700 text-sm"
        >
          Back to chats
        </button>
      </div>
    );
  }

  /*
   * `flex-1 min-h-0`, not `h-screen`.
   *
   * This page renders inside ChatLayout, whose shell is already exactly one dynamic
   * viewport tall. Asking for `h-screen` (`100vh`) on top of that made the group thread
   * taller than the box containing it — `100vh` is the *large* viewport height, so with
   * the keyboard open the composer was pushed off the bottom and the header off the
   * top. Filling the parent instead inherits the shell's keyboard-aware height, and
   * `min-h-0` is what lets the message list below actually scroll rather than stretch.
   */
  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden bg-black text-white">
      {/*
        Header, matching the DM page's.
        It was `bg-neutral-900` with a 40px avatar and its own spacing while the DM
        header is black with a 36px avatar — side by side they read as two different
        products. Same background, same paddings, same avatar size, and the whole
        identity block is one tap target to the group info page.
      */}
      <header className="shrink-0 bg-black border-b border-neutral-800 z-10 py-3 px-3 sm:py-4 sm:px-6">
        <div className="flex items-center gap-4">
          {/*
            Not md:hidden. The page lives inside ChatLayout, but a group opened
            directly still needs an exit on desktop — this was the only back control
            and it was hidden at exactly the width where the two-pane layout used to
            disappear.
          */}
          <button
            onClick={() => navigate("/chat")}
            className="md:hidden text-neutral-400 hover:text-white transition-colors"
            aria-label="Go back"
          >
            <Icons.back className="w-5 h-5" />
          </button>

          <button
            type="button"
            onClick={() => navigate(`/chat/group/${groupId}/info`)}
            className="flex items-center gap-3 flex-1 min-w-0 text-left"
            aria-label="Group info"
          >
            <img
              src={group?.avatar || "/default-group-avatar.png"}
              alt=""
              className="w-9 h-9 rounded-full object-cover border border-neutral-700 shrink-0 bg-neutral-800"
            />
            <div className="flex-1 min-w-0">
              <h2 className="font-medium text-base truncate">
                {group?.name || "Group"}
              </h2>
              {/*
                `counts.members`, which is what `getGroup` actually returns.
                This read `group.memberCount` — a key no server response has ever
                had — so every group header said "0 members".
              */}
              <p className="text-xs text-neutral-400">
                {memberCount} {memberCount === 1 ? "member" : "members"}
              </p>
            </div>
          </button>

          <div className="flex items-center gap-3 shrink-0">
            <button
              onClick={() => navigate(`/chat/group/${groupId}/info`)}
              aria-label="Group info"
              className="w-10 h-10 rounded-full flex items-center justify-center text-neutral-300 hover:text-white hover:bg-white/10 active:scale-90 transition-all"
            >
              <Icons.info className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      {/* Messages */}
      {/*
        Dismissible. One "Please wait a moment" used to pin this banner above
        the thread for the rest of the session — nothing anywhere cleared it.
      */}
      {error && (
        <div className="mx-4 mt-4 p-3 pr-10 relative bg-red-900/50 border border-red-500/50 rounded-lg text-red-200 text-sm text-center">
          {error}
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-red-500/20"
          >
            <Icons.close className="w-4 h-4" />
          </button>
        </div>
      )}
      <ReconnectBanner />

      {/* Outside the scroll container, like the DM page's — a summary that
          scrolls away with the oldest messages is never on screen. */}
      {pinnedMessages.length > 0 && !pinnedDismissed && (
        <div className="shrink-0 mx-2 mt-2 mb-1 p-3 bg-neutral-800 border-l-4 border-yellow-500 rounded-lg">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Icons.pin className="w-4 h-4 text-yellow-500" />
              <span className="text-sm font-medium text-white">
                Pinned Messages
              </span>
            </div>
            <button
              onClick={() => setPinnedDismissed(true)}
              aria-label="Hide pinned messages"
              className="text-neutral-400 hover:text-white"
            >
              <Icons.close className="w-4 h-4" />
            </button>
          </div>
          <div className="space-y-2 max-h-32 overflow-y-auto scrollbar-hide">
            {pinnedMessages.slice(0, 3).map((m) => (
              <button
                type="button"
                key={m._id}
                onClick={() => {
                  document
                    .getElementById(`msg-${m._id}`)
                    ?.scrollIntoView({ behavior: "smooth", block: "center" });
                }}
                className="w-full text-left text-sm text-neutral-300 hover:bg-neutral-700 p-2 rounded"
              >
                <div className="text-xs text-neutral-400 mb-0.5">
                  {m.sender?.username || "Unknown"}
                </div>
                <div className="truncate">
                  {m.isDeleted
                    ? "This message was deleted"
                    : m.content || "Attachment"}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* `min-h-0`: without it a flex child refuses to shrink below its content, so
          the list pushed the composer out of the shell instead of scrolling. */}
      <div
        ref={messagesContainerRef}
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden scrollbar-hide px-4 py-4 space-y-4"
      >
        {/*
          The same list the DM thread renders.
          This was ~170 lines of inline bubble markup: no day dividers, no bubble
          stacking, no reaction pills, no hover timestamp, and a media branch that
          handled images only. Sharing MessageList is what makes the two threads
          actually look alike rather than approximately alike.
        */}
        <MessageList
          groups={messageGroups}
          viewerId={currentUserId}
          reactingTo={reactingTo}
          loadingMore={loadingMore}
          topSentinelRef={topSentinelRef}
          emptyState={
            <div className="text-center py-12 text-neutral-400">
              <Icons.chat2 className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p>No messages yet. Say hello.</p>
            </div>
          }
          /*
            Whoever sent it — a group has many senders, so the avatar is the only
            thing identifying them. No name label: the face plus a tap through to the
            profile carries it, and a name over every stack is noise.
          */
          avatarFor={(message) => ({
            src: message.sender?.profilePic,
            username: message.sender?.username,
          })}
          onOpenProfile={(name) => navigate(`/${name}`)}
          replyLabelFor={replyLabelFor}
          onAddReaction={handleAddReaction}
          onContextMenu={handleMessageContextMenu}
          onJumpToMessage={jumpToMessage}
          onDismissReactions={() => setReactingTo(null)}
          onVote={handleVote}
          onOpenMedia={setBigPreviewMedia}
        />
        <div ref={messagesEndRef} />
      </div>

      {/* The optimistic bubble for an upload in flight, exactly as the DM thread does it.
          Outside MessageList because it isn't in `messages` yet — it has no id from the
          server, so it can't be part of a keyed stack. */}
      {uploadingPreview && (
        <div className="flex justify-end px-3 mb-3">
          <div className="max-w-[80%] flex flex-col items-end">
            <MessageBubble
              message={uploadingPreview}
              isOwn={true}
              msgIndex={0}
              groupLength={1}
              isReacting={false}
            />
          </div>
        </div>
      )}

      {/* `shrink-0` so the composer keeps its height when the keyboard shortens the
          shell, and safe-area padding so it clears the home indicator. */}
      <div
        className="shrink-0 bg-black"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {/*
          The same composer the DM thread uses, with two extra slots.

          A poll is kept here and absent there: between two people it collapses into a
          question you could just ask. Documents are kept because the modal below is the
          only path that sends one, and the tray has no way to preview a PDF.
        */}
        <ChatComposer
          value={newMessage}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          inputRef={composerRef}
          sending={isSending}
          replyingTo={replyingTo}
          onCancelReply={() => setReplyingTo(null)}
          editingMessage={editingMessage}
          onCancelEdit={() => {
            setEditingMessage(null);
            setNewMessage("");
          }}
          media={tray.items}
          onFilesSelected={tray.add}
          onRemoveMedia={tray.removeAt}
          onPreviewMedia={setBigPreviewMedia}
          voice={voice}
          idleWaveform={VOICE_IDLE_WAVEFORM}
          onSendVoice={sendVoiceNote}
          onSend={handleSendButtonClick}
          onEmoji={handleEmojiClick}
          onGifSelect={handleGifSelect}
          onPoll={() => setShowPollComposer(true)}
        />
        {showPollComposer && (
          <CreatePollSheet
            groupId={groupId}
            onClose={() => setShowPollComposer(false)}
          />
        )}
      </div>

      {/* Context Menu, Emoji Picker, etc would go here as overlays */}
      <ResponsiveMenu
          open={Boolean(contextMenu)}
          onClose={() => setContextMenu(null)}
          title="Message"
          className="fixed bg-neutral-800 border border-neutral-700 rounded-lg shadow-xl z-50 py-1"
          style={{ top: contextMenu?.y, left: contextMenu?.x }}
        >
          <button
            onClick={() => handleContextMenuAction("reply")}
            className="w-full text-left px-4 py-2 hover:bg-neutral-700 flex items-center gap-2"
          >
            <Icons.reply className="w-4 h-4" /> Reply
          </button>

          {/*
            isOwnMessage, not selectedMessage.isOwn. `isOwn` is set only on the
            optimistic object the send path builds, so it was absent from every
            message that came back from the server — meaning after a reload you
            could not edit or unsend your own group messages at all. The bubble
            beside it already aligned them correctly using the same helper.
          */}
          {(!selectedMessage || isOwnMessage(selectedMessage)) && (
            <>
              {/*
                Not offered where the server would refuse it: a poll, a call log, a
                shared post or anything past the fifteen-minute window. Opening edit
                mode only to have the save rejected is worse than no menu item.
                `isOwn` is absent on messages loaded from the server, so the type and
                age checks are applied to the row directly.
              */}
              {canEditMessage({ ...selectedMessage, isOwn: true }) && (
                <button
                  onClick={() => handleContextMenuAction("edit")}
                  className="w-full text-left px-4 py-2 hover:bg-neutral-700 flex items-center gap-2"
                >
                  <Icons.edit className="w-4 h-4" /> Edit
                </button>
              )}
              <button
                onClick={() => handleContextMenuAction("unsend")}
                className="w-full text-left px-4 py-2 hover:bg-neutral-700 flex items-center gap-2 text-red-400"
              >
                <Icons.trash className="w-4 h-4" /> Unsend
              </button>
            </>
          )}
          {/* Only where there is something to save, and never on a tombstone —
              an unsent message's media is gone from the CDN. */}
          {selectedMessage?.media?.length > 0 && !selectedMessage?.isDeleted && (
            <button
              onClick={() => handleContextMenuAction("download")}
              className="w-full text-left px-4 py-2 hover:bg-neutral-700 flex items-center gap-2"
            >
              <Icons.download className="w-4 h-4" />{" "}
              {selectedMessage.media.length > 1 ? "Download all" : "Download"}
            </button>
          )}
          <button
            onClick={() => handleContextMenuAction("delete")}
            className="w-full text-left px-4 py-2 hover:bg-neutral-700 flex items-center gap-2 text-red-400"
          >
            <Icons.trash className="w-4 h-4" /> Delete for Me
          </button>
          <button
            onClick={() => handleContextMenuAction("pin")}
            className="w-full text-left px-4 py-2 hover:bg-neutral-700 flex items-center gap-2"
          >
            <Icons.pin className="w-4 h-4" /> Pin
          </button>
          {selectedMessage && !isOwnMessage(selectedMessage) && (
            <button
              onClick={() => handleContextMenuAction("report")}
              className="w-full text-left px-4 py-2 hover:bg-neutral-700 flex items-center gap-2 text-red-400"
            >
              <Icons.report className="w-4 h-4" /> Report
            </button>
          )}
      </ResponsiveMenu>

      {/* Desktop only: the sheet has its own backdrop on a phone. */}
      {contextMenu && (
        <div
          className="fixed inset-0 z-40 hidden md:block"
          onClick={() => setContextMenu(null)}
        />
      )}

      {/* Media Preview Modal - Simplified */}
      {/*
        Tapping media in the thread opens it, which it never did here.
        Images get the lightbox, video gets the app's own player — the same pair the
        DM thread uses, so a photo in a group behaves like a photo in a DM.
      */}
      {bigPreviewMedia && bigPreviewMedia.type !== "image" && (
        <VideoPlayerOverlay
          src={bigPreviewMedia.url}
          onClose={() => setBigPreviewMedia(null)}
        />
      )}
      {bigPreviewMedia?.type === "image" && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Image preview"
          className="fixed inset-0 bg-black/90 flex items-center justify-center z-50"
          onClick={() => setBigPreviewMedia(null)}
        >
          <div
            className="relative max-w-[90vw] max-h-[90vh]"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setBigPreviewMedia(null)}
              aria-label="Close preview"
              className="absolute -top-5 -right-5 w-11 h-11 bg-neutral-800 rounded-full flex items-center justify-center hover:bg-red-500 transition-colors z-10"
            >
              <Icons.close className="w-4 h-4 text-white" />
            </button>
            <img
              src={bigPreviewMedia.url}
              alt=""
              className="max-w-[90vw] max-h-[90vh] object-contain rounded-xl"
            />
          </div>
        </div>
      )}

    </div>
  );
};

export default GroupChatPage;
