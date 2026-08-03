import { useSocket } from "../../contexts/useSocket";

/**
 * "You're offline" plus a way to try again.
 *
 * socket.io stops retrying after its attempt cap and then does nothing, forever and
 * silently — no incoming messages, no typing, no presence — while the app still looks
 * connected. There was no UI for this at all and no way to retry but a reload (#92).
 *
 * A component rather than three copies: the conversation page, the chat list and the
 * group thread all need it, and a banner that exists on one of three surfaces is a
 * banner most people won't see.
 *
 * Renders nothing until reconnection has actually been abandoned — a brief drop
 * reconnects on its own and saying so would be noise.
 */
const ReconnectBanner = () => {
  const { reconnectFailed, retryConnection } = useSocket();
  if (!reconnectFailed) return null;

  return (
    <div
      role="alert"
      className="shrink-0 flex items-center justify-between gap-3 bg-amber-950/60 border-b border-amber-900/60 px-3 py-2 text-xs text-amber-200"
    >
      <span>You're offline — new messages won't appear until you reconnect.</span>
      <button
        type="button"
        onClick={retryConnection}
        className="shrink-0 rounded-full bg-amber-200/15 px-3 py-1 font-medium text-amber-100 hover:bg-amber-200/25"
      >
        Reconnect
      </button>
    </div>
  );
};

export default ReconnectBanner;
