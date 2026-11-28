// SPDX-License-Identifier: LicenseRef-Proprietary
import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { isRefusalError, teamLeaveQueueQuery } from "../api";

export function useTeamLeaves(enabled: boolean) {
  const queue = useInfiniteQuery({ ...teamLeaveQueueQuery, enabled, retry: false });
  const refused = isRefusalError(queue.error);
  const pendingLeaves = useMemo(() => enabled && !refused ? queue.data?.pages.flatMap(page => page.items) ?? [] : [], [enabled, refused, queue.data]);
  let moreLeaves = null;
  if (enabled && !refused && (queue.hasNextPage || queue.isError)) {
    const load = () => queue.hasNextPage && !queue.isRefetchError ? queue.fetchNextPage() : queue.refetch();
    moreLeaves = <Button size="sm" disabled={queue.isFetching} onClick={() => void load()}>
      {t(queue.isError ? "team.leave.retry" : "team.leave.more")}
    </Button>;
  }
  return {
    pendingLeaves,
    moreLeaves,
    complete: Boolean(queue.data && !queue.hasNextPage && !queue.isError),
    available: Boolean(enabled && !refused && queue.data),
  };
}
