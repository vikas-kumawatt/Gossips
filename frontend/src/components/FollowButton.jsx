import { useState, useEffect, useContext, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { UserContext } from '../contexts/UserContext';
import { useFollow } from "../contexts/FollowContext.jsx";
import { Icons } from './icons';
import { userAPI } from '../services/api';

const followStatusCache = new Map();

const getCachedFollowState = (username) => {
  if (!username) return null;
  return followStatusCache.get(username) || null;
};

const setCachedFollowState = (username, state) => {
  if (!username || !state) return;
  followStatusCache.set(username, {
    isFollowing: Boolean(state.isFollowing),
    isPending: Boolean(state.isPending),
    canFollowBack: Boolean(state.canFollowBack),
  });
};

const FollowButton = ({
  username,
  currentUserFollowing,
  isPrivate,
  onFollowStatusChange,
  initialState,
  disableStatusFetch = false,
}) => {
  const [followState, setFollowState] = useState({
    isFollowing: false,
    isPending: false,
    canFollowBack: false,
    isLoading: false,
  });
  const [isResolved, setIsResolved] = useState(false);
  // Only ever set for private accounts — see handleFollowAction.
  const [confirmUnfollow, setConfirmUnfollow] = useState(false);
  const { userAuth } = useContext(UserContext);
  const { followUpdates, handleFollowUpdate } = useFollow();

  const getInitialFollowState = () => {
    if (initialState?.isFollowing) {
      return true;
    }

    const isFollowingFromProps = Array.isArray(currentUserFollowing) && 
      currentUserFollowing.some(user => 
        (typeof user === 'object' && user?.username === username) || user === username
      );

    const storedAuth = JSON.parse(sessionStorage.getItem('userAuth')) || {};
    const storedFollowing = Array.isArray(storedAuth.following) ? storedAuth.following : [];
    const isFollowingFromStorage = storedFollowing.some(user => 
      (typeof user === 'object' && user?.username === username) || user === username
    );

    return isFollowingFromProps || isFollowingFromStorage;
  };

  const refreshFollowStatus = useCallback(async () => {
    if (!username || !userAuth?.token) return;

    try {
      if (disableStatusFetch) {
        const nextState = {
          isFollowing: Boolean(initialState?.isFollowing),
          isPending: Boolean(initialState?.isPending),
          canFollowBack: Boolean(initialState?.canFollowBack),
        };
        setFollowState(prev => ({ ...prev, ...nextState }));
        setCachedFollowState(username, nextState);
        setIsResolved(true);
        return;
      }

      const cachedState = getCachedFollowState(username);
      if (cachedState) {
        setFollowState(prev => ({ ...prev, ...cachedState }));
        setIsResolved(true);
        return;
      }

      setIsResolved(false);
      const isFollowing = getInitialFollowState();
      const baseState = {
        isFollowing,
        isPending: false,
        canFollowBack: false,
      };
      setFollowState(prev => ({ ...prev, ...baseState }));

      if (!isFollowing) {
        const [pendingData, followBackData] = await Promise.all([
          userAPI.getPendingRequest(username),
          userAPI.isFollowingMe(username),
        ]);

        const nextState = {
          ...baseState,
          isPending: pendingData.isPending,
          canFollowBack: followBackData.isFollowingMe && !isFollowing,
        };
        setFollowState(prev => ({ ...prev, ...nextState }));
        setCachedFollowState(username, nextState);
      } else {
        setCachedFollowState(username, baseState);
        setFollowState(prev => ({ ...prev, ...baseState }));
      }
      setIsResolved(true);
    } catch (error) {
      console.error('Error refreshing follow status:', error);
      setIsResolved(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    disableStatusFetch,
    initialState?.canFollowBack,
    initialState?.isFollowing,
    initialState?.isPending,
    username,
    userAuth?.token,
  ]);

  useEffect(() => {
    const lastUpdate = followUpdates[followUpdates.length - 1];
    if (lastUpdate && lastUpdate.username === username) {
      const nextIsFollowing =
        lastUpdate.action === "follow" && !lastUpdate.isPending;
      const nextIsPending = Boolean(lastUpdate.isPending);

      setFollowState(prev => ({
        ...prev,
        isFollowing: nextIsFollowing,
        isPending: nextIsPending,
      }));
      setCachedFollowState(username, {
        isFollowing: nextIsFollowing,
        isPending: nextIsPending,
        canFollowBack: followState.canFollowBack,
      });
      setIsResolved(true);

      if (!nextIsFollowing && userAuth?.token) {
        userAPI.isFollowingMe(username)
          .then(data => {
            const nextState = {
              isFollowing: nextIsFollowing,
              isPending: nextIsPending,
              canFollowBack: Boolean(data.isFollowingMe),
            };
            setFollowState(prev => ({
              ...prev,
              canFollowBack: nextState.canFollowBack,
            }));
            setCachedFollowState(username, nextState);
          })
          .catch(error => console.error('Error checking follow-back:', error));
      }
    }
  }, [followUpdates, username, userAuth?.token, followState.canFollowBack]);

  useEffect(() => {
    refreshFollowStatus();
  }, [username, currentUserFollowing, userAuth?.token, refreshFollowStatus]);

  /**
   * Tapping the button acts immediately — except when it would unfollow a
   * private account. Re-following one means sending a request and waiting for
   * approval, so an accidental tap there costs real access; a public account
   * can just be followed again.
   */
  const handleFollowAction = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!userAuth?.token) return;

    if (followState.isFollowing && isPrivate) {
      setConfirmUnfollow(true);
      return;
    }
    runFollowAction();
  };

  const runFollowAction = async () => {
    if (!userAuth?.token) return;
    setConfirmUnfollow(false);
    setFollowState(prev => ({ ...prev, isLoading: true }));
    const { isFollowing, isPending } = followState;

    try {
      if (isFollowing) {
        await userAPI.unfollow(username);
        const nextState = {
          isFollowing: false,
          isPending: false,
          canFollowBack: followState.canFollowBack,
        };
        setFollowState(prev => ({ ...prev, ...nextState }));
        setCachedFollowState(username, nextState);
        setIsResolved(true);
        handleFollowUpdate({ username, action: 'unfollow' });
        if (onFollowStatusChange) onFollowStatusChange({ username, ...nextState });
      } else if (isPending) {
        await userAPI.cancelFollowRequest(username);
        const nextState = {
          isFollowing: false,
          isPending: false,
          canFollowBack: followState.canFollowBack,
        };
        setFollowState(prev => ({ ...prev, ...nextState }));
        setCachedFollowState(username, nextState);
        setIsResolved(true);
        handleFollowUpdate({ username, action: 'cancel-request', isPending: false });
        if (onFollowStatusChange) onFollowStatusChange({ username, ...nextState });
      } else {
        await userAPI.follow(username);
        if (isPrivate) {
          const nextState = {
            isFollowing: false,
            isPending: true,
            canFollowBack: false,
          };
          setFollowState(prev => ({ ...prev, ...nextState }));
          setCachedFollowState(username, nextState);
          setIsResolved(true);
          handleFollowUpdate({ username, action: 'follow', isPrivate: true, isPending: true });
          if (onFollowStatusChange) onFollowStatusChange({ username, ...nextState });
        } else {
          const nextState = {
            isFollowing: true,
            isPending: false,
            canFollowBack: false,
          };
          setFollowState(prev => ({ ...prev, ...nextState }));
          setCachedFollowState(username, nextState);
          setIsResolved(true);
          handleFollowUpdate({ username, action: 'follow', isPrivate: false, isPending: false });
          if (onFollowStatusChange) onFollowStatusChange({ username, ...nextState });
        }
      }

      sessionStorage.removeItem(`profile-${username}`);
    } catch (error) {
      console.error('Error with follow action:', error.response?.data || error.message);
      setFollowState(prev => ({ ...prev, isFollowing, isPending }));
    } finally {
      setFollowState(prev => ({ ...prev, isLoading: false }));
    }
  };

  const { isFollowing, isPending, canFollowBack, isLoading } = followState;
  const buttonText = (!isResolved || isLoading)
    ? <Icons.spinner className="w-4 h-4 animate-spin text-center" />
    : isFollowing
    ? 'Following'
    : isPending
    ? 'Requested'
    : canFollowBack
    ? 'Follow Back'
    : 'Follow';

  const buttonClasses = `follow-button text-sm ${
    isFollowing ? 'following text-sm text-neutral-500 font-medium' : 
    isPending ? 'pending' : 
    canFollowBack ? 'follow-back text-sm' : ''
  } cursor-pointer disabled:opacity-50`;

  return (
    <>
      <button
        onClick={handleFollowAction}
        disabled={isLoading || !isResolved}
        className={buttonClasses}
      >
        {buttonText}
      </button>

      {/* Portalled: this button lives inside cards and list rows that clip
          their overflow, so an inline dialog would be cut off. */}
      {confirmUnfollow &&
        createPortal(
          <div
            className="fixed inset-0 z-[2200] flex items-center justify-center bg-black/70 px-4"
            onClick={(e) => {
              e.stopPropagation();
              setConfirmUnfollow(false);
            }}
          >
            <div
              className="w-full max-w-[340px] rounded-2xl border border-neutral-700 bg-[#181818] p-5"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="font-semibold text-white">Unfollow @{username}?</h2>
              <p className="mt-2 text-sm text-neutral-400">
                Their account is private. To follow them again you'll have to
                send a request and wait for them to accept it.
              </p>
              <div className="mt-5 flex gap-2">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmUnfollow(false);
                  }}
                  className="flex-1 cursor-pointer rounded-xl border border-neutral-700 py-2.5 text-sm font-medium text-white transition-colors hover:bg-neutral-800"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    runFollowAction();
                  }}
                  className="flex-1 cursor-pointer rounded-xl bg-rose-600 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
                >
                  Unfollow
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
};

export default FollowButton;
