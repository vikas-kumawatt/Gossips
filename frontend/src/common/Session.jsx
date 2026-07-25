const storeInSession = (key, data) => {
    return localStorage.setItem(key, JSON.stringify(data));
  };
  
  const lookInSession = (key) => {
    return localStorage.getItem(key);
  };
  
  const removeFromSession = (key) => {
    return localStorage.removeItem(key);
  };
  
  export { storeInSession, lookInSession, removeFromSession };