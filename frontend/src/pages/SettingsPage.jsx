import React, { useContext, useState } from "react";
import MobileNavbar from "../components/layouts/mobile-navbar";
import SiteHeader from "../components/layouts/site-header";
import CreatePost from "../components/CreatePost";
import { Icons } from "../components/icons";
import { UserContext } from "../contexts/UserContext";
import InPageNavigation from "../components/InPageNavigation";
import BlockedAccountsModal from "../components/BlockedAccountsModal";

const SettingsPage = () => {
  const { userAuth } = useContext(UserContext);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isBlockedModalOpen, setIsBlockedModalOpen] = useState(false);
  const openCreateModal = () => setIsCreateModalOpen(true);
  const closeCreateModal = () => setIsCreateModalOpen(false);
  const layoutContext = { openCreateModal, closeCreateModal };
  const [activeTab, setActiveTab] = useState(0);

  const handleTabChange = (index) => {
    setActiveTab(index);
  };

  const renderPrivacyTab = () => (
    <div className="flex flex-col mt-6 gap-4 items-start mx-2">
      <div className="flex relative items-center gap-4 mb-4 w-full">
        <Icons.lock className="h-6 w-6" />
        <p className="text-md">Private profile</p>
        
        <label className="inline-flex items-center cursor-pointer absolute top-1/2 right-0 transform -translate-y-1/2">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  
                />
                <div className="w-10 h-6 bg-gray-200 rounded-full peer peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 peer-checked:bg-blue-600"></div>
                <span className="absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition-transform duration-300 transform peer-checked:translate-x-full"></span>
              </label>
      </div>

      <div className="flex relative w-full items-center gap-4 mb-4">
        <Icons.mentions className="h-6 w-6" />
        <p className="text-md">Mentions</p>
        <Icons.chevronRight className="h-6 w-6 absolute right-0" strokeColor="#737373"/>
      </div>

      <div className="flex relative w-full items-center gap-4 mb-4">
        <Icons.onlineStatus className="h-6 w-6" />
        <p className="text-md">Online status</p>
        <Icons.chevronRight className="h-6 w-6 absolute right-0" strokeColor="#737373"/>
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

    <div className="flex relative w-full items-center gap-4 mb-4">
        <p className="text-md">Security</p>
        <Icons.link className="h-5 w-5 absolute right-0"/>
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
    </div>
  );
};

export default SettingsPage;
