// Chat utility functions for validation, formatting, and helpers

/**
 * Validate message content
 */
export const validateMessageContent = (content, maxLength = 5000) => {
  if (!content) return { valid: false, error: "Message cannot be empty" };
  
  if (typeof content !== 'string') {
    return { valid: false, error: "Invalid message format" };
  }
  
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: "Message cannot be empty" };
  }
  
  if (trimmed.length > maxLength) {
    return { valid: false, error: `Message too long (max ${maxLength} characters)` };
  }
  
  return { valid: true, content: trimmed };
};

/**
 * Sanitize message content
 */
export const sanitizeMessage = (content) => {
  if (!content) return '';
  
  // Remove any null bytes
  let sanitized = content.replace(/\0/g, '');
  
  // Trim whitespace
  sanitized = sanitized.trim();
  
  // Remove excessive newlines (more than 3 consecutive)
  sanitized = sanitized.replace(/\n{4,}/g, '\n\n\n');
  
  // Remove leading/trailing newlines
  sanitized = sanitized.replace(/^\n+|\n+$/g, '');
  
  return sanitized;
};

/**
 * Check if user can perform action based on rate limit
 */
export const checkRateLimit = (lastActionTime, minInterval = 1000) => {
  const now = Date.now();
  const timeSinceLastAction = now - lastActionTime;
  
  if (timeSinceLastAction < minInterval) {
    const waitTime = Math.ceil((minInterval - timeSinceLastAction) / 1000);
    return {
      allowed: false,
      error: `Please wait ${waitTime} second${waitTime > 1 ? 's' : ''} before sending another message`
    };
  }
  
  return { allowed: true };
};

/**
 * Format file size for display
 */
export const formatFileSize = (bytes) => {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
};

/**
 * Validate file upload
 */
export const validateFileUpload = (file, maxSize = 10 * 1024 * 1024) => {
  if (!file) {
    return { valid: false, error: "No file provided" };
  }
  
  // Check file size
  if (file.size > maxSize) {
    return { 
      valid: false, 
      error: `File too large. Maximum size is ${formatFileSize(maxSize)}` 
    };
  }
  
  // Check file type
  const allowedTypes = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif',
    'image/webp',
    'video/mp4',
    'video/quicktime',
    'video/webm'
  ];
  
  if (!allowedTypes.includes(file.type)) {
    return { 
      valid: false, 
      error: "Invalid file type. Only images and videos are allowed" 
    };
  }
  
  return { valid: true };
};

/**
 * Generate temporary message ID
 */
