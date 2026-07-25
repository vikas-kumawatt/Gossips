import { useState, useEffect } from "react";

function useWindow() {
    const [windowSize, setWindowSize] = useState({
        width: undefined,
        height: undefined,
    });

    useEffect(() => {
        const handleResize = () => {
            setWindowSize({
                width: window.innerWidth,
                height: window.innerHeight,
            });
        };

        window.addEventListener("resize", handleResize);
        handleResize();

        return () => window.removeEventListener("resize", handleResize);
    }, []);

    const isMobile =  windowSize.width < 768;
    const isDesktop = windowSize.width >= 768;

    return { windowSize, isMobile, isDesktop };
}

export default useWindow;