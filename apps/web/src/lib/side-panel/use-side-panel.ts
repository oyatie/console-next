// SPDX-License-Identifier: LicenseRef-Proprietary
import { useLocation, useNavigate, useRouter, useSearch } from "@tanstack/react-router";

declare module "@tanstack/history" {
  interface HistoryState { sidePanelOrigin?: string }
}

/** The route validates `param` (default `sel`) as an optional string. Opening adds a history entry; Back closes before leaving. */
export function useSidePanel(param = "sel") {
  const selected = useSearch({
    strict: false,
    select: search => {
      const value = (search as Record<string, unknown>)[param];
      return typeof value === "string" && value ? value : undefined;
    },
  });
  const navigate = useNavigate();
  const location = useLocation();
  const router = useRouter();
  return {
    selected,
    select: (id: string) => void navigate({ to: ".", search: previous => ({ ...previous, [param]: id }), replace: Boolean(selected),
      state: previous => ({ ...previous, sidePanelOrigin: selected ? previous.sidePanelOrigin : location.href }) }),
    close: () => {
      const list = new URL(location.href, window.location.origin);
      list.searchParams.delete(param);
      const origin = location.state.sidePanelOrigin ? new URL(location.state.sidePanelOrigin, window.location.origin) : null;
      list.searchParams.sort();
      origin?.searchParams.sort();
      // Only unwind an entry we pushed, and only when doing so preserves the current list filters.
      if (origin && origin.href === list.href) router.history.back();
      else void navigate({ to: ".", search: previous => ({ ...previous, [param]: undefined }), replace: true });
    },
  };
}
