import React, { createContext, useState, useContext, useEffect, useCallback, useRef } from 'react';
import { UserContext } from './UserContext';
import { useSocket } from './useSocket';

/*
 * Follow state broadcast to every open surface.
 *
 * This used to open its own `io()` connection — a second socket to the same
 * origin, with the same token, the same transports and the same `join`, in order
 * to listen for one event. Three things were wrong with that. It doubled every
 * user's connection count for no gain; its URL fell back to a hardcoded LAN
 * address (`http://192.168.5.133:5000`) when `VITE_SERVER` was unset, so a
 * misconfigured build quietly dialled someone's development machine; and the
 * effect depended on `handleFollowUpdate`, which changes on every `userAuth`
 * change — and `handleFollowUpdate` sets `userAuth`, so each follow update tore
 * the socket down and reopened it.
 *
 * SocketProvider is already an ancestor of this one and has already joined the
 * user's room, so the event arrives on the shared connection. Subscribing to it
 * is all that is left.
 */

// eslint-disable-next-line react-refresh/only-export-components
export const FollowContext = createContext();

export const FollowProvider = ({ children }) => {
  const { userAuth, setUserAuth } = useContext(UserContext);
  const { socket } = useSocket();
  const [followUpdates, setFollowUpdates] = useState([]);

  const handleFollowUpdate = useCallback((update) => {
    setFollowUpdates(prev => [...prev, update]);

    const currentStorage = JSON.parse(sessionStorage.getItem('userAuth')) || userAuth;
    let updatedFollowing = Array.isArray(currentStorage.following) ? [...currentStorage.following] : [];

    if (update.action === 'follow' && !update.isPending) {
      const isAlreadyFollowing = updatedFollowing.some(
        user => (typeof user === 'object' ? user.username === update.username : user === update.username)
      );
      if (!isAlreadyFollowing) {
        updatedFollowing.push({ username: update.username });
      }
    } else if (update.action === 'unfollow' || (update.action === 'cancel-request' && !update.isPending)) {
      updatedFollowing = updatedFollowing.filter(user => 
        typeof user === 'object' ? user.username !== update.username : user !== update.username
      );
    }

    const updatedUserAuth = { ...currentStorage, following: updatedFollowing };
    setUserAuth(updatedUserAuth);
    sessionStorage.setItem('userAuth', JSON.stringify(updatedUserAuth));

    Object.keys(sessionStorage).forEach(key => {
      if (key.startsWith('profile-')) {
        sessionStorage.removeItem(key);
      }
    });
  }, [setUserAuth, userAuth]);

  /*
   * Through a ref so the subscription doesn't depend on the handler's identity.
   * `handleFollowUpdate` is rebuilt whenever `userAuth` changes and itself calls
   * `setUserAuth`, so depending on it directly meant unsubscribing and
   * resubscribing on every single follow update.
   */
  const handlerRef = useRef(handleFollowUpdate);
  useEffect(() => {
    handlerRef.current = handleFollowUpdate;
  }, [handleFollowUpdate]);

  useEffect(() => {
    if (!socket) return;

    const onFollowStatusUpdate = (update) => handlerRef.current(update);
    socket.on('followStatusUpdate', onFollowStatusUpdate);

    return () => {
      socket.off('followStatusUpdate', onFollowStatusUpdate);
    };
  }, [socket]);

  return (
    <FollowContext.Provider value={{ followUpdates, handleFollowUpdate }}>
      {children}
    </FollowContext.Provider>
  );
};


// eslint-disable-next-line react-refresh/only-export-components
export const useFollow = () => useContext(FollowContext);
