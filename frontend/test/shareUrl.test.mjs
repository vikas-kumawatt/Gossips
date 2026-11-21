import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { buildShareUrl } from "../src/lib/shareTargets.js";
import PostCard from "../src/components/PostCard.jsx";
import { mount } from "../test-support/helpers.mjs";
import { UserContext } from "../src/contexts/UserContext.js";
import { PostInteractionProvider } from "../src/contexts/PostInteractionContext.jsx";
import { FollowContext } from "../src/contexts/FollowContext.jsx";
import { MuteContext } from "../src/contexts/MuteContext.jsx";
import { BlockContext } from "../src/contexts/BlockContext.jsx";
import { ChatContext } from "../src/contexts/ChatContext.jsx";
import { ReportContext } from "../src/contexts/ReportContext.jsx";
import toast from "react-hot-toast";

/**
 * Tests for post and comment share URL generation and PostCard copy-link action.
 */

test("buildShareUrl: formats canonical post route using runtime window origin", () => {
  const url = buildShareUrl({ username: "vikas", postId: "post_123" });
  assert.equal(url, `${window.location.origin}/vikas/post/post_123`);
  assert.doesNotMatch(url, /gossipsss\.netlify\.app/, "must not hardcode netlify domain");
  assert.doesNotMatch(url, new RegExp(`^${window.location.origin}/post/`), "must not use deprecated /post/:id shape");
  assert.doesNotMatch(url, /\/comment\//, "must not use deprecated /comment/:id shape");
});

test("buildShareUrl: strips leading @ from username", () => {
  const url = buildShareUrl({ username: "@vikas_k", postId: "post_456" });
  assert.equal(url, `${window.location.origin}/vikas_k/post/post_456`);
});

test("buildShareUrl: trims whitespace around username", () => {
  const url = buildShareUrl({ username: "  alice  ", postId: "post_789" });
  assert.equal(url, `${window.location.origin}/alice/post/post_789`);
});

test("buildShareUrl: safely falls back to 'user' when username is missing or empty", () => {
  assert.equal(
    buildShareUrl({ username: null, postId: "post_100" }),
    `${window.location.origin}/user/post/post_100`
  );
  assert.equal(
    buildShareUrl({ username: "", postId: "post_100" }),
    `${window.location.origin}/user/post/post_100`
  );
  assert.equal(
    buildShareUrl({ username: undefined, postId: "post_100" }),
    `${window.location.origin}/user/post/post_100`
  );
});

test("buildShareUrl: extracts _id when postId is an object or document reference", () => {
  const url = buildShareUrl({ username: "bob", postId: { _id: "mongo_obj_id" } });
  assert.equal(url, `${window.location.origin}/bob/post/mongo_obj_id`);
});

test("buildShareUrl: encodes characters that require URI encoding", () => {
  const url = buildShareUrl({ username: "user name", postId: "post_200" });
  assert.equal(url, `${window.location.origin}/user%20name/post/post_200`);
});

const TestProviderTree = ({ children, userAuth = { id: "u1", username: "currentuser", token: "valid_token" } }) => (
  <MemoryRouter>
    <UserContext.Provider value={{ userAuth, setUserAuth: () => {} }}>
      <PostInteractionProvider>
        <FollowContext.Provider value={{ followUpdates: [] }}>
          <MuteContext.Provider value={{ isMuted: () => false, mute: async () => {}, unmute: async () => {} }}>
            <BlockContext.Provider value={{ isBlocked: () => false, requestBlock: () => {}, unblock: () => {} }}>
              <ChatContext.Provider
                value={{
                  preferences: { favoriteChats: [], loaded: true },
                  actions: { toggleFavoriteChat: () => {} },
                }}
              >
                <ReportContext.Provider value={{ openReport: () => {} }}>
                  {children}
                </ReportContext.Provider>
              </ChatContext.Provider>
            </BlockContext.Provider>
          </MuteContext.Provider>
        </FollowContext.Provider>
      </PostInteractionProvider>
    </UserContext.Provider>
  </MemoryRouter>
);

const openMenuAndClickCopy = async (view) => {
  const menuTrigger =
    view.container.querySelector('[aria-haspopup="menu"]') ||
    Array.from(view.container.querySelectorAll("button")).find(
      (b) => b.className?.includes("rounded-full") && b.querySelector("svg")
    );
  assert.ok(menuTrigger, "must find menu trigger button");

  await view.click(menuTrigger);

  const copyLinkItem = Array.from(document.querySelectorAll("*")).find(
    (el) => el.textContent?.trim() === "Copy link" && (el.tagName === "BUTTON" || el.getAttribute("role") === "menuitem")
  );
  assert.ok(copyLinkItem, "must render Copy link menu item");

  await act(async () => {
    copyLinkItem.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });

  await new Promise((r) => setTimeout(r, 50));
};

test("PostCard copy-link: copies canonical post URL to clipboard and shows toast feedback", async () => {
  const originalWidth = window.innerWidth;
  window.innerWidth = 500;

  let copiedText = null;
  const originalClipboard = navigator.clipboard;
  navigator.clipboard = {
    writeText: async (text) => {
      copiedText = text;
      return Promise.resolve();
    },
  };

  let toastSuccessMsg = null;
  const originalToastSuccess = toast.success;
  toast.success = (msg) => {
    toastSuccessMsg = msg;
    return msg;
  };

  try {
    const postItem = {
      _id: "test_post_999",
      content: "A gossips post",
      author: { _id: "a1", username: "testauthor", name: "Test Author" },
      createdAt: new Date().toISOString(),
      counts: { likes: 0, reposts: 0, replies: 0 },
    };

    const view = await mount(
      <TestProviderTree>
        <PostCard item={postItem} author={postItem.author} />
      </TestProviderTree>
    );

    await openMenuAndClickCopy(view);

    assert.equal(
      copiedText,
      `${window.location.origin}/testauthor/post/test_post_999`,
      "must copy the canonical /:username/post/:postId URL to clipboard"
    );
    assert.equal(toastSuccessMsg, "Link copied", "must show success toast feedback");

    await view.unmount();
  } finally {
    window.innerWidth = originalWidth;
    navigator.clipboard = originalClipboard;
    toast.success = originalToastSuccess;
  }
});

test("PostCard copy-link on comment: links to parent post, not comment id or /comment route", async () => {
  const originalWidth = window.innerWidth;
  window.innerWidth = 500;

  let copiedText = null;
  const originalClipboard = navigator.clipboard;
  navigator.clipboard = {
    writeText: async (text) => {
      copiedText = text;
      return Promise.resolve();
    },
  };

  let toastSuccessMsg = null;
  const originalToastSuccess = toast.success;
  toast.success = (msg) => {
    toastSuccessMsg = msg;
    return msg;
  };

  try {
    const commentItem = {
      _id: "comment_id_555",
      post: "parent_post_888",
      content: "A comment on a post",
      author: { _id: "a2", username: "commenter", name: "Commenter" },
      createdAt: new Date().toISOString(),
      counts: { likes: 0, reposts: 0, replies: 0 },
    };

    const view = await mount(
      <TestProviderTree>
        <PostCard
          item={commentItem}
          author={commentItem.author}
          isComment={true}
          postId="parent_post_888"
        />
      </TestProviderTree>
    );

    await openMenuAndClickCopy(view);

    assert.equal(
      copiedText,
      `${window.location.origin}/commenter/post/parent_post_888`,
      "comment link must target the parent post"
    );
    assert.doesNotMatch(copiedText, /\/comment\//, "must never use /comment/ in URL");
    assert.equal(toastSuccessMsg, "Link copied", "must show success toast feedback");

    await view.unmount();
  } finally {
    window.innerWidth = originalWidth;
    navigator.clipboard = originalClipboard;
    toast.success = originalToastSuccess;
  }
});

test("PostCard copy-link: handles clipboard write rejection gracefully with error toast", async () => {
  const originalWidth = window.innerWidth;
  window.innerWidth = 500;

  const originalClipboard = navigator.clipboard;
  navigator.clipboard = {
    writeText: async () => Promise.reject(new Error("Permission denied")),
  };

  let toastErrorMsg = null;
  const originalToastError = toast.error;
  toast.error = (msg) => {
    toastErrorMsg = msg;
    return msg;
  };

  try {
    const postItem = {
      _id: "test_post_err",
      content: "Error test post",
      author: { _id: "a1", username: "author_err", name: "Author" },
      createdAt: new Date().toISOString(),
      counts: { likes: 0, reposts: 0, replies: 0 },
    };

    const view = await mount(
      <TestProviderTree>
        <PostCard item={postItem} author={postItem.author} />
      </TestProviderTree>
    );

    await openMenuAndClickCopy(view);

    assert.equal(toastErrorMsg, "Couldn't copy link", "must display error toast on failure");

    await view.unmount();
  } finally {
    window.innerWidth = originalWidth;
    navigator.clipboard = originalClipboard;
    toast.error = originalToastError;
  }
});

test("PostCard copy-link: executes fallback copy when navigator.clipboard is unavailable", async () => {
  const originalWidth = window.innerWidth;
  window.innerWidth = 500;

  const originalClipboard = navigator.clipboard;
  delete navigator.clipboard;

  let execCommandCalled = false;
  let copiedViaExec = null;
  const originalExecCommand = document.execCommand;
  document.execCommand = (command) => {
    if (command === "copy") {
      execCommandCalled = true;
      const textarea = document.querySelector("textarea");
      if (textarea) copiedViaExec = textarea.value;
      return true;
    }
    return false;
  };

  let toastSuccessMsg = null;
  const originalToastSuccess = toast.success;
  toast.success = (msg) => {
    toastSuccessMsg = msg;
    return msg;
  };

  try {
    const postItem = {
      _id: "test_post_fallback",
      content: "Fallback test post",
      author: { _id: "a1", username: "author_fallback", name: "Author" },
      createdAt: new Date().toISOString(),
      counts: { likes: 0, reposts: 0, replies: 0 },
    };

    const view = await mount(
      <TestProviderTree>
        <PostCard item={postItem} author={postItem.author} />
      </TestProviderTree>
    );

    await openMenuAndClickCopy(view);

    assert.equal(execCommandCalled, true, "execCommand('copy') must be called as fallback");
    assert.equal(
      copiedViaExec,
      `${window.location.origin}/author_fallback/post/test_post_fallback`
    );
    assert.equal(toastSuccessMsg, "Link copied");

    await view.unmount();
  } finally {
    window.innerWidth = originalWidth;
    navigator.clipboard = originalClipboard;
    document.execCommand = originalExecCommand;
    toast.success = originalToastSuccess;
  }
});
