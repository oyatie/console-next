// SPDX-License-Identifier: LicenseRef-Proprietary
import { useLocation, useNavigate, useRouter, useSearch } from "@tanstack/react-router";

declare module "@tanstack/history" {
  interface HistoryState { sidePanelOrigin?: string }
}

/** The route validates `sel` as an optional string. Opening adds a history entry; Back closes before leaving. */
export function useSidePanel() {
  const selected = useSearch({ strict: false, select: search => typeof search.sel === "string" && search.sel ? search.sel : undefined });
  const navigate = useNavigate();
  const location = useLocation();
  const router = useRouter();
  return {
    selected,
    select: (id: string) => void navigate({ to: ".", search: previous => ({ ...previous, sel: id }), replace: Boolean(selected),
      state: previous => ({ ...previous, sidePanelOrigin: selected ? previous.sidePanelOrigin : location.href }) }),
    close: () => {
      const list = new URL(location.href, window.location.origin);
      list.searchParams.delete("sel");
      const origin = location.state.sidePanelOrigin ? new URL(location.state.sidePanelOrigin, window.location.origin) : null;
      list.searchParams.sort();
      origin?.searchParams.sort();
      // Only unwind an entry we pushed, and only when doing so preserves the current list filters.
      if (origin && origin.href === list.href) router.history.back();
      else void navigate({ to: ".", search: previous => ({ ...previous, sel: undefined }), replace: true });
    },
  };
}
