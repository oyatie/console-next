// SPDX-License-Identifier: LicenseRef-Proprietary
import { useNavigate, useRouterState, type AnyRouter } from "@tanstack/react-router";

/** One module's ?tab= state; Tabs handles unknown or no-longer-available selections. */
export function useTabSearch(items: readonly { id: string }[]) {
  const tab = useRouterState({ select: state => state.location.search.tab });
  const navigate = useNavigate();
  return {
    selected: typeof tab === "string" ? tab : "",
    onSelect: (id: string) => void navigate<AnyRouter, string>({
      search: (previous: Record<string, unknown>) => ({ ...previous, tab: id === items[0]?.id ? undefined : id }),
      hash: true,
      resetScroll: false,
    }),
  };
}
