/**
 * External share destinations for the bottom row of the share sheet.
 *
 * Each entry returns either a URL to open, or `copyOnly` for the platforms that
 * have no web share intent at all. Instagram and Threads genuinely can't accept
 * a URL from the web, so rather than pretend, those copy the link and open the
 * app — which is what every other site does with them.
 */

/**
 * The app's only post route is `/:username/post/:postId` (App.jsx), so a
 * `/post/<id>` link 404s. Comments live on their parent post's page, so a
 * shared comment links to the post that contains it.
 */
export const buildShareUrl = ({ username, postId }) =>
  `${window.location.origin}/${username}/post/${postId}`;

export const EXTERNAL_TARGETS = [
  {
    id: "whatsapp",
    label: "WhatsApp",
    icon: "whatsapp",
    href: (url, text) => `https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`,
  },
  {
    id: "x",
    label: "X",
    icon: "xLogo",
    href: (url, text) =>
      `https://x.com/intent/tweet?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`,
  },
  {
    id: "telegram",
    label: "Telegram",
    icon: "telegram",
    href: (url, text) =>
      `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`,
  },
  {
    id: "facebook",
    label: "Facebook",
    icon: "facebook",
    href: (url) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`,
  },
  {
    id: "reddit",
    label: "Reddit",
    icon: "reddit",
    href: (url, text) =>
      `https://www.reddit.com/submit?url=${encodeURIComponent(url)}&title=${encodeURIComponent(text)}`,
  },
  {
    id: "threads",
    label: "Threads",
    icon: "threads",
    href: (url, text) =>
      `https://www.threads.net/intent/post?text=${encodeURIComponent(`${text} ${url}`)}`,
  },
  {
    // No web share intent exists. Copy the link and open the app.
    id: "instagram",
    label: "Instagram",
    icon: "instagram",
    copyOnly: true,
    href: () => "https://www.instagram.com/",
    note: "Link copied — paste it into Instagram",
  },
  {
    id: "email",
    label: "Email",
    icon: "mail",
    href: (url, text) =>
      `mailto:?subject=${encodeURIComponent(text)}&body=${encodeURIComponent(url)}`,
  },
  {
    id: "sms",
    label: "SMS",
    icon: "sms",
    href: (url, text) => `sms:?&body=${encodeURIComponent(`${text} ${url}`)}`,
  },
];

/** The OS share sheet — only offered where the browser actually supports it. */
export const canUseNativeShare = () => typeof navigator !== "undefined" && !!navigator.share;

/** mailto:/sms: in a new tab leaves a blank window behind in Chrome and Safari. */
export const openShareTarget = (target, url, text) => {
  const href = target.href(url, text);
  if (href.startsWith("mailto:") || href.startsWith("sms:")) {
    window.location.href = href;
    return;
  }
  window.open(href, "_blank", "noopener,noreferrer");
};

export const nativeShare = async (url, text) => {
  try {
    await navigator.share({ title: "Gossips", text, url });
    return true;
  } catch {
    // Includes the user simply dismissing the sheet — not an error worth showing.
    return false;
  }
};
