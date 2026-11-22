import { useEffect, useRef, useState } from "react";

/**
 * Delay surfacing transient loading UI so fast local operations never flash,
 * while slow network requests show steady feedback for at least `minimum` ms.
 */
export function useDelayedFlag(active: boolean, delay = 180, minimum = 280): boolean {
  const [visible, setVisible] = useState(false);
  const shownAt = useRef(0);

  useEffect(() => {
    let timer: number | undefined;
    if (active && !visible) {
      timer = window.setTimeout(() => {
        shownAt.current = Date.now();
        setVisible(true);
      }, delay);
    } else if (!active && visible) {
      const remaining = Math.max(0, minimum - (Date.now() - shownAt.current));
      if (remaining === 0) setVisible(false);
      else timer = window.setTimeout(() => setVisible(false), remaining);
    }
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [active, visible, delay, minimum]);

  return visible;
}
