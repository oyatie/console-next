// SPDX-License-Identifier: LicenseRef-Proprietary
import { useLayoutEffect, type RefObject } from "react";
import s from "./status-dock.module.css";

let host: HTMLDivElement | null = null;
let users = 0;
const bars = new Set<HTMLElement>();
let observer: ResizeObserver | undefined;

function reserveSpace() {
  if (host) document.documentElement.style.setProperty("--status-dock-space", `${innerHeight - host.getBoundingClientRect().top}px`);
}

function clearActions() {
  const clearance = Math.max(0, ...Array.from(bars, bar => {
    const rect = bar.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < innerHeight ? innerHeight - rect.top : 0;
  }));
  host?.style.setProperty("--dock-clearance", `${clearance}px`);
  reserveSpace();
}

export function mountDock(target: HTMLDivElement) {
  if (!host) {
    host = document.createElement("div");
    host.className = s.dock!;
    host.dataset.statusDock = "";
    document.body.append(host);
    observer = new ResizeObserver(reserveSpace);
    observer.observe(host);
    window.addEventListener("resize", clearActions);
    document.addEventListener("scroll", clearActions, true);
    clearActions();
  }
  users++;
  host.append(target);
  return () => {
    target.remove();
    if (--users) return;
    host?.remove();
    host = null;
    observer?.disconnect();
    observer = undefined;
    document.documentElement.style.removeProperty("--status-dock-space");
    window.removeEventListener("resize", clearActions);
    document.removeEventListener("scroll", clearActions, true);
  };
}

/** Reserve the visible part of sticky actions, including wrapped phone layouts. */
export function useDockClearance(ref: RefObject<HTMLElement | null>, sticky?: boolean) {
  useLayoutEffect(() => {
    const bar = ref.current;
    if (!sticky || !bar) return;
    bars.add(bar);
    const observer = new ResizeObserver(clearActions);
    observer.observe(bar);
    clearActions();
    return () => { observer.disconnect(); bars.delete(bar); clearActions(); };
  }, [ref, sticky]);
}
