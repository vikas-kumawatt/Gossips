import React, { useContext, useEffect, useState } from "react";
import MobileNavbar from "../components/layouts/mobile-navbar";
import SiteHeader from "../components/layouts/site-header";
import CreatePost from "../components/CreatePost";
import { Icons } from "../components/icons";
import { UserContext } from "../contexts/UserContext";
import InPageNavigation from "../components/InPageNavigation";
import BlockedAccountsModal from "../components/BlockedAccountsModal";
import MentionSettingsSheet from "../components/MentionSettingsSheet";
import ActiveSessionsModal from "../components/ActiveSessionsModal";
import OnlineStatusSheet from "../components/OnlineStatusSheet";
import { userAPI } from "../services/api";
import toast from "react-hot-toast";
import {
  disablePushNotifications,
  enablePushNotifications,
  isPushAvailable,
} from "../services/pushNotifications";

const SettingsPage = () => {
  const { userAuth, setUserAuth } = useContext(UserContext);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isBlockedModalOpen, setIsBlockedModalOpen] = useState(false);
  const [isMentionsOpen, setIsMentionsOpen] = useState(false);
  const [isOnlineStatusOpen, setIsOnlineStatusOpen] = useState(false);
  const [isSessionsOpen, setIsSessionsOpen] = useState(false);
  const [isPrivate, setIsPrivate] = useState(Boolean(userAuth?.isPrivate));
  const [privacySaving, setPrivacySaving] = useState(false);
  const openCreateModal = () => setIsCreateModalOpen(true);
  const closeCreateModal = () => setIsCreateModalOpen(false);
  const layoutContext = { openCreateModal, closeCreateModal };
  const [activeTab, setActiveTab] = useState(0);

  const handleTabChange = (index) => {
    setActiveTab(index);
  };

  /*
   * Push notification state for this device.
   *
   * Three separate facts, because they lead to three different bits of UI: whether the
   * browser and the project can do push at all, whether the user has permanently
   * denied it (which no button can undo — only browser settings can), and whether this
   * device is currently registered.
   */
  const [pushSupported, setPushSupported] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushBlocked, setPushBlocked] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    isPushAvailable().then((supported) => {
      if (cancelled) return;
      setPushSupported(supported);
      if (!supported) return;
      setPushBlocked(Notification.permission === "denied");
      setPushEnabled(Notification.permission === "granted");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const togglePush = async () => {
    setPushBusy(true);
    try {
      if (pushEnabled) {
        await disablePushNotifications();
        setPushEnabled(false);
        return;
      }
      const result = await enablePushNotifications();
      setPushEnabled(result.registered);
      // "denied" is final for the origin — the browser will not ask again, so the row
      // has to say so rather than leaving the toggle looking broken.
      if (result.reason === "denied") setPushBlocked(true);
    } finally {
      setPushBusy(false);
    }
  };

  const renderPrivacyTab = () => (
    <div className="flex flex-col mt-6 gap-4 items-start mx-2">
      {/*
        Message notifications (CF30b).

        The only way to grant permission. Delivery has been built since 8b and the
        token registration landed with it, but registration is deliberately silent —
        it never prompts, because a permission prompt fired on login is dismissed
        permanently by most people and browsers penalise it. So there has to be a
        deliberate control somewhere, and this is it.

        Hidden entirely when the browser can't do push or Firebase isn't configured:
        a toggle that cannot work is worse than no toggle, which is the rule
        featureGate.js states on the server side.
      */}
      {pushSupported && (
        <div className="flex relative items-center gap-4 mb-4 w-full">
          {/* Using sms (chat bubble) as the message notification icon. */}
          <Icons.chat2 className="h-7 w-7" />
          <div className="flex-1 min-w-0">
            <p className="text-md">Message notifications</p>
            <p className="text-xs text-neutral-500">
              {pushBlocked
                ? "Blocked in your browser settings for this site"
                : pushEnabled
                  ? "On for this device"
                  : "Off for this device"}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={pushEnabled}
            aria-label="Message notifications"
            disabled={pushBusy || pushBlocked}
            onClick={togglePush}
            className={`relative h-6 w-10 shrink-0 rounded-full transition-colors disabled:opacity-40 ${
              pushEnabled ? "bg-blue-600" : "bg-neutral-700"
            }`}
          >
            <span
              className={`absolute left-1 top-1 h-4 w-4 rounded-full bg-white transition-transform duration-300 ${
                pushEnabled ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      )}

      <div className="flex relative items-center gap-4 mb-4 w-full">
        <Icons.lock className="h-6 w-6" />
        <div className="flex-1 min-w-0">
          <p className="text-md">Private profile</p>
          <p className="text-xs text-neutral-500">
            {isPrivate ? "Only approved followers can see your posts" : "Anyone can see your profile and posts"}
          </p>
        </div>
        
        <button
          type="button"
          role="switch"
          aria-checked={isPrivate}
          aria-label="Private profile"
          disabled={privacySaving}
          onClick={async () => {
            const next = !isPrivate;
            setIsPrivate(next);
            setPrivacySaving(true);
            try {
              await userAPI.setupProfile({ isPrivate: next });
              setUserAuth({ ...userAuth, isPrivate: next });
              toast.success(next ? "Account is now private" : "Account is now public");
            } catch (err) {
              setIsPrivate(!next);
              toast.error(err?.response?.data?.error || "Failed to update privacy setting");
            } finally {
              setPrivacySaving(false);
            }
          }}
          className={`relative h-6 w-10 shrink-0 rounded-full transition-colors disabled:opacity-40 cursor-pointer ${
            isPrivate ? "bg-blue-600" : "bg-neutral-700"
          }`}
        >
          <span
            className={`absolute left-1 top-1 h-4 w-4 rounded-full bg-white transition-transform duration-300 ${
              isPrivate ? "translate-x-4" : "translate-x-0"
            }`}
          />
        </button>
      </div>

      <div
        className="flex relative w-full items-center gap-4 mb-4 cursor-pointer hover:opacity-80 transition-opacity"
        onClick={() => setIsMentionsOpen(true)}
      >
        <Icons.mentions className="h-6 w-6" />
        <p className="text-md">Mentions</p>
        <Icons.chevronRight className="h-5 w-5 absolute right-0" strokeColor="#737373"/>
      </div>

      <div
        className="flex relative w-full items-center gap-4 mb-4 cursor-pointer hover:opacity-80 transition-opacity"
        onClick={() => setIsOnlineStatusOpen(true)}
      >
        <Icons.onlineStatus className="h-6 w-6" />
        <p className="text-md">Online status</p>
        <Icons.chevronRight className="h-5 w-5 absolute right-0" strokeColor="#737373"/>
      </div>

      <div className="flex relative w-full items-center gap-4 mb-4">
        <Icons.restrict className="h-6 w-6" />
        <p className="text-md">Restricted profiles</p>
        <Icons.chevronRight className="h-6 w-6 absolute right-0" strokeColor="#737373"/>
      </div>

      <div
        className="flex relative w-full items-center gap-4 mb-4 cursor-pointer"
        onClick={() => setIsBlockedModalOpen(true)}
      >
        <Icons.blockedProfiles className="h-6 w-6" />
        <p className="text-md">Blocked profiles</p>
        <Icons.chevronRight className="h-6 w-6 absolute right-0" strokeColor="#737373"/>
      </div>

      <div className="flex relative w-full items-center gap-4 mb-4">
        <Icons.hide className="h-6 w-6" />
        <p className="text-md">Hidden words</p>
        <Icons.chevronRight className="h-6 w-6 absolute right-0" strokeColor="#737373"/>
      </div>
    </div>
  );

  const renderAccountTab = () => (
    <div className="flex flex-col mt-6 gap-4 items-start mx-2">
      {/*
        AI accounts used to have a row here as well. It has one entry point now — the header
        menu — because two doors to the same screen means one of them is the stale one, and
        this was the buried door: Settings, then a tab, then a page, then Create.
      */}
      <div className="flex relative w-full items-center gap-4 mb-4">
        <p className="text-md">Political content</p>
        <Icons.chevronRight className="h-6 w-6 absolute right-0" strokeColor="#737373"/>
      </div>

      <div className="flex relative w-full items-center gap-4 mb-4">
        <p className="text-md">Website permissions</p>
        <Icons.chevronRight className="h-6 w-6 absolute right-0" strokeColor="#737373"/>
      </div>

      <div className="flex relative w-full items-center gap-4 mb-4">
        <p className="text-md">Deactivate or delete profile</p>
        <Icons.chevronRight className="h-6 w-6 absolute right-0" strokeColor="#737373"/>
      </div>

      <div className="flex relative w-full items-center gap-4 mb-4">
        <p className="text-md">Fediverse sharing</p>
        <Icons.chevronRight className="h-6 w-6 absolute right-0" strokeColor="#737373"/>
      </div>

      <hr className="w-full border-b-0.5 border-neutral-700" strokeColor="#737373"/>

      <div className="flex relative w-full items-center gap-4 mb-4 mt-2">
        <p className="text-md">Personal information</p>
        <Icons.link className="h-5 w-5 absolute right-0"/>
      </div>

    <div className="flex relative w-full items-center gap-4 mb-4">
        <p className="text-md">Supervision</p>
        <Icons.link className="h-5 w-5 absolute right-0"/>
      </div>

    <div
        className="flex relative w-full items-center gap-4 mb-4 cursor-pointer hover:opacity-80 transition-opacity"
        onClick={() => setIsSessionsOpen(true)}
      >
        <p className="text-md">Security & Active Logins</p>
        <Icons.chevronRight className="h-5 w-5 absolute right-0" strokeColor="#737373"/>
      </div>

    <div className="flex relative w-full items-center gap-4 mb-4">
        <p className="text-md">Account status</p>
        <Icons.link className="h-5 w-5 absolute right-0"/>
      </div>

    <div className="flex relative w-full items-center gap-4 mb-4">
        <p className="text-md">Download your information</p>
        <Icons.link className="h-5 w-5 absolute right-0"/>
      </div>

      <div className="flex relative w-full items-center gap-4 mb-4">
        <p className="text-md">Transfer your information</p>
        <Icons.link className="h-5 w-5 absolute right-0"/>
      </div>
    </div>
  );

  const renderHelpTab = () => (
    <div className="flex flex-col mt-6 gap-4 items-start mx-2">
      <div className="flex relative w-full items-center gap-4 mb-4">
        <p className="text-md">Privacy and security help</p>
        <Icons.chevronRight className="h-6 w-6 absolute right-0" strokeColor="#737373"/>
      </div>

      <div className="flex relative w-full items-center gap-4 mb-4">
        <p className="text-md">Support requests</p>
        <Icons.chevronRight className="h-6 w-6 absolute right-0" strokeColor="#737373"/>
      </div>

      <hr className="w-full border-b-0.5 border-neutral-700" />

      <div className="flex relative w-full items-center gap-4 mb-4 mt-2">
        <p className="text-md">Help Center</p>
        <Icons.link className="h-5 w-5 absolute right-0"/>
      </div>

      <div className="flex relative w-full items-center gap-4 mb-4">
        <p className="text-md">Privacy Policy</p>
        <Icons.link className="h-5 w-5 absolute right-0"/>
      </div>

      <div className="flex relative w-full items-center gap-4 mb-4">
        <p className="text-md">Terms of Use</p>
        <Icons.link className="h-5 w-5 absolute right-0"/>
      </div>

      <div className="flex relative w-full items-center gap-4 mb-4">
        <p className="text-md">Cookies Policy</p>
        <Icons.link className="h-5 w-5 absolute right-0"/>
      </div>

      <div className="flex relative w-full items-center gap-4 mb-4">
        <p className="text-md">Fediverse Guide</p>
        <Icons.link className="h-5 w-5 absolute right-0"/>
      </div>
    </div>
  );

  if (!userAuth?.token) return null;

  return (
    <div className="w-full bg-neutral-950">
      <SiteHeader layoutContext={layoutContext} />
      <main className="container max-w-[620px] px-4 sm:px-6 bg-neutral-950 mx-auto pb-16">
        <p className="flex justify-center items-center mt-2 mb-4 font-medium ">
          <span>Settings </span>
          <span className="bg-neutral-800 rounded-full p-1 ml-2 mt-0.5">
            <Icons.chevronbottom />
          </span>
        </p>

        <div className="mt-2 ">
          <InPageNavigation
            routes={["Privacy", "Account", "Help"]}
            defaultActiveIndex={activeTab}
            onTabChange={handleTabChange}
          >
            <>
              {activeTab === 0 && renderPrivacyTab()}
              {activeTab === 1 && renderAccountTab()}
              {activeTab === 2 && renderHelpTab()}
            </>
          </InPageNavigation>
        </div>
      </main>

      <MobileNavbar layoutContext={layoutContext} />
      <CreatePost isOpen={isCreateModalOpen} onClose={closeCreateModal} />
      <BlockedAccountsModal
        isOpen={isBlockedModalOpen}
        onClose={() => setIsBlockedModalOpen(false)}
      />
      {isMentionsOpen && (
        <MentionSettingsSheet onClose={() => setIsMentionsOpen(false)} />
      )}
      {isOnlineStatusOpen && (
        <OnlineStatusSheet onClose={() => setIsOnlineStatusOpen(false)} />
      )}
      <ActiveSessionsModal
        isOpen={isSessionsOpen}
        onClose={() => setIsSessionsOpen(false)}
      />
    </div>
  );
};

export default SettingsPage;
