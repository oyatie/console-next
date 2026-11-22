// SPDX-License-Identifier: LicenseRef-Proprietary
import { useSyncExternalStore } from "react";

const DESKTOP_MEDIA = "(min-width: 768px)";

function subscribeDesktop(onChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia(DESKTOP_MEDIA);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

const getDesktopSnapshot = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(DESKTOP_MEDIA).matches : true;

const getDesktopServerSnapshot = () => false;

export function useApprovalsDesktop() {
  return useSyncExternalStore(subscribeDesktop, getDesktopSnapshot, getDesktopServerSnapshot);
}
