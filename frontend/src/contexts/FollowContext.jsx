import React, { createContext, useState, useContext, useEffect, useCallback, useRef } from 'react';
import { UserContext } from './UserContext';
import io from 'socket.io-client';


// eslint-disable-next-line react-refresh/only-export-components
export const FollowContext = createContext();

export const FollowProvider = ({ children }) => {
  const { userAuth, setUserAuth } = useContext(UserContext);
  const [followUpdates, setFollowUpdates] = useState([]);
  const socketRef = useRef(null);

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

  useEffect(() => {
    if (userAuth.token) {
      const socketUrl = import.meta.env.VITE_SERVER ? new URL(import.meta.env.VITE_SERVER).origin : 'http://192.168.5.133:5000';
      const newSocket = io(socketUrl, {
        auth: { token: userAuth.token },
        transports: ['websocket', 'polling'],
      });

      newSocket.on('connect', () => {
        newSocket.emit('join', userAuth.id || userAuth._id);
      });

      newSocket.on('connect_error', (error) => {
        console.error('Socket connection error:', error);
      });

      newSocket.on('followStatusUpdate', (update) => {
        handleFollowUpdate(update);
      });

      socketRef.current = newSocket;

      return () => {
        newSocket.disconnect();
      };
    }
  }, [userAuth.token, userAuth.id, userAuth._id, handleFollowUpdate]);

  return (
    <FollowContext.Provider value={{ followUpdates, handleFollowUpdate }}>
      {children}
    </FollowContext.Provider>
  );
};


// eslint-disable-next-line react-refresh/only-export-components
export const useFollow = () => useContext(FollowContext);
