// SPDX-License-Identifier: LicenseRef-Proprietary
import { useNavigate, useRouter, useRouterState, type AnyRouter } from "@tanstack/react-router";

/** One module's ?tab= state; PageTabs handles unknown or no-longer-available selections. */
export function useTabSearch(items: readonly { id: string; search?: Record<string, unknown> }[]) {
  const tab = useRouterState({ select: state => state.location.search.tab });
  const navigate = useNavigate();
  const router = useRouter();
  const search = (previous: Record<string, unknown>, id: string) => ({ ...previous, ...items.find(item => item.id === id)?.search, tab: id === items[0]?.id ? undefined : id });
  return {
    selected: typeof tab === "string" ? tab : "",
    href: (id: string) => router.buildLocation<AnyRouter, string>({ search: (previous: Record<string, unknown>) => search(previous, id), hash: true }).href,
    onSelect: (id: string) => void navigate<AnyRouter, string>({
      search: (previous: Record<string, unknown>) => search(previous, id),
      replace: true,
      hash: true,
      hashScrollIntoView: false,
      resetScroll: false,
    }),
  };
}
