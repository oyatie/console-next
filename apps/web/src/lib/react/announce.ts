import { useEffect } from "react";
import { t } from "@console/i18n";
import { useLocation, useRouter } from "@tanstack/react-router";

let say: ((message: string) => void) | null = null;

/** Speaks a confirmation through the shell's single polite live region (ui/announcer.tsx). */
export const announce = (message: string) => say?.(message);

/** The shell's <Announcer> hands its setter here; the returned function unbinds it. */
export const bindAnnouncer = (fn: (message: string) => void) => {
  say = fn;
  return () => {
    if (say === fn) say = null;
  };
};

/** Keeps an announced message only on the route pathname where it was issued; navigating to another pathname clears it. */
export const announcementForPathname = (entry: { text: string; pathname: string } | null, pathname: string) =>
  entry?.pathname === pathname ? entry.text : "";

/** Reads the rendered route pathname and the router instance for scoping live-region announcements. */
export const useAnnouncerRoute = () => ({
  pathname: useLocation({ select: (l) => l.pathname }),
  router: useRouter(),
});

/** Frames to wait for a closing dialog before giving up (about a second): never focus behind an open modal. */
const MAX_FRAMES = 60;

/** An open dialog that does not hold the target: when it unmounts, React Aria restores focus to its trigger. */
const dialogOutside = (el: HTMLElement | null) =>
  Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).some((d) => !el || !d.contains(el));

/**
 * Moves focus to a stable landmark (a heading with tabIndex -1) after a command changed the page
 * under the user: the control they used, or the dialog trigger React Aria restores to, may be gone.
 * The first id present in the page wins. It waits until no dialog outside the target is mounted, then
 * one more frame, because React Aria restores focus to the trigger in the frame after the dialog
 * unmounts; focusing earlier loses that race (the unmount can land after any fixed frame count).
 * With no dialog this is two frames, as before. A target not in the page yet is waited for, up to MAX_FRAMES.
 * The user's next key or pointer action cancels a pending restore: it must not steal their new focus.
 */
const focusWhen = (allowed: () => boolean, ...ids: string[]) => {
  let quiet = 0;
  let frames = 0;
  let cancelled = false;
  const stop = () => {
    cancelled = true;
    document.removeEventListener("pointerdown", stop, true);
    document.removeEventListener("keydown", stop, true);
  };
  document.addEventListener("pointerdown", stop, true);
  document.addEventListener("keydown", stop, true);
  const tick = () => {
    if (cancelled) return;
    const el = ids.map((id) => document.getElementById(id)).find((e) => e !== null) ?? null;
    quiet = dialogOutside(el) ? 0 : quiet + 1;
    // Nothing to focus yet (the view that holds it is still rendering, e.g. a tab a navigation is opening): keep waiting.
    if (quiet >= 2 && el) {
      stop();
      if (allowed()) el.focus();
      return;
    }
    if (++frames < MAX_FRAMES) requestAnimationFrame(tick);
    else stop();
  };
  requestAnimationFrame(tick);
  return stop;
};

export const focusSoon = (...ids: string[]) => focusWhen(() => true, ...ids);

// The router remounts on locale changes; that must update the title without taking focus from the language picker.
let presented: { pathname: string; title: string } | undefined;
let focusedPath: string | undefined;

/** The rendered heading and identity own the tab title; search-state changes keep the user's current focus. */
export function useRoutePresentation(pathname: string, ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    let frame = 0;
    let cancelFocus: (() => void) | undefined;
    let interacted = false;
    const stopFocus = () => { interacted = true; cancelFocus?.(); };
    const update = () => {
      const heading = document.querySelector<HTMLElement>("main h1, h1") ?? document.querySelector<HTMLElement>("main .state__title");
      const page = heading?.textContent?.trim();
      if (!heading || !page) return;
      if (focusedPath !== pathname) {
        focusedPath = pathname;
        if (!interacted && !document.activeElement?.closest("[data-side-panel]")) {
          heading.id ||= "route-heading";
          heading.tabIndex = -1;
          cancelFocus = focusWhen(() => !document.activeElement?.closest("main"), heading.id);
        }
      }
      const scope = document.querySelector<HTMLElement>("[data-console-scope]")?.dataset.consoleScope;
      if (scope === "") return;
      const title = [page, scope, t("app.title.brand")].filter(Boolean).join(" · ");
      document.title = title;
      if (presented?.pathname !== pathname || presented.title !== title) {
        presented = { pathname, title };
        announce(title);
      }
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-console-scope"] });
    document.addEventListener("pointerdown", stopFocus, true);
    document.addEventListener("keydown", stopFocus, true);
    schedule();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      cancelFocus?.();
      document.removeEventListener("pointerdown", stopFocus, true);
      document.removeEventListener("keydown", stopFocus, true);
    };
  }, [pathname, ready]);
}
