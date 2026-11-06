import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import classes from "./StickyTableScrollArea.module.css";

/** A horizontal scroll control that remains reachable while tall tables scroll. */
export function StickyTableScrollArea({ children }: { children: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const scrollbar = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, overflowing: false });

  useLayoutEffect(() => {
    const measure = () => {
      const view = viewport.current;
      if (!view) return;
      const width = view.scrollWidth;
      const overflowing = width > view.clientWidth + 1;
      setSize(current => current.width === width && current.overflowing === overflowing
        ? current : { width, overflowing });
    };
    const observer = new ResizeObserver(measure);
    if (viewport.current) observer.observe(viewport.current);
    if (content.current) observer.observe(content.current);
    measure();
    return () => observer.disconnect();
  }, []);

  return <>
    <div ref={viewport} className={classes.viewport} style={{ paddingBottom: size.overflowing ? 32 : 0 }} onScroll={() => {
      if (scrollbar.current && viewport.current) scrollbar.current.scrollLeft = viewport.current.scrollLeft;
    }}>
      <div ref={content} className={classes.content}>{children}</div>
    </div>
    {size.overflowing && <div className={classes.dock}>
      <div className={classes.fade} />
      <div ref={scrollbar} className={classes.scrollbar} role="region"
        aria-label="Scroll cell table horizontally" tabIndex={0}
        onScroll={() => {
          if (viewport.current && scrollbar.current) viewport.current.scrollLeft = scrollbar.current.scrollLeft;
        }}>
        <div style={{ width: size.width, height: 1 }} />
      </div>
    </div>}
  </>;
}
