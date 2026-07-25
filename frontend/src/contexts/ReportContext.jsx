import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import ReportSheet from "../components/ReportSheet";

/**
 * ReportContext — one report sheet for the whole app, opened from anywhere.
 *
 * Mirrors BlockContext: entry points (post menu, profile, chat, message menu)
 * call `openReport(...)` instead of each owning their own modal state.
 *
 * openReport({
 *   targetType,      // "post" | "comment" | "message" | "conversation" | "user"
 *   targetId,        // required except for "user" / "conversation"
 *   username,        // the account behind the content — powers Block/Mute follow-ups
 *   name,
 *   onNotInterested, // optional; shows a "see fewer posts like this" follow-up
 * })
 */
// eslint-disable-next-line react-refresh/only-export-components
export const ReportContext = createContext({ openReport: () => {} });

export const ReportProvider = ({ children }) => {
  const [target, setTarget] = useState(null);
  // Remounts the sheet on every open, even for the same target — otherwise
  // reopening during the previous sheet's exit animation leaves it invisible.
  const instance = useRef(0);

  const openReport = useCallback((next) => {
    if (!next?.targetType) return;
    instance.current += 1;
    setTarget({ ...next, instanceId: instance.current });
  }, []);

  const closeReport = useCallback(() => setTarget(null), []);

  // Stable value: every PostCard in the feed consumes this.
  const value = useMemo(() => ({ openReport }), [openReport]);

  return (
    <ReportContext.Provider value={value}>
      {children}
      {target && (
        <ReportSheet
          key={target.instanceId}
          target={target}
          onClose={closeReport}
        />
      )}
    </ReportContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export const useReport = () => useContext(ReportContext);
