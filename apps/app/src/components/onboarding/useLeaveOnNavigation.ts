import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";

export function useLeaveOnNavigation(onLeave: () => void) {
  const location = useLocation();
  const [initialPathname] = useState(location.pathname);
  const navigatedAway = location.pathname !== initialPathname;
  useEffect(() => {
    if (navigatedAway) onLeave();
  }, [navigatedAway, onLeave]);
}
