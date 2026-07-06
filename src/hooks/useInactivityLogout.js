import { useEffect, useRef } from "react";

// Calls onTimeout after `timeoutMs` of no user activity (mouse, keyboard,
// touch, or scroll). The timer resets on any activity, so it only fires
// after a genuine idle gap — not after a fixed amount of cumulative usage.
//
// onTimeout is read from a ref so callers can pass an inline function
// without needing to memoize it — the timer itself isn't reset just
// because the callback identity changed.
export function useInactivityLogout(timeoutMs, onTimeout) {
  const timerRef = useRef(null);
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  useEffect(() => {
    function resetTimer() {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => onTimeoutRef.current(), timeoutMs);
    }

    const activityEvents = ["mousemove", "mousedown", "keydown", "touchstart", "scroll"];
    activityEvents.forEach(evt => window.addEventListener(evt, resetTimer));
    resetTimer();

    return () => {
      clearTimeout(timerRef.current);
      activityEvents.forEach(evt => window.removeEventListener(evt, resetTimer));
    };
  }, [timeoutMs]);
}