export const generateTempId = () => {
  return `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
};

/**
 * Format timestamp for messages
 */
export const formatMessageTime = (timestamp) => {
  const date = new Date(timestamp);
  const now = new Date();
  
  // Check if today
  const isToday = date.toDateString() === now.toDateString();
  
  // Check if yesterday
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();
  
  // Format time
  const hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 || 12;
  const timeString = `${displayHours}:${minutes} ${ampm}`;
  
  if (isToday) {
    return timeString;
  } else if (isYesterday) {
    return `Yesterday ${timeString}`;
  } else {
    // Check if this week
    const daysDiff = Math.floor((now - date) / (1000 * 60 * 60 * 24));
    if (daysDiff < 7) {
      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      return `${days[date.getDay()]} ${timeString}`;
    }
    
    // Format as date
    const month = date.toLocaleDateString('en-US', { month: 'short' });
    const day = date.getDate();
    return `${month} ${day}, ${timeString}`;
  }
};

/**
 * Format last seen time
 */
export const formatLastSeen = (lastSeen) => {
  if (!lastSeen) return 'Never';
  
  const date = new Date(lastSeen);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  
  if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7);
    return `${weeks}w ago`;
  }
  
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

/**
 * Group messages by sender and time
 */
export const groupMessages = (messages, maxGapMinutes = 2) => {
  if (!messages || messages.length === 0) return [];
  
  const groups = [];
  let currentGroup = [];
  
  messages.forEach((message, index) => {
    if (currentGroup.length === 0) {
      currentGroup.push(message);
      return;
    }
    
    const lastMessage = currentGroup[currentGroup.length - 1];
    const timeDiff = new Date(message.createdAt) - new Date(lastMessage.createdAt);
    const minutesDiff = timeDiff / 60000;
    
    const sameSender = message.sender === lastMessage.sender;
    const withinTimeGap = minutesDiff <= maxGapMinutes;
    
    if (sameSender && withinTimeGap) {
      currentGroup.push(message);
    } else {
      groups.push(currentGroup);
      currentGroup = [message];
    }
  });
  
  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }
  
  return groups;
};

/**
 * Extract mentions from message content
 */
export const extractMentions = (content) => {
  if (!content) return [];
  
  const mentionRegex = /@(\w+)/g;
  const mentions = [];
  let match;
  
  while ((match = mentionRegex.exec(content)) !== null) {
    mentions.push(match[1]);
  }
  
  return [...new Set(mentions)]; // Remove duplicates
};

/**
 * Check if message should show timestamp
 */
export const shouldShowTimestamp = (currentMessage, previousMessage, minGapMinutes = 30) => {
  if (!previousMessage) return true;
  
  const currentTime = new Date(currentMessage.createdAt);
  const previousTime = new Date(previousMessage.createdAt);
  const diffMinutes = (currentTime - previousTime) / 60000;
  
  return diffMinutes >= minGapMinutes;
};

/**
 * Debounce function for typing indicators
 */
export const debounce = (func, wait) => {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
};

/**
 * Throttle function for scroll events
 */
export const throttle = (func, limit) => {
  let inThrottle;
  return function(...args) {
    if (!inThrottle) {
      func.apply(this, args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
};

/**
 * Generate a random color for user avatars
 */
export const generateAvatarColor = (userId) => {
  const colors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', 
    '#98D8C8', '#6C5CE7', '#A29BFE', '#FD79A8',
    '#FDCB6E', '#6C5CE7', '#00B894', '#E17055'
  ];
  
  const index = userId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % colors.length;
  return colors[index];
};

/**
 * Create initials from name
 */
export const getInitials = (name) => {
  if (!name) return '?';
  
  const parts = name.trim().split(' ');
  if (parts.length === 1) {
    return parts[0].charAt(0).toUpperCase();
  }
  
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
};

/**
 * Check if URL is valid
 */
export const isValidUrl = (string) => {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
};

/**
 * Extract URLs from text
 */
export const extractUrls = (text) => {
  if (!text) return [];
  
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const matches = text.match(urlRegex);
  return matches || [];
};

/**
 * Truncate text with ellipsis
 */
export const truncateText = (text, maxLength = 100) => {
  if (!text || text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
};

/**
 * Check if message contains media
 */
export const hasMedia = (message) => {
  return message.media && message.media.length > 0;
};

/**
 * Get media type from message
 */
export const getMediaType = (message) => {
  if (!hasMedia(message)) return null;
  return message.media[0].type;
};

/**
 * Format conversation preview text
 */
export const formatConversationPreview = (message) => {
  if (!message) return '';
  
  if (message.isDeleted) {
    return 'This message was deleted';
  }
  
  if (hasMedia(message)) {
    const type = getMediaType(message);
    const typeMap = {
      image: '📷 Photo',
      video: '🎥 Video',
      gif: 'GIF',
      audio: '🎵 Audio',
      document: '📄 Document'
    };
    return message.content ? `${typeMap[type]}: ${truncateText(message.content, 50)}` : typeMap[type];
  }
  
  return truncateText(message.content, 50);
};

/**
 * Sort conversations by last message time
 */
export const sortConversations = (conversations) => {
  return conversations.sort((a, b) => {
    const timeA = new Date(a.latestMessage?.createdAt || 0);
    const timeB = new Date(b.latestMessage?.createdAt || 0);
    return timeB - timeA;
  });
};

/**
 * Filter conversations by search query
 */
export const filterConversations = (conversations, query) => {
  if (!query || !query.trim()) return conversations;
  
  const searchTerm = query.toLowerCase().trim();
  
  return conversations.filter(conv => {
    const username = conv.user?.username?.toLowerCase() || '';
    const name = conv.user?.name?.toLowerCase() || '';
    const content = conv.latestMessage?.content?.toLowerCase() || '';
    
    return username.includes(searchTerm) || 
           name.includes(searchTerm) || 
           content.includes(searchTerm);
  });
};

/**
 * Calculate unread count badge text
 */
export const formatUnreadCount = (count) => {
  if (count === 0) return '';
  if (count > 99) return '99+';
  return count.toString();
};

/**
 * Check if user is typing (client-side)
 */
export const isUserCurrentlyTyping = (typingUsers, userId) => {
  return typingUsers.has(userId);
};

/**
 * Validate emoji
 */
export const isValidEmoji = (emoji) => {
  // Basic emoji validation - checks if it's a single emoji character
  const emojiRegex = /^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)$/u;
  return emojiRegex.test(emoji);
};

export default {
  validateMessageContent,
  sanitizeMessage,
  checkRateLimit,
  formatFileSize,
  validateFileUpload,
  generateTempId,
  formatMessageTime,
  formatLastSeen,
  groupMessages,
  extractMentions,
  shouldShowTimestamp,
  debounce,
  throttle,
  generateAvatarColor,
  getInitials,
  isValidUrl,
  extractUrls,
  truncateText,
  hasMedia,
  getMediaType,
  formatConversationPreview,
  sortConversations,
  filterConversations,
  formatUnreadCount,
  isUserCurrentlyTyping,
  isValidEmoji
};