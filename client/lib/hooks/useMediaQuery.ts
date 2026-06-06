"use client";

import { useEffect, useState } from "react";

/**
 * Subscribe to a CSS media query.
 *
 * Returns `false` during SSR and the first client render (so server and client
 * markup match and React doesn't warn about hydration mismatches), then updates
 * to the real value after mount. Because of that initial `false`, only use this
 * for behaviour that is allowed to settle post-mount (e.g. choosing a dialog's
 * presentation). For first-paint-critical layout, prefer Tailwind `lg:` classes
 * which the browser resolves before paint.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/** Tailwind `lg` breakpoint and up — where the desktop trade grid takes over. */
export function useIsDesktop(): boolean {
  return useMediaQuery("(min-width: 1024px)");
}

/** Tailwind `sm` and below — phones. Drives bottom-sheet style dialogs. */
export function useIsMobile(): boolean {
  return useMediaQuery("(max-width: 639px)");
}
