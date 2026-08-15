import React, { useEffect, useRef, useState } from "react";

// eslint-disable-next-line react-refresh/only-export-components
export let activeTabLineRef;
// eslint-disable-next-line react-refresh/only-export-components
export let activeTabRef;

/**
 * @param {string} [tabGapClass] the space between the tab bar and the panel below it.
 *        Defaults to what every existing caller already had, so this is opt-in: a page
 *        whose panel brings its own top padding can pass "" and stop paying twice.
 */
const InPageNavigation = ({
  routes,
  defaultHidden = [],
  defaultActiveIndex = 0,
  children,
  onTabChange,
  tabGapClass = "mb-4",
}) => {
  activeTabLineRef = useRef();
  activeTabRef = useRef();
  const [inPageNavIndex, setInPageNavIndex] = useState(defaultActiveIndex);
  const tabsRef = useRef([]);

  useEffect(() => {
    tabsRef.current = tabsRef.current.slice(0, routes.length);
  }, [routes]);

  useEffect(() => {
    if (tabsRef.current[defaultActiveIndex]) {
      changePageState(defaultActiveIndex);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultActiveIndex, routes]);

  const changePageState = (index) => {
    if (!tabsRef.current[index]) return;
    const currentTab = tabsRef.current[index];
    let leftPosition, width;
    
    if (index === 0) {
      leftPosition = 0;
     
      if (tabsRef.current[1]) {
        const midPoint = currentTab.offsetLeft + currentTab.offsetWidth +
                        (tabsRef.current[1].offsetLeft - (currentTab.offsetLeft + currentTab.offsetWidth)) / 2;
        width = midPoint;
      } else {
        width = currentTab.offsetWidth;
      }
    } else if (index === routes.length - 1) {
      const prevTab = tabsRef.current[index - 1];
      leftPosition = prevTab.offsetLeft + prevTab.offsetWidth +
                    (currentTab.offsetLeft - (prevTab.offsetLeft + prevTab.offsetWidth)) / 2;
     
      const containerWidth = currentTab.parentElement.offsetWidth;
      width = containerWidth - leftPosition;
    } else {
      const prevTab = tabsRef.current[index - 1];
      const nextTab = tabsRef.current[index + 1];
   
      leftPosition = prevTab.offsetLeft + prevTab.offsetWidth +
                    (currentTab.offsetLeft - (prevTab.offsetLeft + prevTab.offsetWidth)) / 2;
     
      const rightPosition = currentTab.offsetLeft + currentTab.offsetWidth +
                          (nextTab.offsetLeft - (currentTab.offsetLeft + currentTab.offsetWidth)) / 2;
     
      width = rightPosition - leftPosition;
    }
    
    Object.assign(activeTabLineRef.current.style, {
      width: `${width}px`,
      left: `${leftPosition}px`,
    });
   
    setInPageNavIndex(index);
    
    if (onTabChange) {
      onTabChange(index);
    }
  };
 
  return (
    <div className="w-full">
      <div
        className={`relative ${tabGapClass} border-b border-neutral-700 flex flex-nowrap overflow-x-hidden`}
      >
        {routes.map((route, i) => (
          <button
            ref={el => tabsRef.current[i] = el}
            key={i}
            className={`p-4 px-5 flex mx-auto ${
              inPageNavIndex === i ? "text-white" : "text-neutral-500"
            } ${defaultHidden.includes(route) ? " md:hidden " : ""}`}
            onClick={() => changePageState(i)}
          >
            {route}
          </button>
        ))}
        <hr
          ref={activeTabLineRef}
          className="absolute bottom-0 duration-300 border-1 border-white"
        />
      </div>
      <div className="content">
        {children}
      </div>
    </div>
  );
};

export default InPageNavigation;