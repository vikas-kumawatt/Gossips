import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { botAPI } from "../../services/api";
import { Icons } from "../../components/icons";

/**
 * A simplified conversation card specifically for the Bot's DM list.
 */
const BotConversationCard = ({ chat, botId }) => {
  const peer = chat.user;
  const username = peer?.username;
  if (!username) return null;

  return (
    <Link
      to={`/ai-bots/${botId}/chat/${username}`}
      className="flex items-center gap-3 rounded-xl p-3 hover:bg-neutral-800 transition-colors"
    >
      <div className="relative shrink-0">
        <img
          src={peer.profilePic || "/default-avatar.png"}
          alt=""
          className="w-12 h-12 rounded-full object-cover"
        />
        {chat.unreadCount > 0 && (
          <div className="absolute top-0 right-0 w-3 h-3 bg-blue-500 rounded-full border-2 border-neutral-900" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex justify-between items-baseline">
          <p className="text-sm font-semibold text-white truncate">
            {peer.name || username}
          </p>
          {chat.latestMessage?.createdAt && (
            <span className="text-xs text-neutral-500 shrink-0 ml-2">
              {new Date(chat.latestMessage.createdAt).toLocaleDateString()}
            </span>
          )}
        </div>
        <p className="text-sm text-neutral-400 truncate mt-0.5">
          {chat.latestMessage?.content || (chat.latestMessage?.media?.length > 0 ? "Sent an attachment" : "")}
        </p>
      </div>
    </Link>
  );
};

const BotDMsList = ({ bot }) => {
  const [loading, setLoading] = useState(true);
  const [chats, setChats] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    let mounted = true;

    botAPI
      .getChats(bot._id)
      .then((data) => {
        if (mounted) {
          // getChats returns { items: [...] } typically based on ChatPage's mapping
          const rows = Array.isArray(data) ? data : data.chats || data.conversations || data.items || [];
          setChats(rows);
          setError(null);
        }
      })
      .catch(() => {
        if (mounted) setError("Could not load conversations.");
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [bot._id]);

  if (loading) {
    return (
      <div className="py-10 text-center">
        <Icons.spinner className="w-6 h-6 animate-spin mx-auto text-neutral-500" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-10 text-center text-rose-400 text-sm">
        {error}
      </div>
    );
  }

  // Filter out group chats, only direct messages for now (since the route is /chat/:peerUsername)
  const dms = chats.filter((chat) => chat.user);

  if (!dms.length) {
    return (
      <div className="py-10 text-center text-neutral-500 text-sm">
        This bot hasn't sent or received any direct messages yet.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {dms.map((chat) => (
        <BotConversationCard key={chat.conversation} chat={chat} botId={bot._id} />
      ))}
    </div>
  );
};

export default BotDMsList;
