import { useState } from "react";
import { Lock } from "lucide-react";
import toast from "react-hot-toast";
import { chatAPI } from "../../services/api";
import { saveUnlockGrant } from "../../services/chatUnlock";

/**
 * The PIN gate a locked conversation puts in front of itself.
 *
 * The chat lock used to be enforced only by the list refusing to open a locked
 * row, so typing `/chat/<username>` walked straight past it. The thread endpoint
 * refuses now, with a 423 naming the chat, and this is what answers it: prove the
 * PIN, store the grant, retry the load.
 *
 * It renders as the page rather than as a sheet over it. A sheet implies there is
 * something underneath to go back to, and there mustn't be — the whole point is
 * that nothing of the conversation has been loaded.
 */
const ChatLockPrompt = ({ chatId, onUnlocked, onCancel }) => {
  const [pin, setPin] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    if (submitting || !pin) return;
    setSubmitting(true);
    try {
      const data = await chatAPI.verifyChatLockPin(chatId, pin);
      saveUnlockGrant(data.chatId, data.grant, data.expiresAt);
      setPin("");
      onUnlocked();
    } catch (error) {
      // The PIN is left in place on a network failure but cleared on a refusal,
      // so a mistyped digit doesn't have to be hunted for in the field.
      if (error?.response?.status === 403) setPin("");
      toast.error(error?.response?.data?.error || "Couldn't unlock this chat.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 rounded-full bg-neutral-800 p-4">
        <Lock size={28} className="text-neutral-300" aria-hidden="true" />
      </div>
      <h2 className="text-lg font-semibold text-white">This chat is locked</h2>
      <p className="mt-2 max-w-xs text-sm text-neutral-400">
        Enter your chat lock PIN to read this conversation.
      </p>

      <form onSubmit={submit} className="mt-6 w-full max-w-xs">
        <label htmlFor="chat-lock-pin" className="sr-only">
          Chat lock PIN
        </label>
        <input
          id="chat-lock-pin"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          value={pin}
          onChange={(event) => setPin(event.target.value)}
          placeholder="PIN"
          className="w-full rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-3 text-center text-white outline-none placeholder-neutral-500"
        />
        <button
          type="submit"
          disabled={submitting || !pin}
          className="mt-3 w-full rounded-xl bg-white px-4 py-3 font-semibold text-black disabled:opacity-50"
        >
          {submitting ? "Checking…" : "Unlock"}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="mt-2 w-full rounded-xl px-4 py-3 text-sm text-neutral-400"
          >
            Back
          </button>
        )}
      </form>
    </div>
  );
};

export default ChatLockPrompt;
