import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { botAPI } from "../../services/api";
import { Icons } from "../../components/icons";
import MessageList from "../../components/Chat/MessageList";
import { groupMessagesBySender } from "../../lib/chatMessage";
import { ArrowLeft } from "lucide-react";

/**
 * A read-only view of a bot's direct messages with a specific user.
 * Built similarly to UserConversationPage but decoupled from the logged-in user's ChatContext.
 */
const BotConversationPage = () => {
  const { id: botId, peerUsername } = useParams();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState(null);
  
  // Minimal representation of the peer to pass to avatarFor
  const [peerData, setPeerData] = useState(null);

  useEffect(() => {
    let mounted = true;

    // We pass limit: 100 for a reasonable scroll length in a read-only viewer
    botAPI
      .getConversation(botId, peerUsername, { limit: 100 })
      .then((data) => {
        if (mounted) {
          // If the endpoint returns the standard getMessages format (an array of messages)
          // The peer will be one of the participants.
          const msgs = Array.isArray(data) ? data : data.messages || [];
          // Need to reverse if they come back newest-first, which getMessages usually does.
          const sorted = msgs.slice().reverse();
          setMessages(sorted);
          
          if (data.peer) {
            setPeerData(data.peer);
          } else if (sorted.length > 0) {
            // Fallback for deduplicating peer from messages
            const firstMsg = sorted[0];
            const p =
              firstMsg.sender?._id === botId
                ? firstMsg.receiver
                : firstMsg.sender;
            setPeerData(p);
          }
          setError(null);
        }
      })
      .catch(() => {
        if (mounted) setError("Could not load messages.");
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [botId, peerUsername]);

  const messageGroups = groupMessagesBySender(messages);

  return (
    <div className="flex flex-col h-full bg-neutral-950">
      {/* Header */}
      <div className="flex items-center h-[60px] px-3 shrink-0 border-b border-neutral-800 bg-neutral-950 z-10">
        <button
          type="button"
          onClick={() => navigate(`/ai-bots/${botId}`)}
          className="p-2 -ml-2 mr-1 text-neutral-400 hover:text-white transition-colors cursor-pointer"
          aria-label="Back to bot details"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-3">
          <img
            src={peerData?.profilePic || "/default-avatar.png"}
            alt=""
            className="w-9 h-9 rounded-full object-cover"
          />
          <div className="flex flex-col">
            <span className="font-medium text-white text-[15px]">
              {peerData?.name || peerUsername}
            </span>
            <span className="text-[13px] text-neutral-500">
              Read-only view
            </span>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto min-h-0 flex flex-col relative">
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <Icons.spinner className="w-6 h-6 animate-spin text-neutral-500" />
          </div>
        ) : error ? (
          <div className="absolute inset-0 flex items-center justify-center text-rose-400 text-sm">
            {error}
          </div>
        ) : (
          <div className="flex-1 flex flex-col justify-end">
            <div className="pb-4 pt-4">
              <MessageList
                groups={messageGroups}
                viewerId={botId}
                reactingTo={null}
                loadingMore={false}
                topSentinelRef={null}
                emptyState={
                  <div className="text-center py-12 text-neutral-400">
                    <Icons.chat2 className="w-12 h-12 mx-auto mb-3 opacity-50" />
                    <p>No messages in this conversation.</p>
                  </div>
                }
                avatarFor={(senderId) => {
                  if (senderId === botId) {
                    return null; // Don't show avatar for the bot (right side)
                  }
                  return {
                    src: peerData?.profilePic,
                    username: peerData?.username,
                  };
                }}
                onOpenProfile={(name) => navigate(`/${name}`)}
                // Provide no-op handlers for the read-only view
                indicatorFor={() => null}
                onAddReaction={() => {}}
                onContextMenu={() => {}}
                onJumpToMessage={() => {}}
                onDismissReactions={() => {}}
                onVote={() => {}}
                onOpenMedia={() => {}}
              />
            </div>
          </div>
        )}
      </div>

      {/* Footer / Disabled Composer Area */}
      <div className="shrink-0 p-3 bg-neutral-950 border-t border-neutral-800">
        <div className="w-full rounded-2xl bg-neutral-900 border border-neutral-800 px-4 py-3 text-center">
          <p className="text-sm text-neutral-500">
            You cannot send messages as your AI bot.
          </p>
        </div>
      </div>
    </div>
  );
};

export default BotConversationPage;
